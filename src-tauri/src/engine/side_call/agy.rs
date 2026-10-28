//! Restricted AGY observer sessions. No ordinary chat launch or history indexing.
//! The CLI retains its internal finish/task bookkeeping and auxiliary title call.
use super::{SideCallError, SideCallOutput, StructuredCall};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::{Path, PathBuf}, time::Duration};
use tokio::process::Command;
use tokio::time::Instant;

const AGENT: &str = "ccgui-notice";
mod staging;
pub(crate) use staging::cleanup_orphans;
pub(super) use staging::{before_spawn, spawned};
const AGENT_HEADER: &str = "---\nname: ccgui-notice\ndescription: Restricted structured observer\nmainAgent: true\nsubagent: false\nmodel: inherit\ntools: [finish]\nexcludeDefaultComponents: true\ninheritCustomizations: false\ninheritMcp: false\ncommandExecutionPolicy: \"off\"\n---\n";

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    model_provider: Option<String>,
}

struct Context {
    bin: String,
    env: HashMap<String, String>,
    settings: NativeSettings,
}

pub(crate) fn configuration_fingerprint() -> Option<[u8;32]> {
    let context = context(None).ok()?;
    let bin = crate::engine::resolve::resolve_launchable_cli_binary(&context.bin);
    let metadata = std::fs::metadata(&bin).ok()?;
    if !metadata.is_file() { return None; }
    let environment = context.env.iter().collect::<std::collections::BTreeMap<_,_>>();
    let bytes = serde_json::to_vec(&(&bin,metadata.len(),metadata.modified().ok(),context.settings,environment)).ok()?;
    Some(Sha256::digest(bytes).into())
}

/// Cancellation closes the process job before this guard drops, but Windows
/// may release SQLite/log handles slightly later. Retry only this owned root.
struct PrivateStaging {
    root: PathBuf,
    lease: Option<std::fs::File>,
}
impl Drop for PrivateStaging {
    fn drop(&mut self) {
        // Closing the lease also works on process death; startup can reclaim it.
        let lease = self.lease.take();
        if remove_staging(&self.root) { return; }
        let root = self.root.clone();
        let _ = std::thread::Builder::new().name("agy-observer-cleanup".into()).spawn(move || {
            let _lease = lease;
            for _ in 0..20 {
                std::thread::sleep(Duration::from_millis(100));
                if remove_staging(&root) { return; }
            }
            eprintln!("[side-call] agy temporary cleanup incomplete");
        });
    }
}
fn remove_staging(path: &Path) -> bool {
    staging::remove_payload_then_markers(path)
}

fn context(provider_id: Option<&str>) -> Result<Context, SideCallError> {
    let fail = || SideCallError::Unavailable;
    let config = crate::config::read_config().map_err(|_| fail())?;
    let section = config.section("agy").ok_or_else(fail)?;
    let selected = provider_id.or(section.current.as_deref()).unwrap_or("").trim();
    if selected == crate::config::DISABLED_PROVIDER_ID { return Err(fail()); }
    let native = matches!(selected, "" | crate::config::LOCAL_PROVIDER_ID | crate::config::LEGACY_LOCAL_CONFIG_TOML_ID);
    let (settings, env) = if native {
        let file = crate::engine::agy::agy_home().join("settings.json");
        let settings = match std::fs::metadata(&file) {
            Ok(metadata) if metadata.len() <= 256 * 1024 => {
                serde_json::from_slice::<NativeSettings>(&std::fs::read(file).map_err(|_| fail())?).map_err(|_| fail())?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => NativeSettings::default(),
            _ => return Err(fail()),
        };
        if settings.model_provider.as_deref().is_some_and(|provider| !matches!(provider, "gemini" | "antigravity")) {
            return Err(fail());
        }
        (settings, HashMap::new())
    } else {
        let (_, provider) = crate::config::find_provider(section, selected).map_err(|_| fail())?.ok_or_else(fail)?;
        let env = crate::provider_files::channel_env("agy", provider).map_err(|_| fail())?;
        // Never fall back from an incomplete BYOK channel to the subscription.
        if env.get("GEMINI_API_KEY").is_none_or(|key| key.trim().is_empty())
            || env.get("GOOGLE_GEMINI_BASE_URL").is_none_or(|url| url.trim().is_empty()) {
            return Err(fail());
        }
        (NativeSettings { model_provider: Some("gemini".into()) }, env)
    };
    let settings_app = crate::settings::read_settings().map_err(|_| fail())?;
    let bin = crate::engine::engine_bin(&settings_app, "agy");
    Ok(Context { bin, env, settings })
}

/// Child-local homes keep even live AGY indexes outside the host scanner's roots.
pub(super) fn isolate_homes(command: &mut Command, home: &Path) {
    for key in ["HOME", "USERPROFILE"] { command.env(key, home); }
    for (key, suffix) in [
        ("APPDATA", "AppData/Roaming"), ("LOCALAPPDATA", "AppData/Local"),
        ("XDG_CONFIG_HOME", ".config"), ("XDG_DATA_HOME", ".local/share"),
        ("XDG_CACHE_HOME", ".cache"), ("ANTIGRAVITY_GEMINI_DIR", ".gemini"),
        ("ANTIGRAVITY_HOME", ".gemini/antigravity-cli"),
        ("TMP", "tmp"), ("TEMP", "tmp"),
    ] { command.env(key, home.join(suffix)); }
    command.env("ANTIGRAVITY_CONFIG_REL_DIR", "config");
    command.env_remove("AGY_HOME");
    command.env_remove("ANTIGRAVITY_APP_DATA_DIR");
    crate::engine::agy::configure_background_command(command);
}

fn stage(root: &Path, call: &StructuredCall<'_>, settings: &NativeSettings) -> Result<(PathBuf, PathBuf), SideCallError> {
    let home = root.join("home");
    let cwd = root.join("workspace");
    for directory in [cwd.clone(), home.join("tmp"), home.join(".gemini/config/agents"), home.join(".gemini/antigravity-cli")] {
        std::fs::create_dir_all(directory).map_err(|_| SideCallError::Unavailable)?;
    }
    std::fs::write(home.join(".gemini/config/agents/ccgui-notice.md"), format!("{AGENT_HEADER}\n{}\n", call.system_prompt))
        .map_err(|_| SideCallError::Unavailable)?;
    std::fs::write(home.join(".gemini/antigravity-cli/settings.json"), serde_json::to_vec(settings).map_err(|_| SideCallError::Unavailable)?)
        .map_err(|_| SideCallError::Unavailable)?;
    Ok((home, cwd))
}

fn command(context: &Context, home: &Path) -> Command {
    let mut command = crate::engine::command_for_binary(&context.bin);
    command.envs(&context.env);
    if context.settings.model_provider.as_deref() == Some("gemini") {
        for key in ["AGY_ADC_AUTH", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI"] { command.env_remove(key); }
    }
    isolate_homes(&mut command, home);
    command
}

fn request_command(context: &Context, home: &Path, call: &StructuredCall<'_>) -> Command {
    let mut command = command(context, home);
    command.args(["--app_data_dir", "antigravity-cli", "--agent", AGENT,
        "--disable-slash-commands", "--input-format", "stream-json", "--output-format", "stream-json",
        "--json-schema"]).arg(call.json_schema.to_string());
    // The shared outer deadline kills the tree. No CLI partial-success timeout.
    command.args(["--print-timeout", "0"]);
    if !call.model.is_empty() { command.arg("--model").arg(call.model); }
    if let Some(effort) = crate::engine::agy::effort_flag(Some(call.effort), call.model) {
        command.arg("--effort").arg(effort);
    }
    command
}

fn version_result(stdout: &[u8]) -> Result<SideCallOutput, SideCallError> {
    let text = std::str::from_utf8(stdout).map_err(|_| SideCallError::Unavailable)?;
    let supported = text.split_whitespace().any(|word| {
        let version = word.trim_start_matches('v').split('.').map(str::parse::<u32>).collect::<Result<Vec<_>, _>>();
        version.is_ok_and(|v| v.len() == 3 && (v[0], v[1], v[2]) >= (1, 3, 4))
    });
    if !supported { return Err(SideCallError::Unavailable); }
    Ok(SideCallOutput { structured: json!({}), usage: None })
}

fn parse_result(stdout: &[u8]) -> Result<SideCallOutput, SideCallError> {
    let text = std::str::from_utf8(stdout).map_err(|_| SideCallError::BadOutput)?;
    let mut initialized = false;
    let mut result = None;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let event: Value = serde_json::from_str(line).map_err(|_| SideCallError::BadOutput)?;
        match event.get("event").and_then(Value::as_str) {
            Some("init") => {
                if initialized || event.pointer("/init/agent").and_then(Value::as_str) != Some(AGENT) {
                    return Err(SideCallError::Unavailable);
                }
                initialized = true;
            }
            Some("result") if initialized && result.is_none() => {
                let payload = event.get("result").ok_or(SideCallError::BadOutput)?;
                if payload.get("status").and_then(Value::as_str) != Some("SUCCESS")
                    || payload.get("error").is_some_and(|value| !value.is_null()) {
                    return Err(SideCallError::Failed);
                }
                result = Some(SideCallOutput {
                    structured: payload.get("structured_output").filter(|value| value.is_object()).cloned().ok_or(SideCallError::BadOutput)?,
                    usage: payload.get("usage").cloned(),
                });
            }
            Some("step_update") if initialized && result.is_none() => {}
            _ => return Err(SideCallError::BadOutput),
        }
    }
    result.ok_or(SideCallError::BadOutput)
}

pub(crate) async fn structured(call: StructuredCall<'_>) -> Result<SideCallOutput, SideCallError> {
    if call.input.len() > 16 * 1024 || call.system_prompt.len() > 16 * 1024
        || call.model.is_empty() || call.model.len() > 256 || call.model.starts_with('-')
        || call.model.chars().any(|c| c.is_control() || c.is_whitespace())
        || !matches!(call.effort, "low" | "medium" | "high") {
        return Err(SideCallError::Unavailable);
    }
    let context = context(call.provider_id)?;
    staging::cleanup_orphans();
    let root = std::env::temp_dir().join(format!("ccgui-observer-agy-{}", uuid::Uuid::new_v4()));
    execute_in(context, call, &root).await
}

async fn execute_in(context: Context, call: StructuredCall<'_>, root: &Path) -> Result<SideCallOutput, SideCallError> {
    let deadline = Instant::now() + call.timeout;
    let _cleanup = staging::create(root)?;
    let (home, cwd) = stage(&root, &call, &context.settings)?;
    let mut version = command(&context, &home);
    version.arg("--version");
    super::run_with_parser_in_home("agy", version, &cwd, "", Duration::from_secs(5).min(call.timeout), version_result, Some(&home)).await?;
    let input = format!("{}\n", json!({"event":"user","message":{"content":call.input}}));
    let remaining = deadline.checked_duration_since(Instant::now()).ok_or(SideCallError::Timeout)?;
    super::run_with_parser_in_home("agy", request_command(&context, &home, &call), &cwd, &input, remaining, parse_result, Some(&home)).await
}

#[cfg(test)]
mod tests;
