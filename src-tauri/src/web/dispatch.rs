use serde::Deserialize;
use serde_json::Value;
use tauri::Manager;

use super::{web_access_status, web_device_approve, web_device_revoke, web_devices};

// ==================== Command dispatch ====================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendSideMessageArgs {
    engine: String,
    workspace_path: String,
    parent_session_id: Option<String>,
    side_session_id: Option<String>,
    prompt: String,
    image_paths: Option<Vec<String>>,
    ephemeral: bool,
    fallback_transcript: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    provider_id: Option<String>,
    run_id: Option<String>,
    permission: Option<String>,
}

#[derive(Deserialize)]
struct RelayArgs {
    url: String,
    key: String,
}

#[derive(Deserialize)]
struct RelayDeployPackArgs {
    path: String,
    key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayDeployArgs {
    token: String,
    /// Absent for user tokens, which can list their accounts; required in
    /// practice for account-owned ones (`cfat_…`).
    #[serde(default)]
    account_id: Option<String>,
}

#[derive(Deserialize)]
struct DeviceIdArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveRunIdsArgs {
    run_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct WorkerEventsArgs { stream_id:String, after:u64, limit:usize }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerControlArgs { request:crate::worker_host::ControlRequest }
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct WorkerStartArgs { run_id:String, args:crate::task_worker::StartArgs }
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct WorkerSourcesArgs { stream_ids:Option<Vec<String>> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceRenameArgs { id: String, name: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CliUpdateArgs { engine: String, run_id: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PiCredentialArgs { engine: String, provider_id: String, key: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PiProviderArgs { engine: String, provider_id: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PiModelsArgs { engine: String, text: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuotaArgs {
    provider_id: Option<String>, force: Option<bool>, cache_only: Option<bool>, workspace_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodexContextArgs {
    provider_id: Option<String>,
    workspace_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodexContextWriteArgs {
    provider_id: Option<String>,
    workspace_path: Option<String>,
    context_window: Value,
    auto_compact_token_limit: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThroughputStatsArgs {
    engine: Option<String>,
    session_id: Option<String>,
    workspace_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepoPathArgs { repo_path: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeCreateArgs { creation_id: String, args: crate::git_worktree::WorktreeCreateArgs }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreationIdArgs { creation_id: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorktreeRemoveArgs { repo_path: String, worktree_path: String, branch: Option<String>, delete_branch: bool }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BranchMergedArgs { repo_path: String, branch: String, base: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolvePrArgs { repo_path: String, input: String, suggested_branch: String, worktree_path: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginUninstallArgs { id: String, delete_data: bool }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginEnabledArgs { id: String, enabled: bool }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginInstallPathArgs { path: String, request_id: Option<String> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginInstallMarketArgs { id: String, request_id: Option<String> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaderBranchArgs {
    parent_engine: String,
    parent_session_id: String,
    workspace_path: String,
    branch_id: String,
    action: String,
    ttl_seconds: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaderGroupArgs {
    engine: String,
    session_id: String,
    workspace_path: String,
    action: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RespondPlanReviewArgs {
    plan_id: String,
    expected_revision: i64,
    decision: crate::engine::plan_review::PlanDecision,
    feedback: Option<String>,
}

#[derive(Deserialize)]
struct DiagnosticsEnabledArgs {
    enabled: bool,
}

fn parse_args<T: serde::de::DeserializeOwned>(raw: &Value) -> Result<T, String> {
    serde_json::from_value(raw.clone()).map_err(|e| format!("invalid args: {e}"))
}

fn ser<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

// The socket error field is a string. Preserve the native code/message pair
// for transports to decode, rather than reducing conflict/permission to internal.
fn ser_native_error<T: serde::Serialize, E: serde::Serialize>(r: Result<T, E>) -> Result<Value, String> {
    ser(r.map_err(|error| serde_json::to_string(&error).unwrap_or_else(|_| "invalid native error".into())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpInventoryArgs { workspace: Option<String> }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct McpSetEnabledArgs { request: crate::mcp::McpSetEnabledRequest }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct McpProbeArgs { request: crate::mcp::probe::McpProbeRequest }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillsQueryArgs { mode: String, params: Value }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SkillsMutationArgs { action: String, payload: Value }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantPathArgs { path: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginStorageSetArgs { id: String, key: String, value: Value }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginAgentStartArgs {
    plugin_id: String,
    engine: String,
    prompt: String,
    workspace_path: String,
    model: Option<String>,
    provider_id: Option<String>,
    session_id: Option<String>,
    read_only: Option<bool>,
    request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginAgentInterruptArgs { plugin_id: String, run_id: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginHttpArgs {
    plugin_id: String,
    method: String,
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginExecRunArgs {
    plugin_id: String,
    bin: String,
    args: Vec<String>,
    env: Option<std::collections::HashMap<String, String>>,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginExecSpawnArgs {
    plugin_id: String,
    bin: String,
    args: Vec<String>,
    env: Option<std::collections::HashMap<String, String>>,
    lifecycle: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginExecKillArgs { plugin_id: String, only_exited: Option<bool> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineIdArgs {
    engine: String,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginReadFileArgs {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginReadArtworkArgs {
    id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginIdArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginStorageGetArgs {
    id: String,
    key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertProviderArgs {
    engine: String,
    id: String,
    json: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderProvidersArgs {
    engine: String,
    ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetEngineEnabledArgs {
    engine: String,
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HashArgs {
    hash: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportCcSwitchFromPathArgs {
    path: String,
    engine: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchProviderModelsArgs {
    base_url: String,
    #[serde(default)]
    api_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSettingsArgs {
    settings: crate::settings::AppSettings,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateCursorModelSelectionArgs {
    add: Vec<String>,
    remove: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageArgs {
    claude_ultracode: Option<bool>,
    claude_haiku_assist: Option<bool>,
    run_id: Option<String>,
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    prompt: String,
    image_paths: Option<Vec<String>>,
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
    provider_id: Option<String>,
    /// Desktop-only feature; default keeps older web clients compatible.
    #[serde(default)]
    computer_use: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdArgs {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopNativeTaskArgs {
    run_id: String,
    task_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendFollowUpArgs {
    session_id: String,
    engine: String,
    workspace_path: String,
    prompt: String,
    image_paths: Option<Vec<String>>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnswerQuestionArgs {
    session_id: String,
    request_id: String,
    /// Question text → chosen label(s); `None` is the user's skip/dismiss.
    #[serde(default)]
    answers: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineArgs {
    engine: String,
    workspace: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficialConfigWriteArgs {
    engine: String,
    files: Vec<crate::provider_files::OfficialConfigDraft>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavePastedImageArgs {
    data_base64: String,
    extension: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathsArgs {
    paths: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadSessionPageArgs {
    engine: String,
    session_id: String,
    limit: Option<usize>,
    before_seq: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadRemoteSessionPageArgs {
    workspace_path: String,
    engine: String,
    session_id: String,
    remote_path: String,
    limit: Option<usize>,
    before_seq: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteRemoteSessionArgs {
    workspace_path: String,
    engine: String,
    remote_path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageSummaryArgs {
    days: u32,
    tz_offset_minutes: i32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageWindowTotalsArgs {
    windows: Vec<crate::usage::UsageWindowSpan>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageRecordArgs {
    entry: crate::usage::UsageEntry,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineSessionArgs {
    engine: String,
    session_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PredictNextPromptArgs {
    turns: Vec<crate::composer_prediction::PredictionTurn>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SideSessionArgs {
    engine: String,
    session_id: String,
    workspace_path: String,
    parent_session_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveSessionArgs {
    session: crate::history::SessionMeta,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinSessionArgs {
    engine: String,
    session_id: String,
    pinned: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameSessionArgs {
    engine: String,
    session_id: String,
    title: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RememberModelArgs {
    engine: String,
    session_id: String,
    model: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RememberEffortArgs {
    engine: String,
    session_id: String,
    effort: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RememberClaudeUltracodeArgs {
    session_id: String,
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RememberProviderArgs {
    engine: String,
    session_id: String,
    provider_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs {
    path: String,
    /// Optional workspace meta passthrough (plugin workspaces.add keeps
    /// transport descriptions alive on the web runtime too).
    meta: Option<serde_json::Value>,
    /// Optional worktree registration (host UI: 新建/恢复 worktree 子工作区).
    kind: Option<String>,
    parent_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIndexArgs {
    path: String,
    /// Optional: include gitignored entries (chat file-link fallback).
    #[serde(default)]
    include_ignored: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginAddWorkspaceArgs {
    plugin_id: String,
    path: String,
    meta: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct SaveWorkspaceProjectArgs {
    input: crate::workspace_projects::ProjectInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishWorkspaceProjectArgs {
    plugin_id: String,
    source_key: String,
    input: crate::workspace_projects::ProjectInput,
}

#[derive(Deserialize)]
struct ImagePreviewGrantArgs {
    path: String,
    scope: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdsArgs {
    ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentAddArgs {
    name: String,
    prompt: Option<String>,
    icon: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentUpdateArgs {
    id: String,
    name: Option<String>,
    prompt: Option<String>,
    icon: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocaleArgs {
    locale: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuiltInAgentIdArgs {
    agent_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuiltInAgentEnabledArgs {
    agent_id: String,
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuiltInAgentDivisionEnabledArgs {
    division_id: String,
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptsCreateArgs {
    path: String,
    scope: String,
    name: String,
    description: Option<String>,
    argument_hint: Option<String>,
    content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptPathArgs {
    path: String,
    prompt_path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptUpdateArgs {
    path: String,
    prompt_path: String,
    updates: crate::prompts::PromptUpdates,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptMoveArgs {
    path: String,
    prompt_path: String,
    scope: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetWorkspaceGroupArgs {
    id: String,
    group_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteFileArgs {
    path: String,
    content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameItemArgs {
    from: String,
    to: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasteItemArgs {
    source: String,
    target_dir: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchTextArgs {
    path: String,
    query: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchMessagesArgs {
    query: String,
    limit: Option<u32>,
    offset: Option<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffArgs {
    path: String,
    file: String,
    staged: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitFilesArgs {
    path: String,
    files: Vec<String>,
}
#[derive(Deserialize)]
struct GitTreeArgs {
    levels: Vec<crate::git::GitTreeLevel>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitArgs {
    path: String,
    message: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCheckoutArgs {
    path: String,
    branch: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCreateBranchArgs {
    path: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenWorkspaceArgs {
    path: String,
    app: Option<String>,
    #[serde(default)]
    args: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCustomProgramArgs {
    executable_path: String,
    path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetProgramIconArgs {
    executable_path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOpenArgs {
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalWriteArgs {
    id: String,
    data: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResizeArgs {
    id: String,
    cols: u16,
    rows: u16,
}

/// Routes a bridge invoke to the same command functions the Tauri handler
/// uses. Sync commands run inline: the heaviest (git diff, config writes) are
/// milliseconds-scale, and the per-invoke tokio task keeps the read loop
/// unblocked. Commands that genuinely need a thread pool already
/// spawn_blocking internally (git_status, read_file, search_text…).
pub(super) async fn dispatch(
    app: &tauri::AppHandle,
    cmd: &str,
    raw: Value,
    context: &super::RequestContext,
) -> Result<Value, String> {
    authorize_collaboration_context(&app.state::<crate::AppState>().db, cmd, context)?;
    match cmd {
        // config
        "development_profile_active" => ser(Ok::<_, String>(crate::development_profile::development_profile_active())),
        "get_cli_config" => ser(crate::config::get_cli_config()),
        "upsert_provider" => {
            let a: UpsertProviderArgs = parse_args(&raw)?;
            ser(crate::config::upsert_provider(
                app.state(),
                app.state(),
                a.engine,
                a.id,
                a.json,
            ))
        }
        "delete_provider" => {
            let a: EngineIdArgs = parse_args(&raw)?;
            ser(crate::config::delete_provider(app.state(), app.state(), a.engine, a.id))
        }
        "set_current_provider" => {
            let a: EngineIdArgs = parse_args(&raw)?;
            ser(crate::config::set_current_provider(
                app.state(),
                app.state(),
                a.engine,
                a.id,
            ))
        }
        "provider_file_paths" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(Ok::<_, String>(crate::provider_files::provider_file_paths(
                a.engine,
            )))
        }
        "official_config_read" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(crate::provider_files::official_config_read(a.engine))
        }
        "official_config_write" => {
            let a: OfficialConfigWriteArgs = parse_args(&raw)?;
            ser(crate::provider_files::official_config_write(
                app.state(),
                a.engine,
                a.files,
            ))
        }
        "reorder_providers" => {
            let a: ReorderProvidersArgs = parse_args(&raw)?;
            ser(crate::config::reorder_providers(
                app.state(),
                app.state(),
                a.engine,
                a.ids,
            ))
        }
        "set_engine_enabled" => {
            let a: SetEngineEnabledArgs = parse_args(&raw)?;
            ser(crate::config::set_engine_enabled(
                app.state(),
                app.state(),
                a.engine,
                a.enabled,
            ))
        }
        // cc-switch interop
        "check_cc_switch" => ser(crate::cc_switch::check_cc_switch().await),
        "dismiss_cc_switch" => {
            let a: HashArgs = parse_args(&raw)?;
            ser(crate::cc_switch::dismiss_cc_switch(a.hash))
        }
        "import_cc_switch" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(crate::cc_switch::import_cc_switch(app.state(), a.engine))
        }
        "import_cc_switch_from_path" => {
            let a: ImportCcSwitchFromPathArgs = parse_args(&raw)?;
            ser(crate::cc_switch::import_cc_switch_from_path(
                app.state(),
                a.path,
                a.engine,
            ))
        }
        "fetch_provider_models" => {
            let a: FetchProviderModelsArgs = parse_args(&raw)?;
            ser(crate::provider_models::fetch_provider_models(a.base_url, a.api_key).await)
        }
        // settings
        "get_app_settings" => ser(crate::settings::get_app_settings()),
        "update_app_settings" => {
            let a: UpdateSettingsArgs = parse_args(&raw)?;
            ser(crate::settings::update_app_settings(app.clone(), a.settings))
        }
        "update_cursor_model_selection" => {
            let a: UpdateCursorModelSelectionArgs = parse_args(&raw)?;
            ser(crate::settings::update_cursor_model_selection(app.clone(), a.add, a.remove))
        }
        // Engine management always executes on the host, including probes and installers.
        "cli_version_status" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(crate::cli_lifecycle::cli_version_status(a.engine).await)
        }
        "cli_update_plan" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(crate::cli_lifecycle::cli_update_plan(a.engine).await)
        }
        "cli_update_snapshot" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(crate::cli_lifecycle::cli_update_snapshot(a.engine))
        }
        "cli_update" => {
            let a: CliUpdateArgs = parse_args(&raw)?;
            ser(crate::cli_lifecycle::cli_update(a.engine, a.run_id, app.state()).await)
        }
        "dsh_host_status" => ser(crate::dsh_host::dsh_host_status(app.state()).await),
        "dsh_host_start" => ser(crate::dsh_host::dsh_host_start(app.state()).await),
        "dsh_host_stop" => ser(crate::dsh_host::dsh_host_stop(app.state()).await),
        "pi_family_auth_list" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(crate::engine::pi_family_auth::pi_family_auth_list(a.engine))
        }
        "pi_family_auth_set_api_key" => {
            let a: PiCredentialArgs = parse_args(&raw)?;
            ser(crate::engine::pi_family_auth::pi_family_auth_set_api_key(app.state(), a.engine, a.provider_id, a.key))
        }
        "pi_family_auth_delete_credential" => {
            let a: PiProviderArgs = parse_args(&raw)?;
            ser(crate::engine::pi_family_auth::pi_family_auth_delete_credential(app.state(), a.engine, a.provider_id))
        }
        "pi_family_models_config_read" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(crate::engine::pi_family_auth::pi_family_models_config_read(a.engine))
        }
        "pi_family_models_config_write" => {
            let a: PiModelsArgs = parse_args(&raw)?;
            ser(crate::engine::pi_family_auth::pi_family_models_config_write(app.state(), a.engine, a.text))
        }
        "claude_quota_read" => {
            let a: QuotaArgs = parse_args(&raw)?;
            ser(crate::claude_quota::claude_quota_read(app.state(), a.provider_id, a.force, a.cache_only, a.workspace_path).await)
        }
        "codex_quota_read" => {
            let a: QuotaArgs = parse_args(&raw)?;
            ser(crate::codex_quota::codex_quota_read(app.state(), a.provider_id, a.force, a.cache_only, a.workspace_path).await)
        }
        "codex_context_window_read" => {
            let a: CodexContextArgs = parse_args(&raw)?;
            ser(crate::codex_context_window::codex_context_window_read(a.provider_id, a.workspace_path))
        }
        "codex_context_window_write" => {
            let a: CodexContextWriteArgs = parse_args(&raw)?;
            ser(crate::codex_context_window::codex_context_window_write(app.state(), a.provider_id, a.workspace_path, a.context_window, a.auto_compact_token_limit))
        }
        "agy_quota_read" => {
            let a: QuotaArgs = parse_args(&raw)?;
            ser(crate::agy_quota::agy_quota_read(app.state(), a.provider_id, a.force, a.cache_only, a.workspace_path).await)
        }
        "agy_vertex_credits_read" => {
            let a: QuotaArgs = parse_args(&raw)?;
            ser(crate::agy_vertex_credits::agy_vertex_credits_read(app.clone(), a.force).await)
        }
        "throughput_stats_read" => {
            let a: ThroughputStatsArgs = parse_args(&raw)?;
            ser(crate::throughput_stats::throughput_stats_read(app.state(), a.engine, a.session_id, a.workspace_path))
        }
        // engine
        "active_run_ids" => {
            let a: ActiveRunIdsArgs = parse_args(&raw)?;
            ser(crate::engine::active_run_ids(app.state(), a.run_ids))
        }
        "task_snapshot" => ser(crate::leader::snapshot()),
        "task_branch_action" => {
            let _update_guard = crate::worker_host::task_action_guard().await?;
            let a: LeaderBranchArgs = parse_args(&raw)?;
            ser(crate::leader::branch_action(&app.state::<crate::AppState>().db,
                a.parent_engine, a.parent_session_id, a.workspace_path, a.branch_id, a.action, a.ttl_seconds).await)
        }
        "task_group_action" => {
            let _update_guard = crate::worker_host::task_action_guard().await?;
            let a: LeaderGroupArgs = parse_args(&raw)?;
            ser(crate::leader::group_action(&app.state::<crate::AppState>().db,
                a.engine, a.session_id, a.workspace_path, a.action).await)
        }
        "send_message" => {
            let a: SendMessageArgs = parse_args(&raw)?;
            ser(crate::engine::send_message(
                app.state(),
                a.engine,
                a.workspace_path,
                a.session_id,
                a.prompt,
                a.image_paths,
                a.model,
                a.effort,
                a.permission,
                a.provider_id,
                a.run_id,
                a.computer_use,
                a.claude_ultracode,
                a.claude_haiku_assist,
            )
            .await)
        }
        "send_side_message" => {
            let a: SendSideMessageArgs = parse_args(&raw)?;
            ser(crate::engine::send_side_message(
                app.state(),
                a.engine,
                a.workspace_path,
                a.parent_session_id,
                a.side_session_id,
                a.prompt,
                a.image_paths,
                a.ephemeral,
                a.fallback_transcript,
                a.model,
                a.effort,
                a.provider_id,
                a.run_id,
                a.permission,
            )
            .await)
        }
        "cleanup_side_session" => {
            let a: SideSessionArgs = parse_args(&raw)?;
            ser(crate::engine::cleanup_side_session(app.state(), a.engine, a.session_id, a.workspace_path, a.parent_session_id).await)
        }
        "interactive_answer_read" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Args { identity: String, source: String }
            let a: Args = parse_args(&raw)?;
            ser(crate::interactive_answer_state::interactive_answer_read(a.identity, a.source))
        }
        "interactive_answer_write" | "interactive_answer_reset" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Args { identity: String, source: String, expected_revision: u64, values: serde_json::Map<String, Value> }
            let a: Args = parse_args(&raw)?;
            ser(crate::interactive_answer_state::interactive_answer_write(a.identity, a.source, a.expected_revision, a.values))
        }
        "promote_side_session" => {
            let a: SideSessionArgs = parse_args(&raw)?;
            ser(crate::engine::promote_side_session(app.state(), a.engine, a.session_id, a.workspace_path, a.parent_session_id).await)
        }
        "runtime_worker_sources" => {
            let a:WorkerSourcesArgs = parse_args(&raw)?;
            ser(crate::worker_host::runtime_worker_sources(a.stream_ids).await)
        }
        "runtime_observer_snapshot" => crate::handoff::runtime_observer_snapshot(app.clone()).await,
        "runtime_worker_events" => {
            let a:WorkerEventsArgs = parse_args(&raw)?;
            ser(crate::worker_host::runtime_worker_events(a.stream_id, a.after, a.limit).await)
        }
        "runtime_worker_control" => {
            let a:WorkerControlArgs = parse_args(&raw)?;
            crate::worker_host::runtime_worker_control(a.request).await
        }
        "runtime_worker_start" => {
            let a:WorkerStartArgs = parse_args(&raw)?;
            crate::worker_host::runtime_worker_start(app.state(), a.run_id, a.args).await
        }
        "interrupt_session" => {
            let a: SessionIdArgs = parse_args(&raw)?;
            ser(crate::engine::interrupt_session(app.state(), a.session_id).await)
        }
        "list_plan_reviews" => {
            let a: EngineSessionArgs = parse_args(&raw)?;
            ser(crate::engine::list_plan_reviews(app.state(), a.engine, a.session_id).await)
        }
        "respond_plan_review" => {
            let a: RespondPlanReviewArgs = parse_args(&raw)?;
            ser(crate::engine::respond_plan_review(app.state(), a.plan_id, a.expected_revision, a.decision, a.feedback).await)
        }
        "runtime_worker_plan_review" => {
            let a: RespondPlanReviewArgs = parse_args(&raw)?;
            crate::engine::runtime_worker_plan_review(app.state(), a.plan_id, a.expected_revision, a.decision, a.feedback).await
        }
        // Native follow-up / Esc against a live claude CLI: the remote UI runs
        // the same chat store, so it calls them too (else `unknown command`).
        "interrupt_turn" => {
            let a: SessionIdArgs = parse_args(&raw)?;
            ser(crate::engine::interrupt_turn(app.state(), a.session_id).await)
        }
        "stop_native_task" => {
            let a: StopNativeTaskArgs = parse_args(&raw)?;
            ser(crate::engine::stop_native_task(app.state(), a.run_id, a.task_id).await)
        }
        "send_follow_up" => {
            let a: SendFollowUpArgs = parse_args(&raw)?;
            ser(crate::engine::send_follow_up(
                app.state(),
                a.session_id,
                a.engine,
                a.workspace_path,
                a.prompt,
                a.image_paths,
            )
            .await)
        }
        // The remote UI renders the same AskUserQuestion card as the desktop
        // (events already reach it); without this case its 提交/忽略 buttons
        // failed with `unknown command: answer_question`.
        "answer_question" => {
            let a: AnswerQuestionArgs = parse_args(&raw)?;
            ser(
                crate::engine::answer_question(app.state(), a.session_id, a.request_id, a.answers)
                    .await,
            )
        }
        "list_engines" => ser(crate::engine::list_engines().await),
        "list_engine_models" => {
            let a: EngineArgs = parse_args(&raw)?;
            ser(crate::engine::models::list_engine_models(app.state(), a.engine, a.workspace).await)
        }
        "save_pasted_image" => {
            let a: SavePastedImageArgs = parse_args(&raw)?;
            ser(crate::engine::images::save_pasted_image(
                a.data_base64,
                a.extension,
            ))
        }
        "import_attachments" => {
            let a: PathsArgs = parse_args(&raw)?;
            ser(crate::engine::images::import_attachments(a.paths))
        }
        // history
        "list_sessions" => ser(crate::history::reader::list_sessions(app.state())),
        "list_archived_sessions" => {
            ser(crate::history::reader::list_archived_sessions(app.state()))
        }
        "archive_session" => {
            let a: ArchiveSessionArgs = parse_args(&raw)?;
            ser(crate::history::reader::archive_session(
                app.state(),
                a.session,
            ))
        }
        "restore_session" => {
            let a: EngineSessionArgs = parse_args(&raw)?;
            ser(crate::history::reader::restore_session(
                app.state(),
                a.engine,
                a.session_id,
            ))
        }
        // Usage ledger: the mobile/web client renders the same page, so the
        // bridge must route it like every other settings surface.
        "usage_summary" => {
            let a: UsageSummaryArgs = parse_args(&raw)?;
            ser(crate::usage::usage_summary(
                app.state(),
                a.days,
                a.tz_offset_minutes,
            ))
        }
        "usage_window_totals" => {
            let a: UsageWindowTotalsArgs = parse_args(&raw)?;
            ser(crate::usage::usage_window_totals(
                app.state(),
                a.windows,
            ))
        }
        "usage_record" => {
            let a: UsageRecordArgs = parse_args(&raw)?;
            ser(crate::usage::usage_record(
                app.clone(),
                app.state(),
                a.entry,
            ))
        }
        "usage_clear" => ser(crate::usage::usage_clear(app.state())),
        "load_session_page" => {
            let a: LoadSessionPageArgs = parse_args(&raw)?;
            ser(crate::history::reader::load_session_page(
                app.state(),
                a.engine,
                a.session_id,
                a.limit,
                a.before_seq,
            )
            .await)
        }
        "load_remote_session_page" => {
            let a: LoadRemoteSessionPageArgs = parse_args(&raw)?;
            ser(crate::history::reader::load_remote_session_page(
                app.state(),
                a.workspace_path,
                a.engine,
                a.session_id,
                a.remote_path,
                a.limit,
                a.before_seq,
            )
            .await)
        }
        "delete_session" => {
            let a: EngineSessionArgs = parse_args(&raw)?;
            ser(crate::history::reader::delete_session(app.state(), a.engine, a.session_id).await)
        }
        "delete_remote_session" => {
            let a: DeleteRemoteSessionArgs = parse_args(&raw)?;
            ser(crate::history::reader::delete_remote_session(
                app.state(),
                a.workspace_path,
                a.engine,
                a.remote_path,
            )
            .await)
        }
        "pin_session" => {
            let a: PinSessionArgs = parse_args(&raw)?;
            ser(crate::history::reader::pin_session(
                app.state(),
                a.engine,
                a.session_id,
                a.pinned,
            ))
        }
        "rename_session" => {
            let a: RenameSessionArgs = parse_args(&raw)?;
            ser(crate::history::reader::rename_session(
                app.state(),
                a.engine,
                a.session_id,
                a.title,
            ))
        }
        "suggest_session_title" => {
            let a: EngineSessionArgs = parse_args(&raw)?;
            ser(crate::auto_title::suggest_session_title(app.state(), a.engine, a.session_id).await)
        }
        "auto_title_models" => ser(crate::auto_title::auto_title_models().await),
        "predict_next_prompt" => {
            let a: PredictNextPromptArgs = parse_args(&raw)?;
            ser(crate::composer_prediction::predict_next_prompt(a.turns).await)
        }
        "remember_session_model" => {
            let a: RememberModelArgs = parse_args(&raw)?;
            ser(crate::history::reader::remember_session_model(
                app.state(),
                a.engine,
                a.session_id,
                a.model,
            ))
        }
        "add_workspace" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::history::reader::add_workspace(
                app.state(),
                a.path,
                a.meta,
                a.kind,
                a.parent_id,
            ))
        }
        "plugin_add_workspace" => {
            let a: PluginAddWorkspaceArgs = parse_args(&raw)?;
            ser(
                crate::plugin_caps::plugin_add_workspace(app.state(), a.plugin_id, a.path, a.meta)
                    .await,
            )
        }
        "remember_session_effort" => {
            let a: RememberEffortArgs = parse_args(&raw)?;
            ser(crate::history::reader::remember_session_effort(
                app.state(),
                a.engine,
                a.session_id,
                a.effort,
            ))
        }
        "remember_claude_ultracode" => {
            let a: RememberClaudeUltracodeArgs = parse_args(&raw)?;
            ser(crate::history::reader::remember_claude_ultracode(
                app.state(), a.session_id, a.enabled,
            ))
        }
        "remember_session_provider" => {
            let a: RememberProviderArgs = parse_args(&raw)?;
            ser(crate::history::reader::remember_session_provider(
                app.state(),
                a.engine,
                a.session_id,
                a.provider_id,
            ))
        }
        "rescan_sessions" => {
            crate::history::reader::rescan_sessions(app.state());
            Ok(Value::Null)
        }
        "list_workspaces" => ser(crate::history::reader::list_workspaces(app.state())),
        "get_session_sidebar_workspaces" => ser(crate::session_sidebar::list(&app.state::<crate::AppState>().db)),
        "assign_session_sidebar_workspaces" => {
            let a: crate::session_sidebar::AssignArgs = parse_args(&raw)?;
            let state = app.state::<crate::AppState>();
            let result = crate::session_sidebar::assign(&state.db, a.request_id, a.assignments)?;
            if !result.replayed { state.sink.emit_sessions_changed(); }
            ser(Ok(result))
        }
        "list_workspace_projects" => ser(crate::workspace_projects::list_workspace_projects(app.state())),
        "save_workspace_project" => {
            let a: SaveWorkspaceProjectArgs = parse_args(&raw)?;
            ser(crate::workspace_projects::save_workspace_project(app.state(), a.input))
        }
        "remove_workspace_project" => {
            let a: IdArgs = parse_args(&raw)?;
            ser(crate::workspace_projects::remove_workspace_project(app.state(), a.id))
        }
        "plugin_publish_workspace_project" => {
            let a: PublishWorkspaceProjectArgs = parse_args(&raw)?;
            ser(crate::plugin_caps::plugin_publish_workspace_project(app.state(), a.plugin_id, a.source_key, a.input).await)
        }
        "reorder_workspaces" => {
            let a: IdsArgs = parse_args(&raw)?;
            ser(crate::history::reader::reorder_workspaces(
                app.state(),
                a.ids,
            ))
        }
        "remove_workspace" => {
            let a: IdArgs = parse_args(&raw)?;
            ser(crate::history::reader::remove_workspace(app.state(), a.id))
        }
        "set_workspace_group" => {
            let a: SetWorkspaceGroupArgs = parse_args(&raw)?;
            ser(crate::history::reader::set_workspace_group(
                app.state(),
                a.id,
                a.group_id,
            ))
        }
        // files
        "list_dir" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::files::list_dir(app.state(), a.path))
        }
        "read_file" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::files::read_file(app.state(), a.path).await)
        }
        "read_preview_image" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::image_preview::read_preview_image(app.state(), a.path).await)
        }
        "write_file" => {
            let a: WriteFileArgs = parse_args(&raw)?;
            ser(crate::files::write_file(app.state(), a.path, a.content))
        }
        "create_dir" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::files::create_dir(app.state(), a.path))
        }
        "create_file" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::files::create_file(app.state(), a.path))
        }
        "rename_item" => {
            let a: RenameItemArgs = parse_args(&raw)?;
            ser(crate::files::rename_item(app.state(), a.from, a.to))
        }
        "trash_item" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::files::trash_item(app.state(), a.path))
        }
        "duplicate_item" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::files::duplicate_item(app.state(), a.path))
        }
        "paste_item" => {
            let a: PasteItemArgs = parse_args(&raw)?;
            ser(crate::files::paste_item(
                app.state(),
                a.source,
                a.target_dir,
            ))
        }
        "search_text" => {
            let a: SearchTextArgs = parse_args(&raw)?;
            ser(crate::files::search_text(app.state(), a.path, a.query).await)
        }
        "search_messages" => {
            let a: SearchMessagesArgs = parse_args(&raw)?;
            ser(
                crate::history::search::search_messages(app.state(), a.query, a.limit, a.offset)
                    .await,
            )
        }
        "list_file_index" => {
            let a: FileIndexArgs = parse_args(&raw)?;
            ser(crate::files::list_file_index(app.state(), a.path, a.include_ignored).await)
        }
        "list_slash_commands" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::slash_commands::list_slash_commands(app.state(), a.path).await)
        }

        // Tool management runs on the paired desktop with its native validation.
        "mcp_inventory" => {
            let a: McpInventoryArgs = parse_args(&raw)?;
            ser_native_error(crate::mcp::mcp_inventory(app.state(), a.workspace).await)
        }
        "mcp_set_enabled" => {
            let a: McpSetEnabledArgs = parse_args(&raw)?;
            ser_native_error(crate::mcp::mcp_set_enabled(app.state(), a.request).await)
        }
        "mcp_probe" => {
            let a: McpProbeArgs = parse_args(&raw)?;
            ser_native_error(crate::mcp::probe::mcp_probe(app.state(), a.request).await)
        }
        "skills_hub_query" => {
            let a: SkillsQueryArgs = parse_args(&raw)?;
            ser_native_error(crate::skills_hub::skills_hub_query(a.mode, a.params).await)
        }
        "skills_hub_mutate" => {
            let a: SkillsMutationArgs = parse_args(&raw)?;
            ser_native_error(crate::skills_hub::skills_hub_mutate(app.state(), a.action, a.payload).await)
        }
        // agents & prompts (composer `#`/`!` pickers)
        "agent_list" => ser(crate::agents::agent_list().await),
        "agent_add" => {
            let a: AgentAddArgs = parse_args(&raw)?;
            ser(crate::agents::agent_add(a.name, a.prompt, a.icon).await)
        }
        "agent_update" => {
            let a: AgentUpdateArgs = parse_args(&raw)?;
            ser(crate::agents::agent_update(a.id, a.name, a.prompt, a.icon).await)
        }
        "agent_delete" => {
            let a: IdArgs = parse_args(&raw)?;
            ser(crate::agents::agent_delete(a.id).await)
        }
        // built-in agent catalog (agency-agents pack)
        "list_built_in_agents" => {
            let a: LocaleArgs = parse_args(&raw)?;
            ser(crate::agent_catalog::list_built_in_agents(a.locale, app.clone()).await)
        }
        "set_built_in_agent_enabled" => {
            let a: BuiltInAgentEnabledArgs = parse_args(&raw)?;
            ser(crate::agent_catalog::set_built_in_agent_enabled(
                a.agent_id,
                a.enabled,
                app.clone(),
            )
            .await)
        }
        "set_built_in_agent_division_enabled" => {
            let a: BuiltInAgentDivisionEnabledArgs = parse_args(&raw)?;
            ser(crate::agent_catalog::set_built_in_agent_division_enabled(
                a.division_id,
                a.enabled,
                app.clone(),
            )
            .await)
        }
        "get_built_in_agent_prompt" => {
            let a: BuiltInAgentIdArgs = parse_args(&raw)?;
            ser(crate::agent_catalog::get_built_in_agent_prompt(a.agent_id, app.clone()).await)
        }
        "resolve_enabled_built_in_agent" => {
            let a: BuiltInAgentIdArgs = parse_args(&raw)?;
            ser(crate::agent_catalog::resolve_enabled_built_in_agent(a.agent_id, app.clone()).await)
        }
        "prompts_list" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::prompts::prompts_list(app.state(), a.path).await)
        }
        "prompts_dirs" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::prompts::prompts_dirs(app.state(), a.path).await)
        }
        "prompts_create" => {
            let a: PromptsCreateArgs = parse_args(&raw)?;
            ser(crate::prompts::prompts_create(
                app.state(),
                a.path,
                a.scope,
                a.name,
                a.description,
                a.argument_hint,
                a.content,
            )
            .await)
        }
        "prompts_update" => {
            let a: PromptUpdateArgs = parse_args(&raw)?;
            ser(crate::prompts::prompts_update(app.state(), a.path, a.prompt_path, a.updates).await)
        }
        "prompts_delete" => {
            let a: PromptPathArgs = parse_args(&raw)?;
            ser(crate::prompts::prompts_delete(app.state(), a.path, a.prompt_path).await)
        }
        "prompts_move" => {
            let a: PromptMoveArgs = parse_args(&raw)?;
            ser(crate::prompts::prompts_move(app.state(), a.path, a.prompt_path, a.scope).await)
        }
        // Approved remote users may manage host roots; file operations retain
        // ensure_allowed and every grant mutation rechecks remote authorization.
        "grant_scope" => {
            let a: GrantPathArgs = parse_args(&raw)?;
            ser(crate::files::grant_scope(a.path))
        }
        "grant_root" => {
            let a: GrantPathArgs = parse_args(&raw)?;
            ser(crate::files::grant_root(app.state(), a.path))
        }
        "list_granted_roots" => ser(crate::files::list_granted_roots(app.state())),
        "list_image_preview_grants" => ser(crate::image_preview::list_image_preview_grants(app.state())),
        "image_preview_scope" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::image_preview::image_preview_scope(a.path))
        }
        "revoke_image_preview_grant" => {
            let a: ImagePreviewGrantArgs = parse_args(&raw)?;
            ser(crate::image_preview::revoke_image_preview_grant(app.state(), a.path, a.scope))
        }
        "revoke_granted_root" => {
            let a: GrantPathArgs = parse_args(&raw)?;
            ser(crate::files::revoke_granted_root(app.state(), a.path))
        }
        "git_worktree_list" => {
            let a: RepoPathArgs = parse_args(&raw)?;
            ser(crate::git_worktree::git_worktree_list(a.repo_path).await)
        }
        "git_worktree_create" => {
            let a: WorktreeCreateArgs = parse_args(&raw)?;
            ser(crate::git_worktree::git_worktree_create(app.clone(), app.state(), a.creation_id, a.args).await)
        }
        "git_worktree_create_cancel" => {
            let a: CreationIdArgs = parse_args(&raw)?;
            Ok(serde_json::json!(crate::git_worktree::git_worktree_create_cancel(app.state(), a.creation_id)))
        }
        "git_worktree_creation_snapshot" => Ok(serde_json::json!(crate::git_worktree::git_worktree_creation_snapshot(app.state()))),
        "git_worktree_remove" => {
            let a: WorktreeRemoveArgs = parse_args(&raw)?;
            ser(crate::git_worktree::git_worktree_remove(app.state(), a.repo_path, a.worktree_path, a.branch, a.delete_branch).await)
        }
        "git_branch_merged" => {
            let a: BranchMergedArgs = parse_args(&raw)?;
            ser(crate::git_worktree::git_branch_merged(a.repo_path, a.branch, a.base).await)
        }
        "git_resolve_pr" => {
            let a: ResolvePrArgs = parse_args(&raw)?;
            ser(crate::git_worktree::git_resolve_pr(a.repo_path, a.input, a.suggested_branch, a.worktree_path).await)
        }
        // git
        "git_status" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::git::git_status(a.path).await)
        }
        "git_repository_summaries" => {
            let a: PathsArgs = parse_args(&raw)?;
            ser(Ok(crate::git::git_repository_summaries(a.paths).await))
        }
        "git_file_colors" => {
            let a: GitFilesArgs = parse_args(&raw)?;
            ser(crate::git::git_file_colors(a.path, a.files).await)
        }
        "git_tree_status" => {
            let a: GitTreeArgs = parse_args(&raw)?;
            ser(crate::git::git_tree_status(a.levels).await)
        }
        "git_diff" => {
            let a: GitDiffArgs = parse_args(&raw)?;
            ser(crate::git::git_diff(a.path, a.file, a.staged).await)
        }
        "git_stage" => {
            let a: GitFilesArgs = parse_args(&raw)?;
            ser(crate::git::git_stage(a.path, a.files))
        }
        "git_unstage" => {
            let a: GitFilesArgs = parse_args(&raw)?;
            ser(crate::git::git_unstage(a.path, a.files))
        }
        // Same shared changes panel as the desktop, so the remote client's
        // 「撤销更改」 must route too (it falls through to unknown otherwise).
        "git_discard" => {
            let a: GitFilesArgs = parse_args(&raw)?;
            ser(crate::git::git_discard(a.path, a.files))
        }
        "git_commit" => {
            let a: GitCommitArgs = parse_args(&raw)?;
            ser(crate::git::git_commit(a.path, a.message))
        }
        "git_push" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::git::git_push(a.path).await)
        }
        "git_pull" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::git::git_pull(a.path).await)
        }
        "git_branches" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::git::git_branches(a.path))
        }
        "git_checkout" => {
            let a: GitCheckoutArgs = parse_args(&raw)?;
            ser(crate::git::git_checkout(a.path, a.branch))
        }
        "git_create_branch" => {
            let a: GitCreateBranchArgs = parse_args(&raw)?;
            ser(crate::git::git_create_branch(a.path, a.name))
        }
        // open-app
        "open_workspace_in" => {
            let a: OpenWorkspaceArgs = parse_args(&raw)?;
            ser(crate::open_app::open_workspace_in(a.path, a.app, a.args).await)
        }
        "open_custom_program" => {
            let a: OpenCustomProgramArgs = parse_args(&raw)?;
            ser(crate::open_app::open_custom_program(a.executable_path, a.path).await)
        }
        "get_program_icon" => {
            let a: GetProgramIconArgs = parse_args(&raw)?;
            ser(crate::open_app::get_program_icon(a.executable_path).await)
        }
        "reveal_in_file_manager" => {
            let a: PathArgs = parse_args(&raw)?;
            ser(crate::open_app::reveal_in_file_manager(a.path).await)
        }
        // terminal
        "terminal_open" => {
            let a: TerminalOpenArgs = parse_args(&raw)?;
            ser(crate::terminal::terminal_open(a.id, a.cwd, a.cols, a.rows, app.state()).await)
        }
        "terminal_write" => {
            let a: TerminalWriteArgs = parse_args(&raw)?;
            ser(crate::terminal::terminal_write(a.id, a.data, app.state()).await)
        }
        "terminal_resize" => {
            let a: TerminalResizeArgs = parse_args(&raw)?;
            ser(crate::terminal::terminal_resize(a.id, a.cols, a.rows, app.state()).await)
        }
        "terminal_close" => {
            let a: IdArgs = parse_args(&raw)?;
            ser(crate::terminal::terminal_close(a.id, app.state()).await)
        }
        // metrics
        "app_metrics" => ser(crate::metrics::app_metrics(app.state())),
        "performance_diagnostics" => ser(crate::metrics::performance_diagnostics(app.state())),
        "performance_diagnostics_enabled" => {
            ser(crate::metrics::performance_diagnostics_enabled(app.state()))
        }
        "performance_diagnostics_set_enabled" => {
            let args: DiagnosticsEnabledArgs = parse_args(&raw)?;
            ser(crate::metrics::performance_diagnostics_set_enabled(
                args.enabled,
                app.state(),
                app.state(),
            ))
        }
        // web access: phones may read status; start/stop stay desktop-only.
        "web_access_status" => ser(Ok(web_access_status(app.clone()))),
        // The relay has no bootstrap problem (unlike the bridge, which cannot
        // start itself over itself), so an approved device may manage it too.
        "web_relay_status" => ser(Ok(crate::relay::web_relay_status(app.clone()))),
        "web_relay_start" => {
            let a: RelayArgs = parse_args(&raw)?;
            ser(crate::relay::web_relay_start(app.clone(), a.url, a.key).await)
        }
        "web_relay_stop" => ser(crate::relay::web_relay_stop(app.clone())),
        "relay_deploy_pack" => {
            let a: RelayDeployPackArgs = parse_args(&raw)?;
            ser(crate::relay::relay_deploy_pack(a.path, a.key))
        }
        "relay_deploy" => {
            let a: RelayDeployArgs = parse_args(&raw)?;
            ser(crate::relay::relay_deploy(a.token, a.account_id).await)
        }
        // Device approval is the one management action a phone may take: it
        // is already device-scoped, and the desktop page would otherwise be
        // the only way to approve a browser the user is holding.
        "web_devices" => ser(web_devices(app.clone())),
        "web_device_rename" => {
            let a: DeviceRenameArgs = parse_args(&raw)?;
            ser(super::web_device_rename(app.clone(), a.id, a.name))
        }
        "rotate_web_pair_key" => ser(super::rotate_web_pair_key(app.clone())),
        "remote_control_active" => Ok(serde_json::json!(super::remote_control_active())),
        "web_device_approve" => {
            let a: DeviceIdArgs = parse_args(&raw)?;
            ser(web_device_approve(app.clone(), a.id))
        }
        "web_device_revoke" => {
            let a: DeviceIdArgs = parse_args(&raw)?;
            ser(web_device_revoke(app.clone(), a.id))
        }
        // Plugin lifecycle and granted tool execution share the native host.
        // Desktop chat coordination and global crash quarantine remain native.
        "plugin_list" => ser(crate::plugins::plugin_list(app.state())),
        "plugin_install_from_path" => {
            let a: PluginInstallPathArgs = parse_args(&raw)?;
            ser(crate::plugins::plugin_install_from_path(app.clone(), app.state(), a.path, a.request_id, None, None, None).await)
        }
        "plugin_install_from_marketplace" => {
            let a: PluginInstallMarketArgs = parse_args(&raw)?;
            ser(crate::plugins::market::plugin_install_from_marketplace(app.state(), a.id, a.request_id).await)
        }
        "plugin_set_enabled" => {
            let a: PluginEnabledArgs = parse_args(&raw)?;
            ser(crate::plugins::plugin_set_enabled(app.clone(), app.state(), a.id, a.enabled))
        }
        "plugin_uninstall" => {
            let a: PluginUninstallArgs = parse_args(&raw)?;
            ser(crate::plugins::plugin_uninstall(app.clone(), app.state(), app.state(), a.id, a.delete_data))
        }
        "plugin_reload" => {
            let a: PluginIdArgs = parse_args(&raw)?;
            ser(crate::plugins::plugin_reload(app.clone(), app.state(), a.id, None, None, None, None))
        }
        "creator_skill_install" => Ok(serde_json::json!(crate::creator_skill::creator_skill_install(app.clone()))),
        "plugin_read_artwork" => {
            let a: PluginReadArtworkArgs = parse_args(&raw)?;
            ser(crate::plugins::plugin_read_artwork(a.id, a.path))
        }
        "plugin_read_file" => {
            let a: PluginReadFileArgs = parse_args(&raw)?;
            ser(crate::plugins::plugin_read_file(a.id, a.name))
        }
        "plugin_storage_get" => {
            let a: PluginStorageGetArgs = parse_args(&raw)?;
            ser(crate::plugins::plugin_storage_get(app.state(), a.id, a.key))
        }
        "plugin_storage_set" => {
            let a: PluginStorageSetArgs = parse_args(&raw)?;
            ser(crate::plugins::plugin_storage_set(app.state(), a.id, a.key, a.value))
        }
        "plugin_storage_delete" => {
            let a: PluginStorageGetArgs = parse_args(&raw)?;
            ser(crate::plugins::plugin_storage_delete(app.state(), a.id, a.key))
        }
        // All egress goes through enabled/manifest grant checks in plugin_caps;
        // interrupt and cleanup also retain native plugin ownership checks.
        "plugin_fixed_instructions_supported" => Ok(serde_json::json!(crate::plugin_caps::plugin_fixed_instructions_supported())),
        "plugin_agent_start" => {
            let a: PluginAgentStartArgs = parse_args(&raw)?;
            ser(crate::plugin_caps::plugin_agent_start(app.clone(), a.plugin_id,
                a.engine, a.prompt, a.workspace_path, a.model, a.provider_id,
                a.session_id, a.read_only, a.request_id).await)
        }
        "plugin_agent_interrupt" => {
            let a: PluginAgentInterruptArgs = parse_args(&raw)?;
            ser(crate::plugin_caps::plugin_agent_interrupt(app.clone(), a.plugin_id, a.run_id).await)
        }
        "plugin_http_request" => {
            let a: PluginHttpArgs = parse_args(&raw)?;
            ser(crate::plugin_caps::plugin_http_request(a.plugin_id, a.method, a.url, a.headers, a.body).await)
        }
        "plugin_exec_run" => {
            let a: PluginExecRunArgs = parse_args(&raw)?;
            ser(crate::plugin_caps::plugin_exec_run(a.plugin_id, a.bin, a.args, a.env, a.timeout_ms).await)
        }
        "plugin_exec_spawn" => {
            let a: PluginExecSpawnArgs = parse_args(&raw)?;
            ser(crate::plugin_caps::plugin_exec_spawn(a.plugin_id, a.bin, a.args, a.env, a.lifecycle).await)
        }
        "plugin_exec_kill" => {
            let a: PluginExecKillArgs = parse_args(&raw)?;
            ser(crate::plugin_caps::plugin_exec_kill(a.plugin_id, a.only_exited).await)
        }
        // Marketplace browsing is read-only too, so the web client renders
        // the market page; installation uses the host lifecycle routes above.
        "plugin_fetch_index" => ser(crate::plugins::market::plugin_fetch_index(false).await),
        "plugin_fetch_market_readme" => {
            let a: PluginIdArgs = parse_args(&raw)?;
            ser(crate::plugins::market::plugin_fetch_market_readme(a.id).await)
        }
        "plugin_check_updates" => ser(crate::plugins::market::plugin_check_updates().await),
        _ => Err(format!("unknown command: {cmd}")),
    }
}

// The socket handshake already validates the LAN token or approved relay device.
// Recheck device revocation for every collaboration operation, and require same-origin
// browser writes. An authenticated LAN-token connection has no device row.
fn collaboration_write_required(command: &str) -> Option<bool> {
    match command {
        "active_run_ids" | "task_snapshot" | "list_plan_reviews" | "mcp_inventory" | "skills_hub_query"
        | "list_workspace_projects" | "get_session_sidebar_workspaces" | "list_image_preview_grants" | "image_preview_scope" | "read_preview_image"
        | "grant_scope" | "list_granted_roots" | "plugin_list" | "plugin_read_artwork"
        | "plugin_read_file" | "plugin_storage_get"
        | "cli_version_status" | "cli_update_plan" | "cli_update_snapshot"
        | "dsh_host_status" | "pi_family_auth_list" | "pi_family_models_config_read"
        | "claude_quota_read" | "codex_quota_read" | "codex_context_window_read" | "agy_quota_read" | "agy_vertex_credits_read" | "throughput_stats_read" | "git_worktree_list" | "git_worktree_creation_snapshot"
        | "git_branch_merged" | "git_resolve_pr" | "remote_control_active" => Some(false),
        "runtime_worker_start" | "runtime_worker_control" | "runtime_worker_plan_review"
        | "save_workspace_project" | "assign_session_sidebar_workspaces" | "remove_workspace_project" | "plugin_publish_workspace_project" | "revoke_image_preview_grant"
        | "task_branch_action" | "task_group_action"
        | "respond_plan_review" | "add_workspace" | "plugin_add_workspace" | "mcp_set_enabled"
        | "mcp_probe" | "skills_hub_mutate" | "grant_root" | "revoke_granted_root"
        | "plugin_agent_start" | "plugin_agent_interrupt" | "plugin_http_request"
        | "plugin_exec_run" | "plugin_exec_spawn" | "plugin_exec_kill"
        | "plugin_storage_set" | "plugin_storage_delete"
        | "cli_update" | "dsh_host_start" | "dsh_host_stop"
        | "pi_family_auth_set_api_key" | "pi_family_auth_delete_credential" | "pi_family_models_config_write" | "codex_context_window_write"
        | "git_worktree_create" | "git_worktree_create_cancel" | "git_worktree_remove"
        | "plugin_install_from_path" | "plugin_install_from_marketplace" | "plugin_set_enabled"
        | "plugin_uninstall" | "plugin_reload" | "creator_skill_install"
        | "web_device_rename" | "rotate_web_pair_key"
        | "upsert_provider" | "delete_provider" | "set_current_provider" | "reorder_providers" | "set_engine_enabled" => Some(true),
        _ => None,
    }
}

fn authorize_collaboration_context(db: &crate::db::Db, command: &str, context: &super::RequestContext) -> Result<(), String> {
    // Revocation and socket lifetime apply even to pre-existing commands.
    // Additional origin requirements cover the collaboration write surface.
    let write = collaboration_write_required(command).unwrap_or(false);
    let authorized = if context.device.is_empty() {
        context.live.load(std::sync::atomic::Ordering::SeqCst) && (!write || context.origin_allowed)
    } else {
        context.authorized(db, write)
    };
    if authorized { Ok(()) } else { Err("Remote access is no longer authorized; reconnect this device".into()) }
}

#[cfg(test)]
mod follow_up_args_tests {
    use super::*;

    #[test]
    fn sidechat_wire_permission_preserves_old_requests_and_explicit_modes() {
        let mut raw = serde_json::json!({"engine":"codex","workspacePath":"test","prompt":"question","ephemeral":false});
        assert!(serde_json::from_value::<SendSideMessageArgs>(raw.clone()).unwrap().permission.is_none());
        raw["permission"] = Value::Null;
        assert!(serde_json::from_value::<SendSideMessageArgs>(raw.clone()).unwrap().permission.is_none());
        for mode in ["auto", "manual", "plan", "bypass"] {
            raw["permission"] = serde_json::json!(mode);
            assert_eq!(serde_json::from_value::<SendSideMessageArgs>(raw.clone()).unwrap().permission.as_deref(), Some(mode));
        }
        raw["permission"] = serde_json::json!(true);
        assert!(serde_json::from_value::<SendSideMessageArgs>(raw).is_err());
    }
    use serde_json::json;

    #[test]
    fn legacy_commands_also_recheck_device_revocation_and_closed_connections() {
        let db = crate::db::Db::open_at(std::path::Path::new(":memory:")).unwrap();
        db.web_device_touch("legacy", "test", 1).unwrap();
        db.web_device_approve("legacy", 2).unwrap();
        let context = super::super::RequestContext::from_handshake(&db, "legacy".into(), true);
        db.web_device_revoke("legacy").unwrap();
        for command in ["send_message", "terminal_write", "web_device_approve", "remove_workspace"] {
            assert!(authorize_collaboration_context(&db, command, &context).is_err());
        }
        let lan = super::super::RequestContext::from_handshake(&db, String::new(), true);
        lan.live.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(authorize_collaboration_context(&db, "send_message", &lan).is_err());
    }

    #[test]
    fn collaboration_controls_recheck_approval_origin_and_socket_lifetime() {
        let db = crate::db::Db::open_at(std::path::Path::new(":memory:")).unwrap();
        let commands = [
            ("active_run_ids", false),
            ("list_workspace_projects", false), ("save_workspace_project", true),
            ("get_session_sidebar_workspaces", false), ("assign_session_sidebar_workspaces", true),
            ("remove_workspace_project", true), ("plugin_publish_workspace_project", true),
            ("list_image_preview_grants", false), ("image_preview_scope", false),
            ("read_preview_image", false), ("revoke_image_preview_grant", true),
            ("task_snapshot", false), ("task_branch_action", true),
            ("task_group_action", true), ("list_plan_reviews", false),
            ("respond_plan_review", true), ("runtime_worker_plan_review", true), ("mcp_inventory", false), ("mcp_set_enabled", true),
            ("mcp_probe", true), ("skills_hub_query", false), ("skills_hub_mutate", true),
            ("grant_scope", false), ("grant_root", true), ("list_granted_roots", false),
            ("revoke_granted_root", true), ("add_workspace", true), ("plugin_add_workspace", true),
            ("plugin_agent_start", true), ("plugin_agent_interrupt", true), ("plugin_http_request", true),
            ("plugin_exec_run", true), ("plugin_exec_spawn", true), ("plugin_exec_kill", true),
            ("plugin_storage_set", true), ("plugin_storage_delete", true), ("plugin_storage_get", false),
            ("plugin_list", false), ("plugin_read_file", false), ("plugin_read_artwork", false),
            ("cli_version_status", false), ("cli_update_plan", false), ("cli_update_snapshot", false), ("cli_update", true),
            ("dsh_host_status", false), ("dsh_host_start", true), ("dsh_host_stop", true),
            ("pi_family_auth_list", false), ("pi_family_models_config_read", false),
            ("pi_family_auth_set_api_key", true), ("pi_family_auth_delete_credential", true), ("pi_family_models_config_write", true),
            ("claude_quota_read", false), ("codex_quota_read", false), ("codex_context_window_read", false), ("codex_context_window_write", true), ("agy_quota_read", false), ("agy_vertex_credits_read", false), ("throughput_stats_read", false), ("git_worktree_list", false), ("git_worktree_creation_snapshot", false),
            ("git_branch_merged", false), ("git_resolve_pr", false), ("git_worktree_create", true),
            ("git_worktree_create_cancel", true), ("git_worktree_remove", true),
            ("plugin_install_from_path", true), ("plugin_install_from_marketplace", true),
            ("plugin_set_enabled", true), ("plugin_uninstall", true), ("plugin_reload", true),
            ("creator_skill_install", true), ("web_device_rename", true), ("rotate_web_pair_key", true), ("remote_control_active", false),
            ("upsert_provider", true), ("delete_provider", true), ("set_current_provider", true),
            ("reorder_providers", true), ("set_engine_enabled", true),
        ];
        for (command, write) in commands {
            assert_eq!(collaboration_write_required(command), Some(write), "{command}");
            let read_only = !write;
            db.web_device_touch("leader-device", "test browser", 1).unwrap();
            let pending = super::super::RequestContext::from_handshake(&db, "leader-device".into(), true);
            assert!(authorize_collaboration_context(&db, command, &pending).is_err());
            db.web_device_approve("leader-device", 2).unwrap();
            let context = super::super::RequestContext::from_handshake(&db, "leader-device".into(), true);
            assert!(authorize_collaboration_context(&db, command, &context).is_ok());
            let foreign_origin = super::super::RequestContext::from_handshake(&db, "leader-device".into(), false);
            assert_eq!(authorize_collaboration_context(&db, command, &foreign_origin).is_ok(), read_only);
            db.web_device_revoke("leader-device").unwrap();
            assert!(authorize_collaboration_context(&db, command, &context).is_err());
            db.web_device_touch("leader-device", "test browser", 3).unwrap();
            db.web_device_approve("leader-device", 4).unwrap();
            assert!(authorize_collaboration_context(&db, command, &context).is_err(), "old socket must not inherit a new approval");
            let closed = super::super::RequestContext::from_handshake(&db, "leader-device".into(), true);
            closed.live.store(false, std::sync::atomic::Ordering::SeqCst);
            assert!(authorize_collaboration_context(&db, command, &closed).is_err());
            db.web_device_revoke("leader-device").unwrap();

            // Legacy LAN-token access is already authenticated by the handshake.
            let lan = super::super::RequestContext::from_handshake(&db, String::new(), true);
            assert!(authorize_collaboration_context(&db, command, &lan).is_ok());
            lan.live.store(false, std::sync::atomic::Ordering::SeqCst);
            assert!(authorize_collaboration_context(&db, command, &lan).is_err());
            let no_origin = super::super::RequestContext::from_handshake(&db, String::new(), false);
            assert_eq!(authorize_collaboration_context(&db, command, &no_origin).is_ok(), read_only);
        }
        for excluded in ["unknown_command", "plugin_quarantine", "host_chat_ready", "spellcast_native_pin", "restart_app", "task_delete_branch"] {
            assert_eq!(collaboration_write_required(excluded), None);
        }
    }

    #[test]
    fn remote_management_args_preserve_explicit_host_targets_and_decisions() {
        let legacy: PluginInstallPathArgs = parse_args(&json!({"path":"/plugins/demo"})).unwrap();
        assert!(legacy.request_id.is_none());
        let install: PluginInstallMarketArgs = parse_args(&json!({"id":"demo","requestId":"attempt-2"})).unwrap();
        assert_eq!(install.request_id.as_deref(), Some("attempt-2"));
        let remove: WorktreeRemoveArgs = parse_args(&json!({"repoPath":"/repo","worktreePath":"/work","branch":null,"deleteBranch":false})).unwrap();
        assert_eq!(remove.repo_path, "/repo");
        assert_eq!(remove.worktree_path, "/work");
        assert!(remove.branch.is_none());
        assert!(!remove.delete_branch);
        assert!(parse_args::<WorktreeRemoveArgs>(&json!({"repoPath":"/repo","worktreePath":"/work"})).is_err());
        let pr: ResolvePrArgs = parse_args(&json!({"repoPath":"/repo","input":"https://github.com/a/b/pull/12","suggestedBranch":"pr-12","worktreePath":"/work"})).unwrap();
        assert_eq!(pr.suggested_branch, "pr-12");
        let plugin: PluginUninstallArgs = parse_args(&json!({"id":"demo","deleteData":false})).unwrap();
        assert!(!plugin.delete_data);
        assert!(parse_args::<PluginUninstallArgs>(&json!({"id":"demo"})).is_err());
        let enabled: PluginEnabledArgs = parse_args(&json!({"id":"demo","enabled":false})).unwrap();
        assert!(!enabled.enabled);
        let update: CliUpdateArgs = parse_args(&json!({"engine":"codex","runId":"run-1"})).unwrap();
        assert_eq!(update.run_id, "run-1");
        assert!(parse_args::<CliUpdateArgs>(&json!({"engine":"codex","runId":"run-1","command":"arbitrary shell"})).is_err());
    }

    #[test]
    fn remote_credentials_and_quota_use_native_wire_contracts() {
        let credential: PiCredentialArgs = parse_args(&json!({"engine":"pi","providerId":"provider","key":"test-key"})).unwrap();
        assert_eq!(credential.provider_id, "provider");
        assert_eq!(credential.key, "test-key");
        assert!(parse_args::<PiCredentialArgs>(&json!({"engine":"pi","providerId":"provider","key":"test-key","path":"/arbitrary"})).is_err());
        let models: PiModelsArgs = parse_args(&json!({"engine":"omp","text":"# keep comments\nproviders: {}"})).unwrap();
        assert!(models.text.contains('\n'));
        let defaults: QuotaArgs = parse_args(&json!({})).unwrap();
        assert!(defaults.cache_only.is_none());
        let quota: QuotaArgs = parse_args(&json!({"cacheOnly":true,"force":false,"providerId":"p","workspacePath":"/ws"})).unwrap();
        assert_eq!(quota.cache_only, Some(true));
        assert_eq!(quota.force, Some(false));
        assert_eq!(quota.workspace_path.as_deref(), Some("/ws"));
        let totals: ThroughputStatsArgs = parse_args(&json!({"engine":"codex","sessionId":"thread","workspacePath":"/ws"})).unwrap();
        assert_eq!(totals.engine.as_deref(), Some("codex"));
        assert_eq!(totals.session_id.as_deref(), Some("thread"));
        assert_eq!(totals.workspace_path.as_deref(), Some("/ws"));
        assert!(parse_args::<ThroughputStatsArgs>(&json!({})).is_ok());
        assert!(parse_args::<ThroughputStatsArgs>(&json!({"sessionId":42})).is_err());
        assert!(parse_args::<ThroughputStatsArgs>(&json!({"database":"/arbitrary"})).is_err());
    }

    #[test]
    fn leader_web_args_preserve_identity_actions_and_ttl() {
        let identity = json!({"engine":"claude","sessionId":"parent","workspacePath":"/ws"});
        for action in ["archive", "restore", "delete"] {
            let mut group = identity.clone();
            group["action"] = json!(action);
            assert_eq!(parse_args::<LeaderGroupArgs>(&group).unwrap().action, action);
        }
        let mut branch = json!({"parentEngine":"codex","parentSessionId":"parent","workspacePath":"/ws","branchId":"child","action":"renew"});
        assert!(parse_args::<LeaderBranchArgs>(&branch).unwrap().ttl_seconds.is_none());
        branch["ttlSeconds"] = json!(3600);
        assert_eq!(parse_args::<LeaderBranchArgs>(&branch).unwrap().ttl_seconds, Some(3600));
        branch["ttlSeconds"] = json!(-1);
        assert!(parse_args::<LeaderBranchArgs>(&branch).is_err());
    }

    #[test]
    fn plan_review_web_args_keep_revision_and_decision_contract() {
        for decision in ["approve", "request_changes", "defer"] {
            let raw = json!({"planId":"plan-1","expectedRevision":3,"decision":decision,"feedback":"收紧范围"});
            let args: RespondPlanReviewArgs = parse_args(&raw).unwrap();
            assert_eq!(args.plan_id, "plan-1");
            assert_eq!(args.expected_revision, 3);
            assert_eq!(args.feedback.as_deref(), Some("收紧范围"));
            let expected = match decision {
                "approve" => crate::engine::plan_review::PlanDecision::Approve,
                "request_changes" => crate::engine::plan_review::PlanDecision::RequestChanges,
                "defer" => crate::engine::plan_review::PlanDecision::Defer,
                _ => unreachable!(),
            };
            assert_eq!(args.decision, expected);
        }
        assert!(parse_args::<RespondPlanReviewArgs>(&json!({"planId":"p","decision":"approve"})).is_err());
        assert!(parse_args::<RespondPlanReviewArgs>(&json!({"planId":"p","expectedRevision":1,"decision":"force"})).is_err());
    }

    #[test]
    fn mcp_args_keep_native_requests_and_conflict_errors() {
        let inventory: McpInventoryArgs = parse_args(&json!({"workspace":"/ws"})).unwrap();
        assert_eq!(inventory.workspace.as_deref(), Some("/ws"));
        assert!(parse_args::<McpInventoryArgs>(&json!({})).unwrap().workspace.is_none());
        let toggle: McpSetEnabledArgs = parse_args(&json!({"request":{
            "entryId":"claude_project:tools", "enabled":false, "version":"rev-3", "workspace":"/ws"
        }})).unwrap();
        assert_eq!(toggle.request.entry_id, "claude_project:tools");
        assert!(!toggle.request.enabled);
        assert_eq!(toggle.request.version, "rev-3");
        assert_eq!(toggle.request.workspace.as_deref(), Some("/ws"));
        let probe: McpProbeArgs = parse_args(&json!({"request":{"entryId":"codex_user:tools"}})).unwrap();
        assert_eq!(probe.request.entry_id, "codex_user:tools");
        assert!(probe.request.workspace.is_none());
        assert!(parse_args::<McpSetEnabledArgs>(&json!({"entryId":"x","enabled":true})).is_err());
        assert!(parse_args::<McpSetEnabledArgs>(&json!({"request":{"entryId":"x","enabled":true}})).is_err());
        assert!(parse_args::<McpProbeArgs>(&json!({"request":{}})).is_err());
        let error = ser_native_error::<Value, _>(Err(crate::mcp::McpError::conflict("changed"))).unwrap_err();
        assert_eq!(serde_json::from_str::<Value>(&error).unwrap(), json!({"code":"conflict","message":"changed"}));
    }

    #[test]
    fn skills_args_preserve_query_and_mutation_payloads() {
        let query: SkillsQueryArgs = parse_args(&json!({"mode":"search","params":{"q":"调试","offset":20}})).unwrap();
        assert_eq!(query.mode, "search");
        assert_eq!(query.params, json!({"q":"调试","offset":20}));
        let mutation: SkillsMutationArgs = parse_args(&json!({"action":"set_targets","payload":{"id":"skill","targets":["claude","codex"]}})).unwrap();
        assert_eq!(mutation.action, "set_targets");
        assert_eq!(mutation.payload, json!({"id":"skill","targets":["claude","codex"]}));
        assert!(parse_args::<SkillsQueryArgs>(&json!({"mode":"installed"})).is_err());
        assert!(parse_args::<SkillsMutationArgs>(&json!({"action":"uninstall","id":"skill"})).is_err());
    }

    #[test]
    fn grant_args_accept_only_host_path_and_workspace_keeps_registration_fields() {
        let grant: GrantPathArgs = parse_args(&json!({"path":"C:/主机/work"})).unwrap();
        assert_eq!(grant.path, "C:/主机/work");
        assert!(parse_args::<GrantPathArgs>(&json!({"path":"/ws","device":"spoofed"})).is_err());
        assert!(parse_args::<GrantPathArgs>(&json!({})).is_err());
        let workspace: PathArgs = parse_args(&json!({"path":"/ws","kind":"worktree","parentId":"parent"})).unwrap();
        assert_eq!(workspace.kind.as_deref(), Some("worktree"));
        assert_eq!(workspace.parent_id.as_deref(), Some("parent"));
    }

    #[test]
    fn plugin_agent_args_keep_identity_options_and_owned_run_id() {
        let mut raw = json!({"pluginId":"tools","engine":"claude","prompt":"hello","workspacePath":"/ws"});
        let defaults: PluginAgentStartArgs = parse_args(&raw).unwrap();
        assert!(defaults.model.is_none() && defaults.provider_id.is_none() && defaults.session_id.is_none());
        assert!(defaults.read_only.is_none() && defaults.request_id.is_none());
        raw["model"] = json!("model-1");
        raw["providerId"] = json!("provider-1");
        raw["sessionId"] = json!("native-1");
        raw["readOnly"] = json!(false);
        raw["requestId"] = json!("0123456789abcdef0123456789abcdef");
        let args: PluginAgentStartArgs = parse_args(&raw).unwrap();
        assert_eq!((args.plugin_id.as_str(), args.engine.as_str(), args.prompt.as_str(), args.workspace_path.as_str()), ("tools","claude","hello","/ws"));
        assert_eq!(args.model.as_deref(), Some("model-1"));
        assert_eq!(args.provider_id.as_deref(), Some("provider-1"));
        assert_eq!(args.session_id.as_deref(), Some("native-1"));
        assert_eq!(args.read_only, Some(false));
        assert_eq!(args.request_id.as_deref(), Some("0123456789abcdef0123456789abcdef"));
        let stop: PluginAgentInterruptArgs = parse_args(&json!({"pluginId":"tools","runId":"pa-tools-0123456789abcdef0123456789abcdef"})).unwrap();
        assert_eq!(stop.plugin_id, "tools");
        assert_eq!(stop.run_id, "pa-tools-0123456789abcdef0123456789abcdef");
        assert!(parse_args::<PluginAgentInterruptArgs>(&json!({"pluginId":"tools","sessionId":"native"})).is_err());
        raw["permissions"] = json!(["agent"]);
        assert!(parse_args::<PluginAgentStartArgs>(&raw).is_err());
    }

    #[test]
    fn plugin_egress_args_keep_network_and_process_contracts() {
        let http: PluginHttpArgs = parse_args(&json!({"pluginId":"tools","method":"POST","url":"https://example.com/tool","headers":{"Content-Type":"text/plain"},"body":"你好"})).unwrap();
        assert_eq!((http.plugin_id.as_str(), http.method.as_str(), http.url.as_str()), ("tools","POST","https://example.com/tool"));
        assert_eq!(http.headers.unwrap().get("Content-Type").map(String::as_str), Some("text/plain"));
        assert_eq!(http.body.as_deref(), Some("你好"));
        let run: PluginExecRunArgs = parse_args(&json!({"pluginId":"tools","bin":"node","args":["tool.js"],"env":{"MODE":"test"},"timeoutMs":250})).unwrap();
        assert_eq!((run.plugin_id.as_str(),run.bin.as_str()), ("tools","node"));
        assert_eq!(run.args, vec!["tool.js"]);
        assert_eq!(run.env.unwrap().get("MODE").map(String::as_str), Some("test"));
        assert_eq!(run.timeout_ms, Some(250));
        let spawn: PluginExecSpawnArgs = parse_args(&json!({"pluginId":"tools","bin":"node","args":[],"lifecycle":"plugin"})).unwrap();
        assert_eq!((spawn.plugin_id.as_str(),spawn.bin.as_str()), ("tools","node"));
        assert!(spawn.args.is_empty() && spawn.env.is_none());
        assert_eq!(spawn.lifecycle.as_deref(), Some("plugin"));
        let kill: PluginExecKillArgs = parse_args(&json!({"pluginId":"tools"})).unwrap();
        assert_eq!(kill.plugin_id, "tools");
        assert_eq!(kill.only_exited, None);
        let reap: PluginExecKillArgs = parse_args(&json!({"pluginId":"tools","onlyExited":true})).unwrap();
        assert_eq!(reap.only_exited, Some(true));
        assert!(parse_args::<PluginExecRunArgs>(&json!({"pluginId":"tools","bin":"node","args":[],"timeoutMs":-1})).is_err());
        assert!(parse_args::<PluginExecSpawnArgs>(&json!({"pluginId":"tools","bin":"node"})).is_err());
        assert!(parse_args::<PluginExecKillArgs>(&json!({"pluginId":"tools","pid":42})).is_err());
        assert!(parse_args::<PluginExecKillArgs>(&json!({"pluginId":"tools","onlyExited":"true"})).is_err());
    }

    #[test]
    fn plugin_storage_args_preserve_json_values_and_native_id_key() {
        let set: PluginStorageSetArgs = parse_args(&json!({"id":"tools","key":"state","value":{"selected":[1,null,"中文"]}})).unwrap();
        assert_eq!((set.id.as_str(),set.key.as_str()), ("tools","state"));
        assert_eq!(set.value, json!({"selected":[1,null,"中文"]}));
        let delete: PluginStorageGetArgs = parse_args(&json!({"id":"tools","key":"state"})).unwrap();
        assert_eq!((delete.id.as_str(),delete.key.as_str()), ("tools","state"));
        assert!(parse_args::<PluginStorageSetArgs>(&json!({"pluginId":"tools","key":"state","value":true})).is_err());
        assert!(parse_args::<PluginStorageGetArgs>(&json!({"id":"tools"})).is_err());
    }

    #[test]
    fn claude_ultracode_wire_args_preserve_false_true_and_omitted() {
        let mut raw = json!({"engine":"claude", "workspacePath":"/ws", "prompt":"hi"});
        assert_eq!(parse_args::<SendMessageArgs>(&raw).unwrap().claude_ultracode, None);
        for enabled in [false, true] {
            raw["claudeUltracode"] = json!(enabled);
            assert_eq!(parse_args::<SendMessageArgs>(&raw).unwrap().claude_ultracode, Some(enabled));
            let remembered: RememberClaudeUltracodeArgs = parse_args(
                &json!({"sessionId":"native-id", "enabled":enabled}),
            ).unwrap();
            assert_eq!(remembered.session_id, "native-id");
            assert_eq!(remembered.enabled, enabled);
        }
        assert!(parse_args::<RememberClaudeUltracodeArgs>(&json!({"sessionId":"s"})).is_err());
    }

    #[test]
    fn codex_context_args_require_explicit_values_and_reject_extra_files() {
        let read: CodexContextArgs = parse_args(&json!({"providerId":null,"workspacePath":"C:/fixture"})).unwrap();
        assert_eq!(read.workspace_path.as_deref(), Some("C:/fixture"));
        let write: CodexContextWriteArgs = parse_args(&json!({"contextWindow":500000,"autoCompactTokenLimit":400000})).unwrap();
        assert_eq!(write.context_window, json!(500000));
        assert_eq!(write.auto_compact_token_limit, json!(400000));
        let reset: CodexContextWriteArgs = parse_args(&json!({"contextWindow":null,"autoCompactTokenLimit":null})).unwrap();
        assert!(reset.context_window.is_null());
        assert!(parse_args::<CodexContextWriteArgs>(&json!({})).is_err());
        assert!(parse_args::<CodexContextWriteArgs>(&json!({"contextWindow":null})).is_err());
        assert!(parse_args::<CodexContextWriteArgs>(&json!({"contextWindow":null,"autoCompactTokenLimit":null,"files":["auth.json"]})).is_err());
    }

    #[test]
    fn claude_haiku_assist_wire_args_default_off_and_validate_boolean() {
        let mut raw = json!({"engine":"claude", "workspacePath":"/ws", "prompt":"hi", "model":"opus", "permission":"manual"});
        assert_eq!(parse_args::<SendMessageArgs>(&raw).unwrap().claude_haiku_assist, None);
        for enabled in [false, true] {
            raw["claudeHaikuAssist"] = json!(enabled);
            let args: SendMessageArgs = parse_args(&raw).unwrap();
            assert_eq!(args.claude_haiku_assist, Some(enabled));
            assert_eq!(args.model.as_deref(), Some("opus"));
            assert_eq!(args.permission.as_deref(), Some("manual"));
        }
        raw["claudeHaikuAssist"] = json!("true");
        assert!(parse_args::<SendMessageArgs>(&raw).is_err());
    }

    #[test]
    fn stop_native_task_args_follow_the_desktop_wire_shape() {
        let a: StopNativeTaskArgs = parse_args(&json!({"runId":"run-1", "taskId":"bg-2"})).unwrap();
        assert_eq!((a.run_id.as_str(), a.task_id.as_str()), ("run-1", "bg-2"));
        assert!(parse_args::<StopNativeTaskArgs>(&json!({"sessionId":"s", "taskId":"bg"})).is_err());
        assert!(parse_args::<StopNativeTaskArgs>(&json!({"runId":"r"})).is_err());
    }

    /// The remote UI sends the same camelCase args as the desktop invoke;
    /// `imagePaths` is null/absent for a text-only message.
    #[test]
    fn send_follow_up_args_follow_the_desktop_wire_shape() {
        let a: SendFollowUpArgs = parse_args(&json!({
            "sessionId": "run-1",
            "engine": "claude",
            "workspacePath": "/ws",
            "prompt": "hi",
            "imagePaths": ["a.png"],
        }))
        .unwrap();
        assert_eq!(
            (a.session_id.as_str(), a.engine.as_str(), a.workspace_path.as_str(), a.prompt.as_str()),
            ("run-1", "claude", "/ws", "hi")
        );
        assert_eq!(a.image_paths, Some(vec!["a.png".to_string()]));
        for body in [
            json!({"sessionId":"s","engine":"claude","workspacePath":"/ws","prompt":"p","imagePaths":null}),
            json!({"sessionId":"s","engine":"claude","workspacePath":"/ws","prompt":"p"}),
        ] {
            assert!(parse_args::<SendFollowUpArgs>(&body).unwrap().image_paths.is_none());
        }
        assert!(parse_args::<SendFollowUpArgs>(&json!({"sessionId":"s"})).is_err());
    }
}
