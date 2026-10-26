//! Host-owned projection inside the existing, open Request.response JSON.
//! Canonical branch records and worker capsules retain the exact V2 shape.
//! V2 replay replaces response.branch; V2 reclamation replaces response, so
//! neither operation needs to understand this optional metadata extension.
use super::*;

pub(super) const META: &str = "$ccguiDelegation";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Projection {
    version: u32,
    request_identity: String,
    requests_digest: String,
    response_present: bool,
    pub(super) delegation: TaskDelegation,
}

pub(super) fn branch_value(branch: &LeaderBranch) -> Result<Value, String> {
    let mut value = encoded(branch)?;
    value
        .as_object_mut()
        .ok_or("Invalid branch encoding")?
        .remove("delegation");
    Ok(value)
}

fn request_identity(request: &Request) -> Result<String, String> {
    let method = match request.method.as_str() {
        "leader_spawn" => "task_spawn",
        "leader_send" => "task_send",
        method => method,
    };
    let fingerprint = match &request.arguments_fingerprint {
        Some(value) => value.clone(),
        None => arguments_fingerprint(&request.arguments)?,
    };
    arguments_fingerprint(&json!([
        key(&request.parent),
        request.request_id,
        method,
        request.branch_id,
        fingerprint
    ]))
}

pub(super) fn requests_digest<'a>(
    requests: impl Iterator<Item = &'a Request>,
) -> Result<String, String> {
    let mut identities = requests
        .map(request_identity)
        .collect::<Result<Vec<_>, _>>()?;
    identities.sort();
    arguments_fingerprint(&json!(identities))
}

fn owns(request: &Request, branch: &LeaderBranch) -> bool {
    request.branch_id == branch.id
        && request.parent.engine == branch.parent_engine
        && request.parent.session_id == branch.parent_session_id
        && same_workspace(&request.parent.workspace_path, branch.parent_workspace())
        && matches!(
            request.method.as_str(),
            "task_spawn" | "task_send" | "leader_spawn" | "leader_send"
        )
}

fn validate(request: &Request, metadata: &Projection) -> Result<(), String> {
    let d = &metadata.delegation;
    if metadata.version != 1
        || metadata.request_identity != request_identity(request)?
        || metadata.requests_digest.len() != 64
        || !metadata
            .requests_digest
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
        || d.request_id != request.request_id
        || request.state == "reclaimed"
        || !matches!(
            request.method.as_str(),
            "task_spawn" | "task_send" | "leader_spawn" | "leader_send"
        )
        || !matches!(
            d.state.as_str(),
            "starting"
                | "running"
                | "waiting"
                | "awaiting_cost_approval"
                | "completed"
                | "failed"
                | "stopped"
                | "unknown"
                | "reclaiming"
        )
        || d.task.chars().count() > MAX_INPUT_CHARS
        || d.result.chars().count() > MAX_RESULT_CHARS
        || d.error
            .as_ref()
            .is_some_and(|error| error.chars().count() > MAX_INPUT_CHARS)
        || d.created_at < 0
        || d.updated_at < d.created_at
        || d.run_id
            .as_ref()
            .is_some_and(|run| run.is_empty() || run.len() > 128 || run.contains('\0'))
        || d.cost_approval.as_ref().is_some_and(|approval| {
            approval.request_id != request.request_id
                || d.state != "awaiting_cost_approval"
                || d.run_id.is_some()
        })
    {
        return Err("Invalid host delegation receipt metadata".into());
    }
    Ok(())
}

pub(super) fn attach(
    request: &mut Request,
    delegation: &TaskDelegation,
    digest: String,
) -> Result<(), String> {
    let metadata = Projection {
        version: 1,
        request_identity: request_identity(request)?,
        requests_digest: digest,
        response_present: request.response.is_some(),
        delegation: delegation.clone(),
    };
    validate(request, &metadata)?;
    request.projection = Some(metadata);
    request.projection_invalid = false;
    Ok(())
}

/// Serialize only the established Request fields. Option<Response> remains an
/// in-memory execution/ACK decision; its disk-only wrapper explicitly conveys
/// uncertainty (or known failure) to a V2 reader and can never be a fake ACK.
pub(super) fn encode_request(request: &Request) -> Result<String, String> {
    let mut raw = encoded(request)?;
    if request.projection_invalid {
        // A damaged extension invalidates its cached branch as evidence. Do
        // not later reinterpret a manual completed branch as a legacy ACK.
        if let Some(response) = raw.get_mut("response").and_then(Value::as_object_mut) {
            response.remove("branch");
        }
    }
    if let Some(branch) = raw
        .get_mut("response")
        .and_then(|response| response.get_mut("branch"))
        .and_then(Value::as_object_mut)
    {
        branch.remove("delegation");
        branch.remove(META);
    }
    if request.state != "reclaimed" {
        if let Some(metadata) = &request.projection {
            validate(request, metadata)?;
            let mut metadata = metadata.clone();
            metadata.response_present = request.response.is_some();
            if request.response.is_none() {
                raw["response"] = json!({
                    "requestId":request.request_id,
                    "requestState":if request.state == "failed" { "failed" } else { "unknown" },
                    "error":request.error,"mayHaveStarted":true,"replayed":false,"branch":{},
                });
            }
            if !raw["response"]["branch"].is_object() {
                raw["response"]["branch"] = json!({});
            }
            raw["response"]["branch"][META] = encoded(&metadata)?;
        }
    }
    serde_json::to_string(&raw).map_err(|e| e.to_string())
}

/// Runtime Request caches predate streamed projection checkpoints. Preserve
/// valid receipt metadata when such a cache writes a later ACK or method
/// migration; only reclamation or an explicit newer projection may replace it.
pub(super) fn encode_preserving(
    conn: &rusqlite::Connection,
    request: &Request,
) -> Result<String, String> {
    let mut request = request.clone();
    if request.state != "reclaimed" && request.projection.is_none() && !request.projection_invalid {
        let previous: Option<String> = conn.query_row(
            "SELECT record_json FROM leader_requests WHERE parent_engine=?1 AND parent_session_id=?2 AND workspace_path=?3 AND request_id=?4",
            params![request.parent.engine,request.parent.session_id,request.parent.workspace_path,request.request_id], |row| row.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if let Some(previous) = previous {
            let previous = decode_request(&previous)?;
            if request_identity(&previous)? == request_identity(&request)? {
                request.projection = previous.projection;
                request.projection_invalid = previous.projection_invalid;
                if let Some(metadata) = &mut request.projection {
                    if let Some(value) = request
                        .response
                        .as_ref()
                        .and_then(|response| response.get("branch"))
                        .and_then(|branch| branch.get("delegation"))
                    {
                        if let Ok(delegation) =
                            serde_json::from_value::<TaskDelegation>(value.clone())
                        {
                            if delegation.request_id == request.request_id {
                                metadata.delegation = delegation;
                            }
                        }
                    }
                }
            }
        }
    }
    encode_request(&request)
}

pub(super) fn decode_request(raw: &str) -> Result<Request, String> {
    let mut value: Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid Leader request record: {e}"))?;
    let metadata = value
        .get_mut("response")
        .and_then(|response| response.get_mut("branch"))
        .and_then(Value::as_object_mut)
        .and_then(|branch| branch.remove(META));
    let mut request: Request =
        serde_json::from_value(value).map_err(|e| format!("invalid Leader request record: {e}"))?;
    request.projection_invalid = metadata.is_some();
    if let Some(metadata) =
        metadata.and_then(|value| serde_json::from_value::<Projection>(value).ok())
    {
        // Unknown or malformed extensions never grant execution authority. A
        // wrapper remains an explicit uncertain response when not understood.
        if validate(&request, &metadata).is_ok() {
            if !metadata.response_present {
                request.response = None;
            } else if let Some(response) = &mut request.response {
                if response.get("branch").is_some_and(Value::is_object) {
                    response["branch"]["delegation"] = encoded(&metadata.delegation)?;
                }
            }
            request.projection = Some(metadata);
            request.projection_invalid = false;
        }
    }
    Ok(request)
}

fn branch_requests(
    conn: &rusqlite::Connection,
    branch: &LeaderBranch,
) -> Result<Vec<Request>, String> {
    let mut statement = conn.prepare("SELECT record_json FROM leader_requests WHERE parent_engine=?1 AND parent_session_id=?2 AND json_extract(record_json,'$.branch_id')=?3")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(
            params![branch.parent_engine, branch.parent_session_id, branch.id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    rows.into_iter()
        .map(|raw| decode_request(&raw))
        .collect::<Result<Vec<_>, _>>()
        .map(|requests| {
            requests
                .into_iter()
                .filter(|request| owns(request, branch))
                .collect()
        })
}

/// Called in the very same SQLite transaction as the canonical branch write.
pub(super) fn persist(conn: &rusqlite::Connection, branch: &LeaderBranch) -> Result<(), String> {
    let mut requests = branch_requests(conn, branch)?;
    if branch.state == "reclaimed" {
        for request in &mut requests {
            if request.projection.take().is_some() {
                write_request(conn, request)?;
            }
        }
        return Ok(());
    }
    let Some(delegation) = &branch.delegation else {
        return Ok(());
    };
    let digest = requests_digest(requests.iter())?;
    if let Some(request) = requests
        .iter_mut()
        .find(|request| request.request_id == delegation.request_id && request.state != "reclaimed")
    {
        attach(request, delegation, digest)?;
        write_request(conn, request)?;
    }
    // Synthetic unknown projections have no genuine request to attach to.
    // They are deterministically rebuilt; never create a replayable request.
    Ok(())
}

pub(super) fn hydrate(inner: &mut Inner, now: i64) -> Result<(), String> {
    for record in inner.branches.values_mut() {
        if record.branch.state == "reclaimed" {
            record.branch.delegation = None;
            continue;
        }
        let requests: Vec<_> = inner
            .requests
            .values()
            .filter(|request| owns(request, &record.branch))
            .collect();
        let digest = requests_digest(requests.iter().copied())?;
        let metadata: Vec<_> = requests
            .iter()
            .filter_map(|request| request.projection.as_ref())
            .collect();
        if metadata.is_empty() && !requests.iter().any(|request| request.projection_invalid) {
            continue;
        }
        let current: Vec<_> = metadata
            .iter()
            .filter(|metadata| metadata.requests_digest == digest)
            .collect();
        let latest = current
            .iter()
            .map(|metadata| metadata.delegation.created_at)
            .max()
            .and_then(|at| {
                let mut latest = current
                    .iter()
                    .filter(|metadata| metadata.delegation.created_at == at);
                let first = latest.next()?;
                latest.next().is_none().then_some(first.delegation.clone())
            });
        record.branch.delegation = Some(latest.unwrap_or_else(|| {
            let request_id = (requests.len() == 1).then(|| requests[0].request_id.as_str());
            delegation::unknown_projection(&record.branch, request_id, now)
        }));
        record.dirty = true;
    }
    Ok(())
}

pub(super) fn digest_for_branch(inner: &Inner, branch: &LeaderBranch) -> Result<String, String> {
    requests_digest(
        inner
            .requests
            .values()
            .filter(|request| owns(request, branch)),
    )
}

pub(super) fn request_proves_run(request: &Request, branch: &LeaderBranch, run_id: &str) -> bool {
    if !owns(request, branch) || request.state == "reclaimed" {
        return false;
    }
    request
        .projection
        .as_ref()
        .is_some_and(|metadata| metadata.delegation.run_id.as_deref() == Some(run_id))
        || request
            .response
            .as_ref()
            .and_then(|response| response.get("branch"))
            .is_some_and(|saved| {
                saved["id"].as_str() == Some(branch.id.as_str())
                    && saved["engine"].as_str() == Some(branch.engine.as_str())
                    && saved["runId"].as_str() == Some(run_id)
            })
}
