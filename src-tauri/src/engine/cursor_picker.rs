//! Cursor 模型选择：基础模型 id 加参数。参数随本次启动写入 CLI 自己的
//! `cli-config.json`，因为 headless `--model` 还不接受括号覆盖。

use serde_json::{Map, Value};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

const LAUNCH_SEPARATOR: char = '\u{1e}';

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorParameterOption {
    pub value: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorParameter {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    pub options: Vec<CursorParameterOption>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPickerModel {
    pub id: String,
    pub name: String,
    pub parameters: Vec<CursorParameter>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CursorLaunch {
    pub model_id: String,
    pub parameters: Vec<(String, String)>,
}

fn valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn valid_param(id: &str, value: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
        && !value.is_empty()
        && value.len() <= 32
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

/// 解析前端临时拼上的参数。没有分隔符时就是普通模型 id。
pub fn split_launch_model(raw: &str) -> Result<CursorLaunch, String> {
    let raw = raw.trim();
    let Some((model_id, encoded)) = raw.split_once(LAUNCH_SEPARATOR) else {
        if !valid_model_id(raw) {
            return Err("invalid cursor model".into());
        }
        return Ok(CursorLaunch { model_id: raw.to_string(), parameters: Vec::new() });
    };
    if !valid_model_id(model_id) {
        return Err("invalid cursor model".into());
    }
    let parsed = serde_json::from_str::<Map<String, Value>>(encoded).map_err(|_| "invalid cursor model parameters")?;
    if parsed.len() > 8 {
        return Err("too many cursor model parameters".into());
    }
    let mut parameters = Vec::new();
    for (id, value) in parsed {
        let Some(value) = value.as_str() else {
            return Err("invalid cursor model parameters".into());
        };
        if !valid_param(&id, value) {
            return Err("invalid cursor model parameters".into());
        }
        parameters.push((id, value.to_string()));
    }
    Ok(CursorLaunch { model_id: model_id.to_string(), parameters })
}

pub fn cli_model_flag(model_id: &str) -> &str {
    if model_id == "default" { "auto" } else { model_id }
}

/// 只改模型选择字段，保留登录和其他配置。
pub fn write_model_selection(path: &Path, model_id: &str, parameters: &[(String, String)]) -> Result<(), String> {
    // 【cursor模型】空参数表示这个模型没有上下文或 Fast，仍要改掉当前选中模型。
    if !valid_model_id(model_id) || parameters.len() > 8 {
        return Err("invalid cursor model parameters".into());
    }
    if parameters.iter().any(|(id, value)| !valid_param(id, value)) {
        return Err("invalid cursor model parameters".into());
    }
    let original = std::fs::read(path).map_err(|_| "Cursor model settings are unavailable".to_string())?;
    let mut root: Value = serde_json::from_slice(&original).map_err(|_| "Cursor model settings are unavailable".to_string())?;
    let Some(root_object) = root.as_object_mut() else {
        return Err("Cursor model settings are unavailable".into());
    };
    let params = Value::Array(parameters.iter().map(|(id, value)| {
        let mut entry = Map::new();
        entry.insert("id".into(), Value::String(id.clone()));
        entry.insert("value".into(), Value::String(value.clone()));
        Value::Object(entry)
    }).collect());
    let mut selected = Map::new();
    selected.insert("modelId".into(), Value::String(model_id.to_string()));
    selected.insert("parameters".into(), params.clone());
    root_object.insert("selectedModel".into(), Value::Object(selected));
    let slot = root_object.entry("modelParameters").or_insert_with(|| Value::Object(Map::new()));
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    let Some(slot) = slot.as_object_mut() else {
        return Err("Cursor model settings are unavailable".into());
    };
    slot.insert(model_id.to_string(), params);
    if let Some(model) = root_object.get_mut("model").and_then(Value::as_object_mut) {
        model.insert("modelId".into(), Value::String(model_id.to_string()));
        model.insert("displayModelId".into(), Value::String(model_id.to_string()));
    }
    let pretty = serde_json::to_vec_pretty(&root).map_err(|_| "Cursor model settings are unavailable".to_string())?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, &pretty).map_err(|_| "Cursor model settings are unavailable".to_string())?;
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(path);
        if std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::write(path, &original);
            let _ = std::fs::remove_file(&tmp);
            return Err("Cursor model settings are unavailable".into());
        }
    }
    Ok(())
}

pub fn launch_model_arg(home: &Path, raw: &str) -> Result<String, String> {
    let launch = split_launch_model(raw)?;
    // 普通模型 id 不写配置。带分隔符时即使参数为空，也要切到这个基础模型。
    if raw.contains(LAUNCH_SEPARATOR) {
        write_model_selection(&home.join("cli-config.json"), &launch.model_id, &launch.parameters)?;
    }
    Ok(cli_model_flag(&launch.model_id).to_string())
}

fn option_name(value: &Value) -> Option<CursorParameterOption> {
    let value_text = value.get("value")?.as_str()?.trim();
    if !valid_param("context", value_text) && !valid_param("fast", value_text) {
        return None;
    }
    let name = value.get("name").and_then(Value::as_str).unwrap_or(value_text).trim();
    if name.is_empty() || name.len() > 64 {
        return None;
    }
    Some(CursorParameterOption { value: value_text.to_string(), name: name.to_string() })
}

/// ACP `cursor/list_available_models` 的结果。少于两个选项的参数不展示。
pub fn parse_catalog_result(result: &Value) -> Vec<CursorPickerModel> {
    let Some(models) = result.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    models.iter().filter_map(|model| {
        let id = model.get("value")?.as_str()?.trim();
        if !valid_model_id(id) {
            return None;
        }
        let name = model.get("name").and_then(Value::as_str).unwrap_or(id).trim();
        if name.is_empty() || name.len() > 80 {
            return None;
        }
        let parameters = model.get("configOptions").and_then(Value::as_array).map(|options| {
            options.iter().filter_map(|option| {
                let id = option.get("id")?.as_str()?.trim();
                let name = option.get("name").and_then(Value::as_str).unwrap_or(id).trim();
                if !valid_param(id, "x") || name.is_empty() || name.len() > 64 {
                    return None;
                }
                let choices = option.get("options").and_then(Value::as_array)?
                    .iter().filter_map(option_name).take(32).collect::<Vec<_>>();
                if choices.len() < 2 {
                    return None;
                }
                let current = option.get("currentValue").and_then(Value::as_str)
                    .filter(|value| choices.iter().any(|choice| choice.value == *value))
                    .map(str::to_string);
                Some(CursorParameter { id: id.to_string(), name: name.to_string(), current, options: choices })
            }).take(8).collect()
        }).unwrap_or_default();
        Some(CursorPickerModel { id: id.to_string(), name: name.to_string(), parameters })
    }).take(80).collect()
}

async fn read_result<R: AsyncRead + Unpin>(reader: &mut BufReader<R>, id: u64) -> Result<Value, String> {
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).await
            .map_err(|_| "Cursor model catalog closed".to_string())?;
        if read == 0 {
            return Err("Cursor model catalog closed".into());
        }
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            // ACP authentication-required has a stable code. Do not initiate
            // browser login while servicing a background model picker.
            return Err(if error.get("code").and_then(Value::as_i64) == Some(-32000) {
                "cursor_auth_required: Sign in to Cursor explicitly before refreshing models".into()
            } else {
                "Cursor model catalog failed".into()
            });
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
}

/// Own the whole launch, including cancellation while awaiting a reply.
struct CatalogProcess {
    child: Option<tokio::process::Child>,
    pid: u32,
    #[cfg(windows)]
    job: Option<std::sync::Arc<super::job::KillOnCloseJob>>,
}

impl CatalogProcess {
    fn stop_tree(&mut self) {
        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            drop(job);
            return;
        }
        if self.pid != 0 {
            super::kill_process_group(self.pid);
        }
    }

    async fn finish(mut self) {
        self.stop_tree();
        self.pid = 0;
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
    }
}

impl Drop for CatalogProcess {
    fn drop(&mut self) {
        self.stop_tree();
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            // Cancellation cannot await, but the owning runtime can reap the
            // direct child after the synchronous job/process-group sweep.
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                });
            }
        }
    }
}

async fn request_catalog_command(mut command: tokio::process::Command, budget: Duration) -> Result<Vec<CursorPickerModel>, String> {
    command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    super::hide_console(&mut command);
    let child = command.spawn().map_err(|_| "Cursor model catalog is unavailable".to_string())?;
    let mut process = CatalogProcess {
        pid: child.id().unwrap_or(0),
        #[cfg(windows)]
        job: super::job::assign_kill_on_close(&child),
        child: Some(child),
    };
    #[cfg(windows)]
    if process.job.is_none() {
        process.finish().await;
        return Err("Cursor model catalog process isolation is unavailable".into());
    }
    let result = tokio::time::timeout(budget, async {
    let child = process.child.as_mut().ok_or("Cursor model catalog is unavailable")?;
    let mut stdin = child.stdin.take().ok_or("Cursor model catalog is unavailable")?;
    let stdout = child.stdout.take().ok_or("Cursor model catalog is unavailable")?;
    let mut reader = BufReader::new(stdout);
    async fn call<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(stdin: &mut W, reader: &mut BufReader<R>, id: u64, method: &str, params: Option<Value>) -> Result<Value, String> {
        let mut message = Map::new();
        message.insert("jsonrpc".into(), Value::String("2.0".into()));
        message.insert("id".into(), Value::from(id));
        message.insert("method".into(), Value::String(method.to_string()));
        if let Some(params) = params {
            message.insert("params".into(), params);
        }
        let line = serde_json::to_string(&Value::Object(message)).map_err(|_| "Cursor model catalog failed".to_string())?;
        stdin.write_all(format!("{line}\n").as_bytes()).await.map_err(|_| "Cursor model catalog failed".to_string())?;
        stdin.flush().await.map_err(|_| "Cursor model catalog failed".to_string())?;
        read_result(reader, id).await
    }
    call(&mut stdin, &mut reader, 1, "initialize", Some(serde_json::json!({"protocolVersion": 1, "clientCapabilities": {}, "clientInfo": {"name": "ccgui", "version": "0"}}))).await?;
    let listed = call(&mut stdin, &mut reader, 3, "cursor/list_available_models", None).await?;
    drop(stdin);
    let models = parse_catalog_result(&listed);
    if models.is_empty() { Err("Cursor model catalog is empty".into()) } else { Ok(models) }
    }).await.unwrap_or_else(|_| Err("Cursor model catalog timed out".into()));
    process.finish().await;
    result
}

type CatalogResult = Result<Vec<CursorPickerModel>, String>;
struct CachedCatalog { bin: String, expires: Instant, result: CatalogResult }
type CatalogCache = tokio::sync::Mutex<Option<CachedCatalog>>;

async fn cached_catalog(cache: &CatalogCache, bin: &str, query: impl std::future::Future<Output = CatalogResult>) -> CatalogResult {
    // Holding this bounded, single-entry lock through the probe gives all
    // concurrent callers one answer without detached background login work.
    let mut cache = cache.lock().await;
    if let Some(entry) = cache.as_ref().filter(|entry| entry.bin == bin && Instant::now() < entry.expires) {
        return entry.result.clone();
    }
    let result = query.await;
    let ttl = if result.is_ok() { 60 } else { 10 };
    *cache = Some(CachedCatalog { bin: bin.into(), expires: Instant::now() + Duration::from_secs(ttl), result: result.clone() });
    result
}

pub async fn cursor_picker_catalog(bin: &str) -> Result<Vec<CursorPickerModel>, String> {
    static CACHE: OnceLock<CatalogCache> = OnceLock::new();
    cached_catalog(CACHE.get_or_init(Default::default), bin, async {
        let mut command = super::command_for_binary(bin);
        command.arg("acp");
        request_catalog_command(command, Duration::from_secs(20)).await
    }).await
}

/// Shared admission for both picker and generic background model catalogs.
pub(super) fn catalog_binary() -> Result<String, String> {
    if !crate::development_profile::automatic_integrations_allowed() {
        return Err("Cursor automatic model discovery is disabled in development profiles".into());
    }
    let config = crate::config::read_config()?;
    if config.section("cursor").and_then(|section| section.current.as_deref()) == Some(crate::config::DISABLED_PROVIDER_ID) {
        return Err("Cursor is disabled".into());
    }
    let settings = crate::settings::read_settings()?;
    Ok(super::engine_bin(&settings, "cursor"))
}

#[tauri::command]
pub async fn cursor_model_catalog() -> Result<Vec<CursorPickerModel>, String> {
    let bin = catalog_binary()?;
    cursor_picker_catalog(&bin).await
}

#[cfg(test)]
#[path = "cursor_picker_process_tests.rs"]
mod process_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_parameters_and_leaves_plain_ids() {
        let plain = split_launch_model("composer-2.5").unwrap();
        assert_eq!(plain.model_id, "composer-2.5");
        assert!(plain.parameters.is_empty());
        let encoded = split_launch_model("grok-4.7\u{1e}{\"context\":\"500k\",\"fast\":\"true\"}").unwrap();
        assert_eq!(encoded.parameters, vec![("context".into(), "500k".into()), ("fast".into(), "true".into())]);
        assert!(split_launch_model("grok-4.7\u{1e}{\"context\":\"500 k\"}").is_err());
    }

    #[test]
    fn writes_selection_without_dropping_auth() {
        let dir = std::env::temp_dir().join(format!("ccgui-cursor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cli-config.json");
        std::fs::write(&path, r#"{"authInfo":{"email":"kept@example.com"},"model":{"modelId":"old","displayModelId":"old"}}"#).unwrap();
        write_model_selection(&path, "grok-4.7", &[("context".into(), "500k".into())]).unwrap();
        let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["authInfo"]["email"], "kept@example.com");
        assert_eq!(saved["selectedModel"]["modelId"], "grok-4.7");
        assert_eq!(saved["selectedModel"]["parameters"][0]["value"], "500k");
        assert_eq!(saved["modelParameters"]["grok-4.7"][0]["id"], "context");
        assert_eq!(saved["model"]["modelId"], "grok-4.7");
        write_model_selection(&path, "gemini-3.1-pro", &[]).unwrap();
        let cleared: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(cleared["authInfo"]["email"], "kept@example.com");
        assert_eq!(cleared["model"]["modelId"], "gemini-3.1-pro");
        assert_eq!(cleared["selectedModel"]["parameters"].as_array().map(|items| items.len()), Some(0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_parameter_catalog_and_hides_single_options() {
        let result = serde_json::json!({"models": [
            {"value": "grok-4.7", "name": "Grok 4.7", "configOptions": [
                {"id": "context", "name": "Context", "currentValue": "256k", "options": [{"value": "256k", "name": "256K"}, {"value": "500k", "name": "500K"}]},
                {"id": "fast", "name": "Fast", "options": [{"value": "true", "name": "Fast"}]}
            ]},
            {"value": "auto", "name": ""}
        ]});
        let models = parse_catalog_result(&result);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].parameters.len(), 1);
        assert_eq!(models[0].parameters[0].id, "context");
    }
}
