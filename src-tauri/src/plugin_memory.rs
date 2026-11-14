//! Host-owned, low priority extraction. No transcript or credential is returned.
pub(crate) mod automation;
pub(crate) mod gate;
pub(crate) mod protocol;
pub(crate) mod review;
mod source;

use crate::engine::agy_vertex::memory;
use protocol::*;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::{State, WebviewWindow};

pub(crate) use gate::{cancel_all, foreground};
fn permission(plugin: &str, source: Option<&SourceKind>) -> Result<(), String> {
    let (enabled, grants) =
        crate::plugins::plugin_enabled_permissions(plugin).map_err(|_| "plugin_unavailable")?;
    check_permission(enabled, &grants, source)
}
fn check_permission(
    enabled: bool,
    grants: &[String],
    source: Option<&SourceKind>,
) -> Result<(), String> {
    if !enabled
        || !grants.iter().any(|s| s == "host:memory")
        || source.is_some_and(|kind| {
            !grants.iter().any(|grant| {
                grant
                    == match kind {
                        SourceKind::Conversation => "host:chat",
                        SourceKind::Coordination => "host:tasks",
                    }
            })
        })
    {
        return Err("memory_permission_required".into());
    }
    Ok(())
}
fn require(window: &str, plugin: &str, source: Option<&SourceKind>) -> Result<(), String> {
    if window != "main" {
        return Err("main_owner_window_required".into());
    }
    permission(plugin, source)
}
fn disposition(status: &str, reason: &str, retry: u64) -> Value {
    json!({"status":status,"reason":reason,"retryAfterMs":retry})
}
fn interrupted(lease: &gate::Lease) -> Value {
    disposition(
        "deferred",
        if lease.sent() {
            "request_outcome_unknown"
        } else {
            "preempted"
        },
        30_000,
    )
}
/// No cache branch enters model admission. Missing legacy proof is unknown,
/// while a preempted proof read is explicitly pending, never proof of no send.
async fn replay_cached<F: std::future::Future<Output = Result<(), String>>>(
    cached: automation::Cached,
    validate: impl FnOnce(Value) -> F,
) -> Value {
    if !matches!(
        cached.result["status"].as_str(),
        Some("completed" | "empty")
    ) {
        return cached.result;
    }
    let Some(snapshot) = cached.replay else {
        return automation::response("request_outcome_unknown", 60_000);
    };
    match validate(snapshot).await {
        Ok(()) => cached.result,
        Err(reason)
            if matches!(
                reason.as_str(),
                "preempted" | "cache_validation_pending" | "memory_source_task_failed"
            ) =>
        {
            automation::response("cache_validation_pending", 30_000)
        }
        Err(reason)
            if matches!(
                reason.as_str(),
                "source_storage_unavailable"
                    | "native_history_unavailable"
                    | "session_metadata_unavailable"
                    | "history_page_bound_exceeded"
            ) =>
        {
            automation::response("request_outcome_unknown", 60_000)
        }
        Err(_) => automation::response("cached_source_changed", 0),
    }
}
async fn validate_cache_read(
    state: &crate::AppState,
    validate: impl FnOnce(u64) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let epoch = gate::GATE
        .read_epoch(
            || state.processes.active_run_count() > 0,
            crate::worker_host::paused(),
        )
        .map_err(|_| "cache_validation_pending".to_string())?;
    let task = tauri::async_runtime::spawn_blocking(move || validate(epoch));
    match cancellable_read(&gate::GATE, epoch, &state.processes, task).await {
        Ok(Ok(result)) => result,
        _ => Err("cache_validation_pending".into()),
    }
}
#[derive(serde::Serialize, serde::Deserialize)]
struct ExtractReplay {
    source_digest: String,
    range: source::ReplayRange,
}
fn validate_extract_replay(
    db: &crate::db::Db,
    plugin: &str,
    request: &ExtractRequest,
    snapshot: Value,
    epoch: u64,
) -> Result<(), String> {
    permission(plugin, Some(&request.source.kind))?;
    let replay = decode_extract_replay(request, snapshot)?;
    for _ in 0..2 {
        source::verify_replay_range(
            db,
            plugin,
            &request.project_id,
            &request.source,
            &replay.range,
            &gate::GATE,
            epoch,
        )?;
    }
    permission(plugin, Some(&request.source.kind))
}
fn decode_extract_replay(
    request: &ExtractRequest,
    snapshot: Value,
) -> Result<ExtractReplay, String> {
    let replay: ExtractReplay =
        serde_json::from_value(snapshot).map_err(|_| "cached_source_changed")?;
    if replay.range.from != request.cursor
        || request
            .expected_source_digest
            .as_ref()
            .is_some_and(|expected| !expected.eq_ignore_ascii_case(&replay.source_digest))
    {
        return Err("cached_source_changed".into());
    }
    Ok(replay)
}
fn source_error(reason: &str) -> Value {
    if reason == "preempted" {
        disposition("deferred", reason, 30_000)
    } else if reason == "source_changed" {
        disposition("deferred", reason, 60_000)
    } else if matches!(
        reason,
        "source_storage_unavailable"
            | "native_history_unavailable"
            | "session_metadata_unavailable"
            | "history_page_bound_exceeded"
            | "memory_permission_required"
            | "plugin_unavailable"
            | "native_header_unsupported"
    ) {
        disposition("unavailable", reason, 60_000)
    } else {
        disposition("invalid_source", reason, 60_000)
    }
}
fn extract_source_error(reason: &str, request: &ExtractRequest) -> Value {
    if request.expected_source_digest.is_some()
        && matches!(
            reason,
            "cursor_history_changed"
                | "cursor_identity_changed"
                | "cursor_missing"
                | "source_identity_mismatch"
                | "native_header_identity_mismatch"
                | "source_project_mismatch"
                | "native_session_identity_unproven"
        )
    {
        disposition("deferred", "source_changed", 60_000)
    } else {
        source_error(reason)
    }
}

#[tauri::command]
pub(crate) async fn plugin_memory_status(
    window: WebviewWindow,
    state: State<'_, crate::AppState>,
    plugin_id: String,
) -> Result<Value, String> {
    require(window.label(), &plugin_id, None)?;
    let delay = gate::GATE.status(
        || state.processes.active_run_count() > 0,
        crate::worker_host::paused(),
    );
    let configured = tauri::async_runtime::spawn_blocking(memory::configured_fingerprint)
        .await
        .unwrap_or(None);
    let provider_available = configured.is_some();
    let automation_ready = automation::ready(&state.db).is_ok();
    let available = provider_available && automation_ready;
    let mut status = json!({"available":available,"busy":delay>0,"retryAfterMs":if available {delay} else {60_000}});
    if automation_ready {
        status["automationVersion"] = 1.into();
        // Receipt reads do not consume model quota. They may proceed while the
        // paid-call budget/circuit waits, but still respect metadata read gates.
        status["canReconcile"] = gate::GATE
            .read_epoch(
                || state.processes.active_run_count() > 0,
                crate::worker_host::paused(),
            )
            .is_ok()
            .into();
    }
    if !automation_ready {
        status["reason"] = "automation_storage_unavailable".into();
    } else if !available {
        status["reason"] = "vertex_unavailable".into();
    } else if let Some((can_recover, reason, retry)) = automation::scheduler_wait(
        &state.db,
        configured.as_deref().unwrap_or_default(),
        automation::now(),
    )? {
        status["available"] = can_recover.into();
        status["busy"] = true.into();
        status["reason"] = reason.into();
        status["retryAfterMs"] = retry.max(delay).min(86_400_000).into();
    } else if delay > 0 {
        status["reason"] = "foreground_or_cooldown".into();
    }
    Ok(status)
}

#[tauri::command]
pub(crate) async fn plugin_memory_checkpoint(
    window: WebviewWindow,
    state: State<'_, crate::AppState>,
    plugin_id: String,
    request: CheckpointRequest,
) -> Result<Value, String> {
    require(window.label(), &plugin_id, Some(&request.source.kind))?;
    let Ok(epoch) = gate::GATE.read_epoch(
        || state.processes.active_run_count() > 0,
        crate::worker_host::paused(),
    ) else {
        return Ok(disposition("deferred", "foreground_busy", 30_000));
    };
    let db = state.db.clone();
    let gate = gate::GATE.clone();
    let owner = plugin_id.clone();
    let loaded = tauri::async_runtime::spawn_blocking(move || {
        permission(&owner, Some(&request.source.kind))?;
        source::load(
            &db,
            &owner,
            &request.project_id,
            &request.source,
            None,
            true,
            &gate,
            epoch,
        )
    })
    .await
    .map_err(|_| "memory_source_task_failed")?;
    let loaded = match loaded {
        Ok(v) => v,
        Err(e) => return Ok(source_error(&e)),
    };
    if !gate::GATE.valid(epoch)
        || state.processes.active_run_count() > 0
        || crate::worker_host::paused()
    {
        return Ok(disposition("deferred", "preempted", 30_000));
    }
    permission(&plugin_id, None)?;
    let cursor = loaded
        .rows
        .last()
        .map(|r| r.cursor(&loaded.session.session_id, 0))
        .unwrap_or(Cursor {
            session_id: loaded.session.session_id.clone(),
            seq: -1,
            offset: 0,
            row_digest: None,
        });
    Ok(json!({"status":"ready","cursor":cursor,"sessionRef":loaded.session}))
}

/// Biased cancellation covers blocking source work, HTTP headers and streaming
/// body, and the final identity recheck. Dropping the future drops reqwest I/O.
async fn cancellable<T>(
    lease: &mut gate::Lease,
    registry: &crate::engine::ProcessRegistry,
    future: impl std::future::Future<Output = T>,
) -> Result<T, ()> {
    let sent = lease.sent();
    let plugin = lease.plugin.clone();
    let sources = lease.sources.clone();
    lease
        .run(async {
            tokio::select! {
                biased;
                _ = async {
                    loop {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        if (!sent && registry.active_run_count()>0) || crate::worker_host::paused()
                            || permission(&plugin,None).is_err()
                            || sources.iter().any(|s| permission(&plugin,Some(s)).is_err()) {
                            gate::cancel_all(false); break;
                        }
                    }
                } => Err(()),
                value = future => Ok(value),
            }
        })
        .await
        .and_then(|result| result)
}
/// Both paths share durable counting, reservation and provider health. No retry
/// loop exists here: every outcome belongs to exactly one persisted identity.
async fn model_call(
    state: &crate::AppState,
    lease: &mut gate::Lease,
    identity: &automation::Identity,
    body: Value,
    revalidate: impl std::future::Future<Output = Result<(), String>>,
) -> Result<Result<String, Value>, String> {
    use automation::Health;
    use memory::CallFailure as F;
    let call = match memory::Call::new(body) {
        Ok(call) => call,
        Err(_) => {
            return Ok(Err(disposition(
                "unavailable",
                "vertex_unavailable",
                60_000,
            )))
        }
    };
    if let Some(value) = automation::claim_provider(
        &state.db,
        identity,
        &call.config_fingerprint(),
        automation::now(),
    )? {
        return Ok(Err(value));
    }
    let counted = cancellable(lease, &state.processes, call.count()).await;
    let count = match counted {
        Ok(Ok(count)) => count,
        outcome => {
            let (health, reason) = match outcome {
                Ok(Err(F::Quota(delay))) => (Health::Quota(delay), "provider_quota"),
                Ok(Err(F::Unavailable)) => (Health::Repair, "provider_requires_repair"),
                Err(()) => (Health::Neutral, "preempted"),
                _ => (Health::Failure, "token_count_failed"),
            };
            let delay = automation::health(&state.db, identity, health, automation::now())?;
            return Ok(Err(automation::response(reason, delay)));
        }
    };
    let Some(tokens) = automation::reservation(count, call.schema_bytes()) else {
        automation::health(&state.db, identity, Health::Neutral, automation::now())?;
        return Ok(Err(automation::response("request_token_limit", 0)));
    };
    match cancellable(lease, &state.processes, revalidate).await {
        Ok(Ok(())) => {}
        outcome => {
            automation::health(&state.db, identity, Health::Neutral, automation::now())?;
            return Ok(Err(match outcome {
                Ok(Err(reason)) => source_error(&reason),
                _ => automation::response("preempted", 30_000),
            }));
        }
    }
    if !automation::reserve(&state.db, identity, tokens, automation::now())? {
        automation::health(&state.db, identity, Health::Neutral, automation::now())?;
        return Ok(Err(automation::response(
            "token_budget_exhausted",
            86_400_000,
        )));
    }
    if state.processes.active_run_count() > 0
        || crate::worker_host::paused()
        || permission(&lease.plugin, None).is_err()
        || lease
            .sources
            .iter()
            .any(|s| permission(&lease.plugin, Some(s)).is_err())
        || !lease.mark_sent()
    {
        automation::health(&state.db, identity, Health::Neutral, automation::now())?;
        return Ok(Err(automation::response("preempted", 30_000)));
    }
    automation::mark_sent(&state.db, identity, automation::now())?;
    match cancellable(lease, &state.processes, call.generate()).await {
        Ok(Ok(reply)) => {
            automation::settle(&state.db, identity, reply.usage)?;
            // Only transport/protocol failures affect the global circuit.
            match reply.text {
                Ok(text) => {
                    automation::business_response_received(&state.db, identity, automation::now())?;
                    Ok(Ok(text))
                }
                Err(()) => {
                    let delay = automation::health(
                        &state.db,
                        identity,
                        Health::Failure,
                        automation::now(),
                    )?;
                    Ok(Err(disposition(
                        "unavailable",
                        "invalid_model_response",
                        delay,
                    )))
                }
            }
        }
        outcome => {
            let (health, reason, status) = match outcome {
                Ok(Err(F::Quota(delay))) => (Health::Quota(delay), "provider_quota", "deferred"),
                Ok(Err(F::Unavailable)) => {
                    (Health::Repair, "provider_requires_repair", "unavailable")
                }
                Ok(Err(F::Rejected)) => (Health::Failure, "provider_rejected", "deferred"),
                Ok(Err(F::Invalid)) => (Health::Failure, "invalid_model_response", "unavailable"),
                Err(()) => (Health::Neutral, "request_outcome_unknown", "deferred"),
                _ => (Health::Failure, "request_outcome_unknown", "deferred"),
            };
            let delay = automation::health(&state.db, identity, health, automation::now())?;
            Ok(Err(disposition(status, reason, delay)))
        }
    }
}
struct Prepared {
    loaded: source::Loaded,
    selection: Selection,
    input: Value,
    digest: String,
    source_digest: String,
}
struct Selected {
    loaded: source::Loaded,
    selection: Selection,
    source_digest: String,
}
fn select_loaded(loaded: source::Loaded, request: &PrepareRequest) -> Result<Selected, String> {
    let selection = select_after(
        &loaded.rows,
        &loaded.session.session_id,
        request.cursor.as_ref(),
        loaded.later_pages,
        loaded.floor_seq,
    )?;
    // Include the native authorization/identity fence as well as the visible
    // batch: rebinding the same text must invalidate a prepared retrieval.
    // Old-memory context and model format deliberately do not participate.
    let source_digest = digest(
        &json!({
            "projectId":request.project_id,"source":request.source,"sessionRef":loaded.session,
            "fromCursor":request.cursor,"nextCursor":selection.next,"partial":selection.partial,
            "sourceRows":selection.slices,"hasMore":selection.has_more,"sourceFence":loaded.fence
        })
        .to_string(),
    );
    Ok(Selected {
        loaded,
        selection,
        source_digest,
    })
}
fn load_selected(
    db: &crate::db::Db,
    plugin: &str,
    request: &PrepareRequest,
    gate: &Arc<gate::Gate>,
    epoch: u64,
) -> Result<Selected, String> {
    select_loaded(
        source::load(
            db,
            plugin,
            &request.project_id,
            &request.source,
            request.cursor.as_ref(),
            false,
            gate,
            epoch,
        )?,
        request,
    )
}
fn query_hint(slices: &[Slice]) -> String {
    let mut query = String::new();
    let mut remaining = 512;
    for role in ["user", "assistant"] {
        for slice in slices.iter().rev().filter(|s| s.role == role) {
            if remaining == 0 {
                return query;
            }
            if !query.is_empty() {
                query.push('\n');
                remaining -= 1;
            }
            let part: String = slice.text.chars().take(remaining).collect();
            remaining -= part.chars().count();
            query.push_str(&part);
        }
    }
    query
}
fn prepared_response(selected: &Selected, request: &PrepareRequest) -> Value {
    json!({"status":"ready","query":query_hint(&selected.selection.slices),
        "sourceDigest":selected.source_digest,"fromCursor":request.cursor,
        "nextCursor":selected.selection.next,"sessionRef":selected.loaded.session,
        "partial":selected.selection.partial,"hasMore":selected.selection.has_more})
}
// This read does not acquire a model lease or touch admission/quota/cooldown.
// A detached blocking reader still checks the same epoch at native page bounds.
async fn cancellable_read<T>(
    gate: &Arc<gate::Gate>,
    epoch: u64,
    registry: &crate::engine::ProcessRegistry,
    future: impl std::future::Future<Output = T>,
) -> Result<T, ()> {
    if !gate.valid(epoch) {
        return Err(());
    }
    tokio::select! {
        biased;
        _ = async {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                if crate::worker_host::paused() {
                    gate.cancel(None, false);
                } else if registry.active_run_count() > 0 {
                    gate.observe_foreground();
                    break;
                }
                if !gate.valid(epoch) { break; }
            }
        } => Err(()),
        value = future => {
            if gate.valid(epoch) && registry.active_run_count() == 0 && !crate::worker_host::paused() {
                Ok(value)
            } else { Err(()) }
        },
    }
}
#[tauri::command]
pub(crate) async fn plugin_memory_prepare(
    window: WebviewWindow,
    state: State<'_, crate::AppState>,
    plugin_id: String,
    request: PrepareRequest,
) -> Result<Value, String> {
    require(window.label(), &plugin_id, Some(&request.source.kind))?;
    let Ok(epoch) = gate::GATE.read_epoch(
        || state.processes.active_run_count() > 0,
        crate::worker_host::paused(),
    ) else {
        return Ok(disposition("deferred", "foreground_busy", 30_000));
    };
    let mut first: Option<Selected> = None;
    // Re-read bindings and selected slices before exposing a retrieval hint.
    for _ in 0..2 {
        let db = state.db.clone();
        let owner = plugin_id.clone();
        let req = request.clone();
        let task = tauri::async_runtime::spawn_blocking(move || {
            permission(&owner, Some(&req.source.kind))?;
            load_selected(&db, &owner, &req, &gate::GATE, epoch)
        });
        let selected = match cancellable_read(&gate::GATE, epoch, &state.processes, task).await {
            Ok(Ok(Ok(v))) => v,
            Ok(Ok(Err(e))) => return Ok(source_error(&e)),
            Ok(Err(_)) => {
                return Ok(disposition(
                    "unavailable",
                    "memory_source_task_failed",
                    60_000,
                ))
            }
            Err(()) => return Ok(disposition("deferred", "preempted", 30_000)),
        };
        if !gate::GATE.valid(epoch)
            || state.processes.active_run_count() > 0
            || crate::worker_host::paused()
        {
            return Ok(disposition("deferred", "preempted", 30_000));
        }
        if first
            .as_ref()
            .is_some_and(|old| old.source_digest != selected.source_digest)
        {
            return Ok(disposition("deferred", "source_changed", 60_000));
        }
        first = Some(selected);
    }
    permission(&plugin_id, Some(&request.source.kind))?;
    if !gate::GATE.valid(epoch) {
        return Ok(disposition("deferred", "preempted", 30_000));
    }
    Ok(prepared_response(
        &first.expect("two reads completed"),
        &request,
    ))
}
fn prepare(
    db: Arc<crate::db::Db>,
    plugin: String,
    request: ExtractRequest,
    epoch: u64,
) -> Result<Prepared, String> {
    permission(&plugin, Some(&request.source.kind))?;
    let Selected {
        loaded,
        selection,
        source_digest,
    } = load_selected(&db, &plugin, &request.source_request(), &gate::GATE, epoch)?;
    Ok(provider_input(
        Selected {
            loaded,
            selection,
            source_digest,
        },
        &request,
    ))
}
fn provider_input(selected: Selected, request: &ExtractRequest) -> Prepared {
    let Selected {
        loaded,
        selection,
        source_digest,
    } = selected;
    let mut input = json!({"projectId":request.project_id,"source":request.source,"sessionRef":loaded.session,"fromCursor":request.cursor,"nextCursor":selection.next,"partialInput":selection.partial,"sourceRows":selection.slices,"recentContext":request.context});
    if request.version() == 2 {
        input["formatVersion"] = 2.into();
    }
    let digest = digest(&input.to_string());
    Prepared {
        loaded,
        selection,
        input,
        digest,
        source_digest,
    }
}
fn source_matches(prepared: &Prepared, request: &ExtractRequest) -> bool {
    request
        .expected_source_digest
        .as_ref()
        .is_none_or(|expected| expected.eq_ignore_ascii_case(&prepared.source_digest))
}
#[tauri::command]
pub(crate) async fn plugin_memory_extract(
    window: WebviewWindow,
    state: State<'_, crate::AppState>,
    plugin_id: String,
    request: ExtractRequest,
) -> Result<Value, String> {
    require(window.label(), &plugin_id, Some(&request.source.kind))?;
    if !valid_id(&request.request_id) {
        return Ok(disposition("invalid_source", "invalid_request_id", 60_000));
    }
    if let Err(reason) = request.validate_version() {
        return Ok(source_error(&reason));
    }
    if let Err(reason) = validate_context(&request.context) {
        return Ok(source_error(&reason));
    }
    let identity = automation::Identity::new(
        &plugin_id,
        &request.project_id,
        "extract",
        &request.request_id,
        serde_json::to_value(&request).map_err(|_| "invalid_request")?,
    );
    if let Some(cached) = automation::lookup(&state.db, &identity, || {
        permission(&plugin_id, Some(&request.source.kind))?;
        source::authorize_review_project(&state.db, &plugin_id, &request.project_id)
    })? {
        let db = state.db.clone();
        let owner = plugin_id.clone();
        let req = request.clone();
        return Ok(replay_cached(cached, |snapshot| {
            validate_cache_read(&state, move |epoch| {
                validate_extract_replay(&db, &owner, &req, snapshot, epoch)
            })
        })
        .await);
    }
    if request.reconcile_only {
        return Ok(automation::response("request_not_started", 0));
    }
    let mut lease = match gate::GATE.admit(
        &plugin_id,
        &request.request_id,
        || state.processes.active_run_count() > 0,
        crate::worker_host::paused(),
    ) {
        Ok(v) => v,
        Err(ms) => return Ok(disposition("deferred", "foreground_or_cooldown", ms)),
    };
    lease.sources.push(request.source.kind.clone());
    if let Some(result) = automation::begin(&state.db, &identity)? {
        return Ok(result);
    }
    let result = extract_admitted(&state, &plugin_id, &request, &identity, &mut lease).await;
    let stored = result.as_ref().cloned().unwrap_or_else(|_| {
        if lease.sent() {
            automation::response("request_outcome_unknown", 60_000)
        } else {
            disposition("unavailable", "automation_operation_failed", 60_000)
        }
    });
    automation::complete(&state.db, &identity, &stored)?;
    if result.is_err() && lease.sent() {
        Ok(stored)
    } else {
        result
    }
}
async fn extract_admitted(
    state: &crate::AppState,
    plugin_id: &str,
    request: &ExtractRequest,
    identity: &automation::Identity,
    lease: &mut gate::Lease,
) -> Result<Value, String> {
    let epoch = lease.epoch;
    let db = state.db.clone();
    let owner = plugin_id.to_owned();
    let req = request.clone();
    let task = tauri::async_runtime::spawn_blocking(move || prepare(db, owner, req, epoch));
    let prepared = match cancellable(lease, &state.processes, task).await {
        Ok(Ok(Ok(v))) => v,
        Ok(Ok(Err(e))) => return Ok(extract_source_error(&e, &request)),
        Ok(Err(_)) => {
            return Ok(disposition(
                "unavailable",
                "memory_source_task_failed",
                60_000,
            ))
        }
        Err(()) => return Ok(disposition("deferred", "preempted", 30_000)),
    };
    if !gate::GATE.valid(epoch) {
        return Ok(disposition("deferred", "preempted", 30_000));
    }
    if !source_matches(&prepared, &request) {
        return Ok(disposition("deferred", "source_changed", 60_000));
    }
    // Empty non-fact pages can advance without a paid call, including hasMore.
    let notes = if prepared.selection.slices.is_empty() {
        Vec::new()
    } else {
        let raw = match model_call(
            state,
            lease,
            identity,
            memory::request_body(&prepared.input),
            async {
                let db = state.db.clone();
                let owner = plugin_id.to_owned();
                let req = request.clone();
                let checked =
                    tauri::async_runtime::spawn_blocking(move || prepare(db, owner, req, epoch))
                        .await
                        .map_err(|_| "memory_source_task_failed".to_string())??;
                if checked.digest != prepared.digest
                    || checked.loaded.fence != prepared.loaded.fence
                {
                    return Err("source_changed".into());
                }
                Ok(())
            },
        )
        .await?
        {
            Ok(raw) => raw,
            Err(result) => return Ok(result),
        };
        match validate_output_version(
            &raw,
            &prepared.selection.slices,
            &request.context,
            request.version(),
        ) {
            Ok(v) => v,
            Err(_) => return Ok(disposition("unavailable", "invalid_model_response", 0)),
        }
    };
    let db = state.db.clone();
    let owner = plugin_id.to_owned();
    let req = request.clone();
    let task = tauri::async_runtime::spawn_blocking(move || prepare(db, owner, req, epoch));
    let rechecked = match cancellable(lease, &state.processes, task).await {
        Ok(Ok(Ok(v))) => v,
        Ok(Ok(Err(e))) => return Ok(extract_source_error(&e, &request)),
        Ok(Err(_)) => {
            return Ok(disposition(
                "unavailable",
                "memory_source_task_failed",
                60_000,
            ))
        }
        Err(()) => return Ok(interrupted(lease)),
    };
    if !gate::GATE.valid(epoch)
        || (!lease.sent() && state.processes.active_run_count() > 0)
        || crate::worker_host::paused()
    {
        return Ok(interrupted(lease));
    }
    permission(plugin_id, Some(&request.source.kind))?;
    if prepared.loaded.fence != rechecked.loaded.fence || prepared.digest != rechecked.digest {
        return Ok(disposition(
            if request.version() == 2 {
                "deferred"
            } else {
                "invalid_source"
            },
            "source_changed",
            60_000,
        ));
    }
    gate::GATE.success();
    automation::save_replay(
        &state.db,
        identity,
        serde_json::to_value(ExtractReplay {
            source_digest: prepared.source_digest.clone(),
            range: source::replay_range(
                &prepared.loaded,
                request.cursor.as_ref(),
                &prepared.selection.next,
            )?,
        })
        .map_err(|_| "automation_storage_unavailable")?,
    )?;
    if prepared.selection.slices.is_empty() && !prepared.selection.has_more {
        return Ok(json!({"status":"empty","cursor":prepared.selection.next}));
    }
    Ok(
        json!({"status":"completed","batch":{"version":request.version(),"projectId":request.project_id,"source":request.source,"sessionRef":prepared.loaded.session,"fromCursor":request.cursor,"nextCursor":prepared.selection.next,"inputDigest":prepared.digest,"partial":prepared.selection.partial,"hasMore":prepared.selection.has_more,"model":MODEL,"notes":notes}}),
    )
}
#[tauri::command]
pub(crate) fn plugin_memory_cancel(
    window: WebviewWindow,
    plugin_id: String,
    request_id: String,
) -> Result<(), String> {
    // The exact (plugin, request) owner was fixed at admission. Revoking a plugin
    // must not prevent its cleanup from cancelling that already-owned request.
    if window.label() != "main" || !valid_id(&plugin_id) || !valid_id(&request_id) {
        return Err("invalid_cancel_owner".into());
    }
    gate::GATE.cancel(Some((&plugin_id, &request_id)), false);
    Ok(())
}

#[cfg(test)]
mod v2_tests;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn main_owner_enabled_memory_and_exact_source_grants_are_required() {
        assert!(require("plugin-window-detached", "fixture-workbench", None).is_err());
        let grants = vec!["host:memory".into(), "host:chat".into()];
        assert!(check_permission(true, &grants, Some(&SourceKind::Conversation)).is_ok());
        assert!(check_permission(true, &grants, Some(&SourceKind::Coordination)).is_err());
        assert!(check_permission(false, &grants, None).is_err());
        assert!(check_permission(true, &[], None).is_err());
        assert!(check_permission(
            true,
            &["host:memory".into()],
            Some(&SourceKind::Conversation)
        )
        .is_err());
        assert!(check_permission(true, &["host:workspace".into()], None).is_err());
    }
}
