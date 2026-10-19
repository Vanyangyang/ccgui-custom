//! Session handoff distillation (isolated engine side-calls)
//! and CCGUI local cache inspection & pruning (`runtime-updates`, `backups`,
//! `pasted-images`, host staging, and SQLite WAL checkpointing).

use crate::engine::side_call::{self, SideCallError};
use crate::live_update::{Limits, TransactionPhase, UpdateStore};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const HANDOFF_MODEL: &str = "grok-4.7-low-fast";
const HANDOFF_FALLBACK_MODEL: &str = "grok-4.7-low";
// This covers CLI startup and shutdown as well as inference. On Windows a
// successful short summary can already take ~25s with only ~7s spent on the API.
const HANDOFF_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_EXCERPT_CHARS: usize = 6000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffCompressionSelection {
    engine: String,
    model: String,
    provider_id: Option<String>,
    effort: Option<String>,
}

impl HandoffCompressionSelection {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.engine.as_str(), "claude" | "codex" | "pi" | "cursor") {
            return Err("unsupported handoff compression engine".into());
        }
        // Native model IDs include provider/model and Claude's [1m] suffix.
        // Keep the selector verbatim; never normalize it to a different model.
        let valid_selector = |value: &str| {
            !value.is_empty() && value.len() <= 512 && !value.starts_with('-')
                && !value.chars().any(|c| c.is_control() || c.is_whitespace())
        };
        if !valid_selector(&self.model) {
            return Err("invalid handoff compression model".into());
        }
        if self.provider_id.as_deref().is_some_and(|id| {
            id.is_empty() || id.len() > 512 || id.trim() != id || id.chars().any(char::is_control)
        }) {
            return Err("invalid handoff compression provider".into());
        }
        if self.engine == "cursor" && self.provider_id.as_deref().is_some_and(|id| {
            id != crate::config::LOCAL_PROVIDER_ID && id != crate::config::LEGACY_LOCAL_CONFIG_TOML_ID
        }) {
            return Err("Cursor handoff does not support custom providers".into());
        }
        if self.effort.as_deref().is_some_and(|effort| !matches!(effort,
            "none" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra")) {
            return Err("invalid handoff compression effort".into());
        }
        Ok(())
    }

    fn structured_call<'a>(&'a self, input: &'a str, schema: &'a serde_json::Value) -> side_call::StructuredCall<'a> {
        side_call::StructuredCall {
            system_prompt: "Return a JSON object with the handoff Markdown in its summary field.",
            input,
            json_schema: schema,
            model: &self.model,
            provider_id: Some(self.provider_id.as_deref().unwrap_or(crate::config::LOCAL_PROVIDER_ID)),
            effort: self.effort.as_deref().unwrap_or("low"),
            timeout: HANDOFF_TIMEOUT,
        }
    }
}

#[derive(Debug)]
enum HandoffRoute<'a> {
    Explicit(&'a HandoffCompressionSelection),
    Legacy(HandoffModels<'a>),
}

fn handoff_route<'a>(selection: Option<&'a HandoffCompressionSelection>, legacy: Option<&'a str>)
    -> Result<HandoffRoute<'a>, String>
{
    match selection {
        Some(selection) => {
            selection.validate()?;
            Ok(HandoffRoute::Explicit(selection))
        }
        None => Ok(HandoffRoute::Legacy(handoff_models(legacy)?)),
    }
}

async fn run_handoff_route(route: HandoffRoute<'_>, input: &str) -> Result<String, SideCallError> {
    match route {
        HandoffRoute::Explicit(selection) if selection.engine == "cursor" => {
            crate::config::ensure_engine_enabled("cursor").map_err(|_| SideCallError::Unavailable)?;
            side_call::cursor_text_call(&selection.model, input, HANDOFF_TIMEOUT).await
        }
        HandoffRoute::Explicit(selection) => {
            let schema = serde_json::json!({
                "type": "object", "properties": {"summary": {"type": "string"}},
                "required": ["summary"], "additionalProperties": false
            });
            let output = side_call::structured(&selection.engine, selection.structured_call(input, &schema)).await?;
            structured_handoff_summary(&output.structured)
        }
        HandoffRoute::Legacy(models) => {
            match side_call::cursor_text_call(models.primary, input, HANDOFF_TIMEOUT).await {
                Ok(text) => Ok(text),
                Err(err) => match models.fallback_after(&err) {
                    Some(fallback) => side_call::cursor_text_call(fallback, input, HANDOFF_TIMEOUT).await,
                    None => Err(err),
                },
            }
        }
    }
}

fn structured_handoff_summary(value: &serde_json::Value) -> Result<String, SideCallError> {
    value.get("summary").and_then(serde_json::Value::as_str)
        .and_then(sanitize_distilled_summary).ok_or(SideCallError::BadOutput)
}

#[derive(Debug)]
struct HandoffModels<'a> {
    primary: &'a str,
    fallback: Option<&'a str>,
}

impl<'a> HandoffModels<'a> {
    fn fallback_after(&self, error: &SideCallError) -> Option<&'a str> {
        match error {
            SideCallError::Failed | SideCallError::BadOutput => self.fallback,
            _ => None,
        }
    }
}

fn handoff_models(compression_model: Option<&str>) -> Result<HandoffModels<'_>, String> {
    let Some(raw) = compression_model else {
        return Ok(HandoffModels {
            primary: HANDOFF_MODEL,
            fallback: Some(HANDOFF_FALLBACK_MODEL),
        });
    };
    let model = raw.trim();
    if raw.chars().any(char::is_control)
        || model.is_empty()
        || model.len() > 128
        || model.starts_with('-')
        || !model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err("invalid handoff compression model".to_string());
    }
    Ok(HandoffModels {
        primary: model,
        fallback: None,
    })
}

const HANDOFF_DISTILL_PROMPT: &str = "\
你是 CCGUI 的会话交接压缩助手。请将下方旧会话的对话轨迹浓缩成一段高密度、零废话的交接摘要，供新会话的模型直接承接上下文。

严格要求：
1. 只输出压缩后的交接正文（使用中文 Markdown 无序列表 `- `），不要任何开场白、寒暄、解释或外层代码块包裹。
2. 严禁编造任何未在轨迹中出现的文件路径、命令或结论；保留关键相对路径、符号名与核心技术决策。
3. 控制在 3～7 条精炼要点（总长不超过 450 字），按以下维度组织（无内容的维度直接省略）：
- **目标与背景**：一句话概括原会话的核心任务
- **已完成改动与结论**：已修改的关键文件、核心实现或排查结论
- **待继续事项**：尚未完成或下一步可直接衔接的事项";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppCacheSummary {
    /// Reclaimable bytes in `runtime-updates/releases` and `runtime-updates/handoffs`
    /// (excluding active, rollback previous, and pending candidate releases).
    pub runtime_updates_bytes: u64,
    pub runtime_updates_count: usize,
    /// Reclaimable bytes in `backups/` (old acceptance snapshots and aged backups).
    pub backups_bytes: u64,
    pub backups_count: usize,
    /// Reclaimable bytes in `pasted-images/` and `remote-sessions/` older than 7 days.
    pub media_and_remote_bytes: u64,
    pub media_and_remote_count: usize,
    /// Reclaimable bytes in `*-host-staging/` and ephemeral `side-call` artifacts.
    pub staging_bytes: u64,
    pub staging_count: usize,
    /// Current `app.db-wal` bytes that can be checkpointed back into `app.db`.
    pub db_wal_bytes: u64,
    /// Sum of all reclaimable bytes above.
    pub total_reclaimable_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PruneAppCacheResult {
    pub freed_bytes: u64,
    pub deleted_entries: usize,
    pub remaining: AppCacheSummary,
}

/// Build a compact fallback excerpt from a session's stored messages when the
/// caller did not supply one.
fn build_fallback_excerpt(messages: &[crate::history::Message]) -> String {
    let mut touched = Vec::new();
    let mut turns = Vec::new();
    for msg in messages {
        if msg.role == "tool" {
            if let Some(p) = msg.path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                if !touched.iter().any(|existing: &String| existing == p) && touched.len() < 10 {
                    touched.push(p.to_string());
                }
            }
            continue;
        }
        if msg.role != "user" && msg.role != "assistant" {
            continue;
        }
        let cleaned = crate::history::strip_title_noise(&msg.text);
        let trimmed = cleaned.trim();
        if trimmed.is_empty() {
            continue;
        }
        let compact: String = trimmed.chars().take(700).collect();
        turns.push((msg.role.clone(), compact));
    }
    let start = turns.len().saturating_sub(8);
    let mut out = String::new();
    if !touched.is_empty() {
        out.push_str("涉及文件：");
        out.push_str(&touched.join(", "));
        out.push_str("\n\n");
    }
    for (role, text) in &turns[start..] {
        let label = if role == "user" { "用户" } else { "AI" };
        out.push_str(&format!("[{label}]: {text}\n\n"));
    }
    out.chars().take(MAX_EXCERPT_CHARS).collect()
}

pub(crate) fn sanitize_distilled_summary(raw: &str) -> Option<String> {
    let mut text = raw.trim();
    if text.starts_with("```") {
        if let Some(first_newline) = text.find('\n') {
            text = &text[first_newline + 1..];
        }
        if let Some(end_fence) = text.rfind("```") {
            text = &text[..end_fence];
        }
    }
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .skip_while(|line| line.trim().is_empty())
        .collect();
    let joined = lines.join("\n").trim().to_string();
    if joined.chars().count() < 12 {
        return None;
    }
    Some(joined)
}

#[tauri::command]
pub async fn summarize_session_handoff(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    title: Option<String>,
    transcript_excerpt: Option<String>,
    compression_model: Option<String>,
    compression_selection: Option<HandoffCompressionSelection>,
) -> Result<String, String> {
    let route = handoff_route(compression_selection.as_ref(), compression_model.as_deref())?;
    let mut excerpt = transcript_excerpt
        .unwrap_or_default()
        .trim()
        .chars()
        .take(MAX_EXCERPT_CHARS)
        .collect::<String>();

    if excerpt.is_empty() && !engine.trim().is_empty() && !session_id.trim().is_empty() {
        let db = Arc::clone(&state.db);
        let eng = engine.clone();
        let sid = session_id.clone();
        if let Ok(Ok(page)) = tauri::async_runtime::spawn_blocking(move || {
            crate::history::reader::load_session_page_blocking(&db, &eng, &sid, Some(40), None)
        })
        .await
        {
            excerpt = build_fallback_excerpt(&page.messages);
        }
    }

    if excerpt.trim().is_empty() {
        return Err("empty session excerpt".into());
    }

    let title_line = title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|t| format!("原会话标题：{t}\n"))
        .unwrap_or_default();

    let input = format!(
        "{HANDOFF_DISTILL_PROMPT}\n\n---\n{title_line}原会话引擎与 ID：{engine}/{session_id}\n\n{excerpt}"
    );

    let selected_engine = compression_selection.as_ref().map(|s| s.engine.as_str()).unwrap_or("cursor");
    let raw = run_handoff_route(route, &input).await
    .map_err(|err| match err {
        SideCallError::Unavailable => format!("{selected_engine} handoff provider/model unavailable"),
        SideCallError::Timeout => format!("{selected_engine} handoff summary timed out"),
        SideCallError::BadOutput => format!("{selected_engine} returned invalid summary"),
        SideCallError::Failed => format!("{selected_engine} handoff summary failed"),
    })?;

    sanitize_distilled_summary(&raw).ok_or_else(|| "distilled summary too short".to_string())
}

fn dir_bytes(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        total = total.saturating_add(dir_bytes(&entry.path()));
    }
    total
}

fn is_older_than(path: &Path, max_age: Duration, now: SystemTime) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    now.duration_since(modified)
        .map(|age| age >= max_age)
        .unwrap_or(false)
}

struct ReclaimPlan {
    summary: AppCacheSummary,
    runtime_update_paths: Vec<(PathBuf, u64)>,
    backup_paths: Vec<(PathBuf, u64)>,
    media_paths: Vec<(PathBuf, u64)>,
    staging_paths: Vec<(PathBuf, u64)>,
}

fn collect_runtime_update_targets(
    app_home: &Path,
    update_in_flight: bool,
    current_exe: Option<&Path>,
    now: SystemTime,
) -> Vec<(PathBuf, u64)> {
    if update_in_flight {
        return Vec::new();
    }
    let updates_root = app_home.join("runtime-updates");
    if !updates_root.is_dir() {
        return Vec::new();
    }
    let Ok(store) = UpdateStore::open(app_home, Limits::default()) else {
        return Vec::new();
    };
    let Ok(state) = store.read_state() else {
        return Vec::new();
    };
    if state.transaction.as_ref().is_some_and(|tx| {
        matches!(
            tx.phase,
            TransactionPhase::Preparing | TransactionPhase::Ready | TransactionPhase::Activating
        )
    }) {
        return Vec::new();
    }

    let mut protected_releases = HashSet::new();
    if let Some(active) = &state.active {
        protected_releases.insert(active.manifest_sha256.clone());
    }
    if let Some(tx) = &state.transaction {
        protected_releases.insert(tx.candidate.manifest_sha256.clone());
        if let Some(prev) = &tx.previous {
            protected_releases.insert(prev.manifest_sha256.clone());
        }
    }

    let releases_dir = updates_root.join("releases");
    if let (Some(exe), Ok(canon_releases)) = (current_exe, dunce::canonicalize(&releases_dir)) {
        if let Ok(canon_exe) = dunce::canonicalize(exe) {
            if let Ok(rel) = canon_exe.strip_prefix(&canon_releases) {
                if let Some(first) = rel.components().next() {
                    protected_releases.insert(first.as_os_str().to_string_lossy().to_string());
                }
            }
        }
    }

    let mut targets = Vec::new();
    if let Ok(entries) = fs::read_dir(&releases_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if protected_releases.contains(name) {
                continue;
            }
            if name.starts_with(".staging-")
                && !is_older_than(&path, Duration::from_secs(2 * 3600), now)
            {
                continue;
            }
            let bytes = dir_bytes(&path);
            targets.push((path, bytes));
        }
    }

    let mut protected_handoffs = HashSet::new();
    if let Some(tx) = &state.transaction {
        protected_handoffs.insert(tx.id.clone());
    }
    let handoffs_dir = updates_root.join("handoffs");
    if let Ok(entries) = fs::read_dir(&handoffs_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if protected_handoffs.contains(name) {
                continue;
            }
            let bytes = dir_bytes(&path);
            targets.push((path, bytes));
        }
    }

    targets
}

fn build_reclaim_plan_in(
    app_home: &Path,
    cursor_home: &Path,
    update_in_flight: bool,
    has_active_runs: bool,
    current_exe: Option<&Path>,
    now: SystemTime,
) -> ReclaimPlan {
    let runtime_update_paths =
        collect_runtime_update_targets(app_home, update_in_flight, current_exe, now);

    // Backups: keep the 2 newest small JSON files (< 5 MB), reclaim any directory
    // backups (e.g. runtime-acceptance snapshots) or backups older than 3 days.
    let mut backup_paths = Vec::new();
    let backups_dir = app_home.join("backups");
    if let Ok(entries) = fs::read_dir(&backups_dir) {
        let mut items: Vec<(PathBuf, bool, SystemTime, u64)> = entries
            .flatten()
            .map(|e| {
                let p = e.path();
                let meta = fs::symlink_metadata(&p).ok();
                let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
                let mtime = meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                let bytes = dir_bytes(&p);
                (p, is_dir, mtime, bytes)
            })
            .collect();
        items.sort_by(|a, b| b.2.cmp(&a.2));
        let mut kept_small_files = 0usize;
        for (path, is_dir, mtime, bytes) in items {
            let age = now.duration_since(mtime).unwrap_or_default();
            if !is_dir && bytes <= 5 * 1024 * 1024 && kept_small_files < 2 && age < Duration::from_secs(14 * 86400) {
                kept_small_files += 1;
                continue;
            }
            backup_paths.push((path, bytes));
        }
    }

    // Media & remote sessions older than 7 days
    let mut media_paths = Vec::new();
    for subdir in ["pasted-images", "remote-sessions"] {
        let dir = app_home.join(subdir);
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if is_older_than(&path, Duration::from_secs(7 * 86400), now) {
                    let bytes = dir_bytes(&path);
                    media_paths.push((path, bytes));
                }
            }
        }
    }

    // Staging directories & Cursor side-call ephemeral project
    let mut staging_paths = Vec::new();
    let staging_max_age = if has_active_runs {
        Duration::from_secs(24 * 3600)
    } else {
        Duration::from_secs(2 * 3600)
    };
    for subdir in ["agy-host-staging", "claude-host-staging", "cursor-host-staging"] {
        let dir = app_home.join(subdir);
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if is_older_than(&path, staging_max_age, now) {
                    let bytes = dir_bytes(&path);
                    staging_paths.push((path, bytes));
                }
            }
        }
    }

    let side_call_ws = app_home.join("side-call");
    let raw = side_call_ws.to_string_lossy().to_string();
    let trimmed = raw.trim_end_matches(['/', '\\']).to_string();
    let mut slugs = Vec::new();
    for spelling in [&raw, &trimmed] {
        for lowercase in [true, false] {
            let slug = crate::history::discovery::cursor_encode_project_slug(spelling, lowercase);
            if !slug.is_empty() && !slugs.contains(&slug) {
                slugs.push(slug);
            }
        }
    }
    for slug in slugs {
        let proj = cursor_home.join("projects").join(slug);
        if proj.is_dir() {
            let bytes = dir_bytes(&proj);
            staging_paths.push((proj, bytes));
        }
    }

    let wal_path = app_home.join("app.db-wal");
    let raw_wal_bytes = fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
    // Only count WAL as reclaimable when it has grown past 512 KB
    let db_wal_bytes = if raw_wal_bytes > 512 * 1024 {
        raw_wal_bytes
    } else {
        0
    };

    let runtime_updates_bytes: u64 = runtime_update_paths.iter().map(|(_, b)| *b).sum();
    let backups_bytes: u64 = backup_paths.iter().map(|(_, b)| *b).sum();
    let media_and_remote_bytes: u64 = media_paths.iter().map(|(_, b)| *b).sum();
    let staging_bytes: u64 = staging_paths.iter().map(|(_, b)| *b).sum();
    let total_reclaimable_bytes = runtime_updates_bytes
        .saturating_add(backups_bytes)
        .saturating_add(media_and_remote_bytes)
        .saturating_add(staging_bytes)
        .saturating_add(db_wal_bytes);

    ReclaimPlan {
        summary: AppCacheSummary {
            runtime_updates_bytes,
            runtime_updates_count: runtime_update_paths.len(),
            backups_bytes,
            backups_count: backup_paths.len(),
            media_and_remote_bytes,
            media_and_remote_count: media_paths.len(),
            staging_bytes,
            staging_count: staging_paths.len(),
            db_wal_bytes,
            total_reclaimable_bytes,
        },
        runtime_update_paths,
        backup_paths,
        media_paths,
        staging_paths,
    }
}

fn remove_target(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if meta.is_dir() {
        fs::remove_dir_all(path).is_ok()
    } else {
        fs::remove_file(path).is_ok()
    }
}

pub(crate) fn prune_cache_in(
    app_home: &Path,
    cursor_home: &Path,
    db: Option<&crate::db::Db>,
    update_in_flight: bool,
    has_active_runs: bool,
    current_exe: Option<&Path>,
    now: SystemTime,
) -> PruneAppCacheResult {
    let plan = build_reclaim_plan_in(
        app_home,
        cursor_home,
        update_in_flight,
        has_active_runs,
        current_exe,
        now,
    );

    let mut freed_bytes = 0u64;
    let mut deleted_entries = 0usize;

    for (path, bytes) in plan
        .runtime_update_paths
        .iter()
        .chain(plan.backup_paths.iter())
        .chain(plan.media_paths.iter())
        .chain(plan.staging_paths.iter())
    {
        if remove_target(path) {
            freed_bytes = freed_bytes.saturating_add(*bytes);
            deleted_entries += 1;
        }
    }

    side_call::cleanup_cursor_side_call_workspace(cursor_home, &app_home.join("side-call"));

    if let Some(db) = db {
        let wal_path = app_home.join("app.db-wal");
        let before_wal = fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
        {
            let conn = db.0.lock();
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;");
        }
        let after_wal = fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
        if before_wal > after_wal {
            freed_bytes = freed_bytes.saturating_add(before_wal - after_wal);
        }
    }

    let remaining = build_reclaim_plan_in(
        app_home,
        cursor_home,
        update_in_flight,
        has_active_runs,
        current_exe,
        SystemTime::now(),
    )
    .summary;

    PruneAppCacheResult {
        freed_bytes,
        deleted_entries,
        remaining,
    }
}

#[tauri::command]
pub async fn inspect_app_cache(
    state: tauri::State<'_, crate::AppState>,
) -> Result<AppCacheSummary, String> {
    let update_in_flight = crate::handoff::preserving_workers() || crate::handoff::has_resume();
    let has_active_runs = state.processes.active_run_count() > 0;
    let app_home = crate::paths::app_home();
    let cursor_home = crate::engine::cursor::cursor_home();
    let current_exe = std::env::current_exe().ok();
    tauri::async_runtime::spawn_blocking(move || {
        build_reclaim_plan_in(
            &app_home,
            &cursor_home,
            update_in_flight,
            has_active_runs,
            current_exe.as_deref(),
            SystemTime::now(),
        )
        .summary
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn prune_app_cache(
    state: tauri::State<'_, crate::AppState>,
) -> Result<PruneAppCacheResult, String> {
    let update_in_flight = crate::handoff::preserving_workers() || crate::handoff::has_resume();
    let has_active_runs = state.processes.active_run_count() > 0;
    let app_home = crate::paths::app_home();
    let cursor_home = crate::engine::cursor::cursor_home();
    let current_exe = std::env::current_exe().ok();
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        prune_cache_in(
            &app_home,
            &cursor_home,
            Some(&db),
            update_in_flight,
            has_active_runs,
            current_exe.as_deref(),
            SystemTime::now(),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// Automatically sweeps unreferenced `runtime-updates/releases`, completed
/// `runtime-updates/handoffs`, and residual Cursor `side-call` transcripts
/// in the background after startup settles so disk usage stays bounded.
pub(crate) fn spawn_startup_cache_maintenance() {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        if crate::handoff::preserving_workers() || crate::handoff::has_resume() {
            return;
        }
        let app_home = crate::paths::app_home();
        let cursor_home = crate::engine::cursor::cursor_home();
        let current_exe = std::env::current_exe().ok();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let now = SystemTime::now();
            let targets =
                collect_runtime_update_targets(&app_home, false, current_exe.as_deref(), now);
            for (path, _) in targets {
                let _ = remove_target(&path);
            }
            side_call::cleanup_cursor_side_call_workspace(&cursor_home, &app_home.join("side-call"));
        })
        .await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_structured_summary_requires_valid_summary_field() {
        let summary = "- 保留原会话的目标、改动与待继续事项";
        assert_eq!(structured_handoff_summary(&serde_json::json!({"summary": format!("```markdown\n{summary}\n```") })), Ok(summary.into()));
        for value in [serde_json::json!({}), serde_json::json!({"summary": 123}),
            serde_json::json!({"summary": "短"}), serde_json::json!({"text": summary})] {
            assert_eq!(structured_handoff_summary(&value), Err(SideCallError::BadOutput));
        }
    }

    #[test]
    fn handoff_selection_routes_native_models_and_overrides_legacy() {
        for (engine, model) in [("claude", "opus[1m]"), ("codex", "gpt-5.4"),
            ("pi", "openrouter/anthropic/claude-sonnet-4.6"), ("cursor", "grok-4.7-low-fast")] {
            let selection: HandoffCompressionSelection = serde_json::from_value(serde_json::json!({
                "engine": engine, "model": model,
                "providerId": crate::config::LOCAL_PROVIDER_ID, "effort": "high"
            })).unwrap();
            let HandoffRoute::Explicit(actual) = handoff_route(Some(&selection), Some("--invalid-legacy")).unwrap() else {
                panic!("explicit route fell back to legacy");
            };
            assert_eq!(actual.engine, engine);
            assert_eq!(actual.model, model);
            assert_eq!(actual.provider_id.as_deref(), Some(crate::config::LOCAL_PROVIDER_ID));
        }
        assert!(matches!(handoff_route(None, None).unwrap(), HandoffRoute::Legacy(_)));
    }

    #[test]
    fn handoff_structured_request_pins_official_or_explicit_provider() {
        let schema = serde_json::json!({"type": "object"});
        for engine in ["claude", "codex", "pi"] {
            for provider in [None, Some("custom provider channel")] {
                let selection = HandoffCompressionSelection {
                    engine: engine.into(), model: "provider/model[1m]".into(),
                    provider_id: provider.map(str::to_owned), effort: Some("high".into()),
                };
                selection.validate().unwrap();
                let call = selection.structured_call("excerpt", &schema);
                assert_eq!(call.provider_id, Some(provider.unwrap_or(crate::config::LOCAL_PROVIDER_ID)));
                assert_eq!(call.model, "provider/model[1m]");
                assert_eq!(call.effort, "high");
                assert_eq!(call.input, "excerpt");
                assert_eq!(call.json_schema, &schema);
                assert_eq!(call.timeout, HANDOFF_TIMEOUT);
            }
        }
    }

    #[test]
    fn handoff_selection_rejects_invalid_route_without_legacy_fallback() {
        for value in [
            serde_json::json!({"engine":"unknown","model":"valid"}),
            serde_json::json!({"engine":"codex","model":""}),
            serde_json::json!({"engine":"claude","model":"--model"}),
            serde_json::json!({"engine":"pi","model":"model\n"}),
            serde_json::json!({"engine":"pi","model":"model --flag"}),
            serde_json::json!({"engine":"claude","model":"opus","providerId":""}),
            serde_json::json!({"engine":"claude","model":"opus","providerId":" leading"}),
            serde_json::json!({"engine":"claude","model":"opus","providerId":"trailing "}),
            serde_json::json!({"engine":"claude","model":"opus","providerId":"control\ncharacter"}),
            serde_json::json!({"engine":"claude","model":"opus","providerId":"a".repeat(513)}),
            serde_json::json!({"engine":"cursor","model":"valid","providerId":"custom"}),
            serde_json::json!({"engine":"codex","model":"valid","effort":"--flag"}),
        ] {
            let selection = serde_json::from_value(value).unwrap();
            assert!(handoff_route(Some(&selection), Some(HANDOFF_MODEL)).is_err());
        }
    }

    #[test]
    fn handoff_models_preserve_explicit_selection_without_fallback() {
        for model in ["claude-opus-4.6", "gemini_3.1-pro", HANDOFF_MODEL] {
            let padded = format!("  {model}  ");
            let models = handoff_models(Some(&padded)).unwrap();
            assert_eq!(models.primary, model);
            for error in [
                SideCallError::Failed,
                SideCallError::BadOutput,
                SideCallError::Timeout,
                SideCallError::Unavailable,
            ] {
                assert_eq!(models.fallback_after(&error), None);
            }
        }
        assert!(handoff_models(Some(&"a".repeat(128))).is_ok());
    }

    #[test]
    fn handoff_models_absent_retains_legacy_fallback_policy() {
        let models = handoff_models(None).unwrap();
        assert_eq!(models.primary, HANDOFF_MODEL);
        for error in [SideCallError::Failed, SideCallError::BadOutput] {
            assert_eq!(models.fallback_after(&error), Some(HANDOFF_FALLBACK_MODEL));
        }
        for error in [SideCallError::Timeout, SideCallError::Unavailable] {
            assert_eq!(models.fallback_after(&error), None);
        }
    }

    #[test]
    fn handoff_models_reject_invalid_selection() {
        for model in [
            "",
            "   ",
            "--model",
            "-x",
            "model --flag",
            "model=other",
            "model:high",
            "model/other",
            "model?x=1",
            "model%0A",
            "model\n",
            "\tmodel",
            "model\0",
            "模型",
            "model\u{200b}",
        ] {
            assert_eq!(
                handoff_models(Some(model)).unwrap_err(),
                "invalid handoff compression model",
                "accepted invalid model: {model:?}"
            );
        }
        assert!(handoff_models(Some(&"a".repeat(129))).is_err());
    }

    #[test]
    fn sanitize_distilled_summary_strips_code_fences_and_trims() {
        let fenced = "```markdown\n- **目标与背景**：实现 /handoff 指令\n- **已完成改动与结论**：修改了 cli-menu.tsx\n```";
        assert_eq!(
            sanitize_distilled_summary(fenced).as_deref(),
            Some("- **目标与背景**：实现 /handoff 指令\n- **已完成改动与结论**：修改了 cli-menu.tsx")
        );
        assert_eq!(sanitize_distilled_summary("太短"), None);
    }

    #[test]
    fn prune_cache_preserves_active_and_previous_releases_and_cleans_stale_ones() {
        let root = std::env::temp_dir().join(format!("ccgui-cache-test-{}", uuid::Uuid::new_v4()));
        let app_home = root.join("app-home");
        let cursor_home = root.join("cursor-home");
        let releases = app_home.join("runtime-updates/releases");
        let handoffs = app_home.join("runtime-updates/handoffs");
        fs::create_dir_all(&releases).unwrap();
        fs::create_dir_all(&handoffs).unwrap();
        fs::create_dir_all(&cursor_home).unwrap();

        let active_hash = "1111111111111111111111111111111111111111111111111111111111111111";
        let prev_hash = "2222222222222222222222222222222222222222222222222222222222222222";
        let stale_hash = "3333333333333333333333333333333333333333333333333333333333333333";
        let active_tx = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let stale_tx = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

        for hash in [active_hash, prev_hash, stale_hash] {
            let dir = releases.join(hash);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("payload.bin"), vec![b'x'; 4096]).unwrap();
        }
        for tx in [active_tx, stale_tx] {
            let dir = handoffs.join(tx);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("checkpoint.json"), b"{}").unwrap();
        }

        let state_json = serde_json::json!({
            "stateVersion": 1,
            "active": {
                "manifestSha256": active_hash,
                "channel": "protected-custom",
                "releaseId": "r-active",
                "version": "1.0.0",
                "workerProtocol": 1,
                "checkpointSchema": 1,
                "schemaHash": active_hash,
                "executable": "ccgui-next.exe"
            },
            "transaction": {
                "id": active_tx,
                "phase": "Committed",
                "candidate": {
                    "manifestSha256": active_hash,
                    "channel": "protected-custom",
                    "releaseId": "r-active",
                    "version": "1.0.0",
                    "workerProtocol": 1,
                    "checkpointSchema": 1,
                    "schemaHash": active_hash,
                    "executable": "ccgui-next.exe"
                },
                "previous": {
                    "manifestSha256": prev_hash,
                    "channel": "protected-custom",
                    "releaseId": "r-prev",
                    "version": "1.0.0",
                    "workerProtocol": 1,
                    "checkpointSchema": 1,
                    "schemaHash": active_hash,
                    "executable": "ccgui-next.exe"
                },
                "failureReason": null
            }
        });
        fs::write(
            app_home.join("runtime-updates/state.json"),
            serde_json::to_vec(&state_json).unwrap(),
        )
        .unwrap();

        // Also create a directory backup in backups/
        let old_backup_dir = app_home.join("backups/runtime-acceptance-old");
        fs::create_dir_all(&old_backup_dir).unwrap();
        fs::write(old_backup_dir.join("dump.bin"), vec![b'y'; 2048]).unwrap();

        let summary_before = build_reclaim_plan_in(
            &app_home,
            &cursor_home,
            false,
            false,
            None,
            SystemTime::now(),
        )
        .summary;
        assert_eq!(summary_before.runtime_updates_count, 2); // stale_hash + stale_tx
        assert_eq!(summary_before.backups_count, 1);
        assert!(summary_before.total_reclaimable_bytes >= 4096 + 2 + 2048);

        let result = prune_cache_in(
            &app_home,
            &cursor_home,
            None,
            false,
            false,
            None,
            SystemTime::now(),
        );
        assert!(result.freed_bytes >= 4096 + 2048);
        assert!(releases.join(active_hash).is_dir());
        assert!(releases.join(prev_hash).is_dir());
        assert!(!releases.join(stale_hash).exists());
        assert!(handoffs.join(active_tx).is_dir());
        assert!(!handoffs.join(stale_tx).exists());
        assert!(!old_backup_dir.exists());
        assert_eq!(result.remaining.total_reclaimable_bytes, 0);

        let _ = fs::remove_dir_all(&root);
    }
}
