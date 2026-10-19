//! Antigravity CLI → Vertex AI bridge.
//!
//! `agy` reaches a custom Gemini endpoint only through `"modelProvider":
//! "gemini"` in `settings.json`, `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL`,
//! and then always requests `{base}/v1beta/models/<model>:streamGenerateContent`.
//! Vertex serves the model at `/v1/projects/…/publishers/google/models/…` and
//! rejects `thinkingBudget` in favour of `thinkingLevel`. A loopback proxy owned
//! by the app translates between the two, so a send to the Vertex model is
//! billed to the Google Cloud project instead of the Antigravity subscription.
//!
//! * The real API key never reaches the agy process: agy only receives a
//!   per-run token, which the proxy checks and swaps for the key
//!   read from `~/.gemini/vertex-gemini-4-argon.txt` on every request.
//! * `modelProvider` lives in a dedicated agy data dir
//!   (`~/.gemini/antigravity-cli-vertex`, selected with `--app_data_dir`) whose
//!   `settings.json` is the user's own file plus that one key, so subscription
//!   sessions keep using the untouched native settings.
//! * A misconfigured Vertex route fails the send with a clear error. It never
//!   falls back to the subscription path, which would silently bill the wrong
//!   pool.

use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::Response,
    routing::any,
    Router,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

pub(crate) mod observer;

/// Model argument handed to `agy --model`. The segment after the scheme is
/// ignored by agy (it only needs `…/models/<name>`); it carries the effort.
pub(crate) const BRIDGE_PREFIX: &str = "gemini-api://ccgui-vertex/";
/// Relative to `~/.gemini`; agy refuses absolute `--app_data_dir` values.
const APP_DIR_NAME: &str = "antigravity-cli-vertex";
const KEY_FILE: &str = "vertex-gemini-4-argon.txt";
const DEFAULT_MODEL: &str = "gemini-4-argon";
const VERTEX_HOST: &str = "aiplatform.googleapis.com";
/// Request bodies carry the whole conversation (and inline images).
const MAX_REQUEST_BYTES: usize = 64 * 1024 * 1024;

/// Connection facts from the user's key file. No `Debug`: it holds the key.
#[derive(Clone)]
pub(crate) struct VertexTarget {
    project: String,
    location: String,
    pub(crate) model: String,
    api_key: String,
}

fn gemini_dir() -> PathBuf {
    super::engine_home(None, ".gemini")
}

pub(crate) fn app_home() -> PathBuf {
    gemini_dir().join(APP_DIR_NAME)
}

fn key_file_path() -> PathBuf {
    gemini_dir().join(KEY_FILE)
}

fn safe_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub(crate) fn parse_target(text: &str) -> Result<VertexTarget, String> {
    let (mut project, mut location, mut model, mut api_key) = (None, None, None, None);
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "project" => project = Some(value.to_string()),
            "location" => location = Some(value.to_string()),
            "model" => model = Some(value.to_string()),
            "api_key" => api_key = Some(value.to_string()),
            _ => {}
        }
    }
    let project = project.ok_or("Vertex key file has no project= line")?;
    let location = location.unwrap_or_else(|| "global".into());
    let model = model.unwrap_or_else(|| DEFAULT_MODEL.into());
    let api_key = api_key.ok_or("Vertex key file has no api_key= line")?;
    if !safe_segment(&project) || !safe_segment(&location) || !safe_segment(&model) {
        return Err("Vertex key file project/location/model contain unsupported characters".into());
    }
    Ok(VertexTarget {
        project,
        location,
        model,
        api_key,
    })
}

pub(crate) fn load_target() -> Result<VertexTarget, String> {
    let path = key_file_path();
    let text = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "Vertex route needs the key file ~/.gemini/{KEY_FILE} ({}): {e}",
            path.display()
        )
    })?;
    parse_target(&text)
}

fn normalize_effort(effort: &str) -> &'static str {
    match effort.trim().to_ascii_lowercase().as_str() {
        "low" => "low",
        "medium" => "medium",
        _ => "high",
    }
}

fn effort_from_model_suffix(model: &str) -> Option<&str> {
    let lower = model.to_ascii_lowercase();
    ["-low", "-medium", "-high"]
        .into_iter()
        .find(|suffix| lower.ends_with(suffix))
        .map(|suffix| &model[model.len() - suffix.len() + 1..])
}

/// `Some(model_arg)` when this launch must be served by Vertex: the selected
/// channel is the Vertex channel, or the model is exactly the mounted Vertex
/// model id. Catalog ids such as `gemini-4-argon-high` stay on the subscription.
pub(crate) fn route(
    model: Option<&str>,
    effort: Option<&str>,
    provider: Option<&Value>,
) -> Result<Option<String>, String> {
    let via_channel = vertex_channel(provider)?;
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    let exact = model.is_some_and(|m| m.eq_ignore_ascii_case(DEFAULT_MODEL) || is_bridge_model(m));
    if !via_channel && !exact {
        return Ok(None);
    }
    if exact && provider.is_some() && !via_channel {
        return Err("The mounted Vertex model requires the Vertex channel or the native configuration; refusing to replace another selected channel".into());
    }
    let target = load_target()?;
    if via_channel {
        validate_channel_target(provider, &target)?;
    }
    let level = selected_model_effort(model, &target.model)?
        .or(effort)
        .map(normalize_effort)
        .unwrap_or("high");
    Ok(Some(format!(
        "{BRIDGE_PREFIX}{level}/models/{}",
        target.model
    )))
}

/// Validate the requested identity before translating it to the bridge URL.
/// Exact matches come first: a configured custom model whose actual name ends
/// in `-high` is still a model name, not an implicit effort override.
fn selected_model_effort<'a>(
    model: Option<&'a str>,
    target: &str,
) -> Result<Option<&'a str>, String> {
    let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) else {
        return Ok(None);
    };
    if model.eq_ignore_ascii_case(target) {
        return Ok(None);
    }
    if let Some(bridge) = model.strip_prefix(BRIDGE_PREFIX) {
        if let Some((level, name)) = bridge.split_once("/models/") {
            if matches!(level, "low" | "medium" | "high") && name.eq_ignore_ascii_case(target) {
                return Ok(Some(level));
            }
        }
    } else if ["low", "medium", "high"]
        .into_iter()
        .any(|level| model.eq_ignore_ascii_case(&format!("{target}-{level}")))
    {
        return Ok(effort_from_model_suffix(model));
    }
    Err(format!("Selected model does not match this Vertex channel's configured model ({target}); select that model or start with the appropriate channel"))
}

fn vertex_channel(provider: Option<&Value>) -> Result<bool, String> {
    let Some(raw) = provider
        .and_then(|p| p.get("baseUrl"))
        .and_then(Value::as_str)
    else {
        return Ok(false);
    };
    // Reject lookalikes instead of silently selecting the subscription route.
    if !raw.to_ascii_lowercase().contains(VERTEX_HOST) {
        return Ok(false);
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid Vertex channel URL")?;
    let host = url.host_str().unwrap_or_default();
    let valid_host = host == VERTEX_HOST
        || host
            .strip_suffix(&format!("-{VERTEX_HOST}"))
            .is_some_and(|region| {
                !region.is_empty()
                    && region
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            });
    if url.scheme() != "https"
        || !valid_host
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Invalid Vertex channel URL: expected an HTTPS aiplatform.googleapis.com endpoint"
                .into(),
        );
    }
    Ok(true)
}

fn validate_channel_target(provider: Option<&Value>, target: &VertexTarget) -> Result<(), String> {
    let Some(raw) = provider.and_then(|value| value.get("baseUrl")).and_then(Value::as_str) else {
        return Ok(());
    };
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid Vertex channel URL")?;
    let segments: Vec<_> = url.path().trim_matches('/').split('/').collect();
    if segments.get(1) != Some(&"projects") { return Ok(()); }
    let model = segments.get(8).and_then(|part| part.split(':').next());
    if segments.len() != 9 || segments.get(3) != Some(&"locations")
        || segments.get(5) != Some(&"publishers") || segments.get(6) != Some(&"google")
        || segments.get(7) != Some(&"models")
        || segments.get(2).copied() != Some(target.project.as_str())
        || segments.get(4).copied() != Some(target.location.as_str())
        || model != Some(target.model.as_str()) {
        return Err("Vertex channel project, location and model must match the local key file; refusing a different billing target".into());
    }
    Ok(())
}

pub(crate) fn is_bridge_model(model: &str) -> bool {
    model.starts_with(BRIDGE_PREFIX)
}

/// Name shown to the user: the real model id, not the bridge URL.
pub(crate) fn display_model(model: &str) -> &str {
    model.rsplit("/models/").next().unwrap_or(model)
}

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// Prepares the dedicated agy data dir and returns the `--app_data_dir` value.
pub(crate) fn prepare_app_dir() -> Result<String, String> {
    let gemini = gemini_dir();
    let native = super::agy::agy_home();
    if native.parent() != Some(gemini.as_path()) {
        return Err("Vertex route requires the default Antigravity home under ~/.gemini".into());
    }
    let dir = app_home();
    let mut settings = match std::fs::read_to_string(native.join("settings.json")) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .ok()
            .filter(Value::is_object)
            .ok_or("Cannot prepare Vertex settings: native settings.json is not a JSON object")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(_) => return Err("Cannot read native Antigravity settings for Vertex".into()),
    };
    settings["modelProvider"] = json!("gemini");
    let rendered = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join("settings.json");
    // Skip identical rewrites: a running agy may be reading this file.
    if std::fs::read_to_string(&path).ok().as_deref() != Some(rendered.as_str()) {
        crate::settings::atomic_write(&path, &rendered)?;
    }
    Ok(APP_DIR_NAME.to_string())
}

/// Points the agy process at the loopback bridge and removes variables that
/// would make agy pick another credential or backend.
pub(crate) fn apply_env(built: &mut super::BuiltCommand) -> Result<(), String> {
    let (base, token) = ensure_bridge()?;
    let lease_id = uuid::Uuid::new_v4().simple().to_string();
    let path = lease_path(&lease_id);
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|_| "Cannot create Vertex run directory")?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "Cannot create Vertex run lease")?;
    built.cleanup_files.push(path);
    let command = &mut built.command;
    command
        .env("GEMINI_API_KEY", format!("{token}:{lease_id}"))
        .env("GOOGLE_GEMINI_BASE_URL", base);
    // Even custom channel proxy environments must keep the bridge on loopback.
    for key in ["NO_PROXY", "no_proxy"] {
        let existing = command
            .as_std()
            .get_envs()
            .find(|(name, _)| *name == key)
            .and_then(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()))
            .or_else(|| std::env::var(key).ok())
            .unwrap_or_default();
        command.env(key, format!("{existing},localhost,127.0.0.1,::1"));
    }
    for key in [
        "GOOGLE_API_KEY",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_GENAI_USE_ENTERPRISE",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "AGY_ADC_AUTH",
    ] {
        command.env_remove(key);
    }
    Ok(())
}

fn lease_path(id: &str) -> PathBuf {
    crate::paths::app_home().join("agy-vertex-runs").join(id)
}

async fn lease_ended(path: &std::path::Path) {
    while path.is_file() {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ── loopback bridge ─────────────────────────────────────────────────────────

struct BridgeState {
    token: String,
}

static BRIDGE: Mutex<Option<(u16, String)>> = Mutex::new(None);

fn ensure_bridge() -> Result<(String, String), String> {
    let mut slot = BRIDGE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((port, token)) = slot.as_ref() {
        return Ok((format!("http://127.0.0.1:{port}"), token.clone()));
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Vertex bridge cannot listen on loopback: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Vertex bridge socket: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let state = Arc::new(BridgeState {
        token: token.clone(),
    });
    let app = Router::new()
        .fallback(any(handle))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(state);
    tauri::async_runtime::spawn(async move {
        let result = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => axum::serve(listener, app).await.map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        if let Err(error) = result {
            eprintln!("[agy-vertex] bridge stopped: {error}");
        }
        // Next launch binds a fresh bridge instead of reusing a dead port.
        *BRIDGE.lock().unwrap_or_else(|p| p.into_inner()) = None;
    });
    *slot = Some((port, token.clone()));
    Ok((format!("http://127.0.0.1:{port}"), token))
}

fn http_client() -> Result<reqwest::Client, reqwest::Error> {
    // Rebuild against the current proxy environment. A global client would keep
    // using an old proxy after the user changes the application setting.
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60 * 60))
        .build()
}

fn json_error(status: StatusCode, message: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"error": {"code": status.as_u16(), "message": message}}).to_string(),
        ))
        .unwrap_or_default()
}

/// `/v1beta/models/<model path>:<method>` → (effort, method).
/// `<model path>` is `<effort>/models/<model>` for the main chat request; the
/// helper requests agy makes (e.g. title generation) name other models and are
/// served by the same Vertex model at the lowest effort.
pub(crate) fn parse_path(path: &str) -> Option<(&'static str, &str)> {
    let rest = path
        .strip_prefix("/v1beta/models/")
        .or_else(|| path.strip_prefix("/v1/models/"))?;
    let (model_path, method) = rest.rsplit_once(':')?;
    if !matches!(method, "streamGenerateContent" | "generateContent") {
        return None;
    }
    let effort = model_path
        .split_once("/models/")
        .map(|(effort, _)| effort)
        .filter(|effort| matches!(*effort, "low" | "medium" | "high"))
        .map(normalize_effort)
        .unwrap_or("low");
    Some((effort, method))
}

/// Vertex takes `thinkingLevel`; agy sends the Gemini-API `thinkingBudget`.
pub(crate) fn rewrite_body(raw: &[u8], effort: &str) -> Vec<u8> {
    let Ok(mut value) = serde_json::from_slice::<Value>(raw) else {
        return raw.to_vec();
    };
    if let Some(object) = value.as_object_mut() {
        let generation = object
            .entry("generationConfig")
            .or_insert_with(|| json!({}));
        let Some(generation) = generation.as_object_mut() else {
            return raw.to_vec();
        };
        let thinking = generation
            .entry("thinkingConfig")
            .or_insert_with(|| json!({}));
        let Some(config) = thinking.as_object_mut() else {
            return raw.to_vec();
        };
        config.remove("thinkingBudget");
        config.insert(
            "thinkingLevel".into(),
            Value::String(effort.to_ascii_uppercase()),
        );
    }
    serde_json::to_vec(&value).unwrap_or_else(|_| raw.to_vec())
}

fn vertex_url(target: &VertexTarget, method: &str) -> String {
    let host = if target.location == "global" {
        VERTEX_HOST.to_string()
    } else {
        format!("{}-{VERTEX_HOST}", target.location)
    };
    let stream = if method == "streamGenerateContent" {
        "?alt=sse"
    } else {
        ""
    };
    format!(
        "https://{host}/v1/projects/{}/locations/{}/publishers/google/models/{}:{method}{stream}",
        target.project, target.location, target.model
    )
}

async fn handle(
    State(state): State<Arc<BridgeState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let credential = headers.get("x-goog-api-key").and_then(|v| v.to_str().ok());
    let lease = credential
        .and_then(|credential| credential.split_once(':'))
        .filter(|(token, id)| {
            *token == state.token && id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
        })
        .map(|(_, id)| lease_path(id));
    let Some(lease) = lease.filter(|path| path.is_file()) else {
        return json_error(StatusCode::UNAUTHORIZED, "invalid bridge token");
    };
    if method != Method::POST {
        return json_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "Vertex bridge requires POST",
        );
    }
    let Some((effort, method)) = parse_path(uri.path()) else {
        return json_error(StatusCode::NOT_FOUND, "unsupported Gemini API path");
    };
    let target = match load_target() {
        Ok(target) => target,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &error),
    };
    let client = match http_client() {
        Ok(client) => client,
        Err(_) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                "Cannot configure Vertex HTTP client",
            )
        }
    };
    forward(
        &client,
        &vertex_url(&target, method),
        &target.api_key,
        rewrite_body(&body, effort),
        lease,
    )
    .await
}

async fn forward(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    body: Vec<u8>,
    lease: PathBuf,
) -> Response {
    let request = client
        .post(url)
        .header("x-goog-api-key", key)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body)
        .send();
    let upstream = tokio::select! {
        result = request => result,
        _ = lease_ended(&lease) => return json_error(StatusCode::GONE, "Vertex run ended"),
    };
    let upstream = match upstream {
        Ok(response) => response,
        Err(_) => {
            return json_error(
                StatusCode::BAD_GATEWAY,
                "Vertex request failed (connection or timeout)",
            );
        }
    };
    // Never follow a redirect with the project key, or forward its Location
    // header to the CLI (which might otherwise retry outside this bridge).
    if upstream.status().is_redirection() {
        return json_error(
            StatusCode::BAD_GATEWAY,
            "Vertex returned an unexpected redirect",
        );
    }
    if !upstream.status().is_success() {
        let status = upstream.status();
        let mut stream = upstream.bytes_stream();
        let mut bytes = Vec::new();
        loop {
            let next = tokio::select! {
                item = stream.next() => item,
                _ = lease_ended(&lease) => return json_error(StatusCode::GONE, "Vertex run ended"),
            };
            match next {
                Some(Ok(chunk)) if bytes.len() + chunk.len() <= 64 * 1024 => {
                    bytes.extend_from_slice(&chunk)
                }
                None => break,
                _ => return json_error(status, "Vertex upstream request failed"),
            }
        }
        let parsed = serde_json::from_slice::<Value>(&bytes).ok();
        let message = parsed
            .as_ref()
            .and_then(|v| v.pointer("/error/message"))
            .and_then(Value::as_str)
            .unwrap_or("Vertex upstream request failed");
        let message = if key.is_empty() {
            message.to_string()
        } else {
            message.replace(key, "[redacted]")
        };
        return json_error(status, &message);
    }
    let mut response = Response::builder().status(upstream.status());
    if let Some(content_type) = upstream.headers().get(header::CONTENT_TYPE) {
        response = response.header(header::CONTENT_TYPE, content_type);
    }
    let stream = futures_util::stream::unfold(
        (upstream.bytes_stream(), lease),
        |(mut upstream, lease)| async move {
            tokio::select! {
                item = upstream.next() => item.map(|item| (item, (upstream, lease))),
                _ = lease_ended(&lease) => None,
            }
        },
    );
    response.body(Body::from_stream(stream)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_FILE_TEXT: &str = "project=project-abc\nlocation=global\nmodel=gemini-4-argon\napi_key=SECRET-KEY\nservice_account=x@y.iam.gserviceaccount.com\nendpoint=https://aiplatform.googleapis.com/v1/x\n";

    #[test]
    fn key_file_parses_and_rejects_unsafe_values() {
        let target = parse_target(KEY_FILE_TEXT).unwrap();
        assert_eq!(target.project, "project-abc");
        assert_eq!(target.model, "gemini-4-argon");
        assert_eq!(
            vertex_url(&target, "streamGenerateContent"),
            "https://aiplatform.googleapis.com/v1/projects/project-abc/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse"
        );
        assert!(parse_target("project=p\nlocation=global\n").is_err());
        assert!(parse_target("project=a/b\napi_key=k\n").is_err());
        let regional = parse_target("project=p\nlocation=asia-southeast1\napi_key=k\n").unwrap();
        assert!(vertex_url(&regional, "generateContent")
            .starts_with("https://asia-southeast1-aiplatform.googleapis.com/v1/projects/p/locations/asia-southeast1/"));
    }

    #[test]
    fn channel_cannot_silently_replace_another_provider_or_billing_target() {
        assert!(route(Some(DEFAULT_MODEL), None, Some(&json!({"baseUrl":"https://other.example/v1"}))).is_err());
        let target = VertexTarget { project: "project-a".into(), location: "global".into(), model: DEFAULT_MODEL.into(), api_key: "fixture".into() };
        let provider = |project: &str| json!({"baseUrl":format!("https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/google/models/{DEFAULT_MODEL}:generateContent")});
        assert!(validate_channel_target(Some(&provider("project-a")), &target).is_ok());
        assert!(validate_channel_target(Some(&provider("project-b")), &target).is_err());
    }

    #[test]
    fn request_paths_carry_effort_and_default_helpers_to_low() {
        assert_eq!(
            parse_path("/v1beta/models/high/models/gemini-4-argon:streamGenerateContent"),
            Some(("high", "streamGenerateContent"))
        );
        assert_eq!(
            parse_path("/v1beta/models/medium/models/gemini-4-argon:generateContent"),
            Some(("medium", "generateContent"))
        );
        assert_eq!(
            parse_path("/v1beta/models/gemini-3.1-flash-lite-preview:streamGenerateContent"),
            Some(("low", "streamGenerateContent"))
        );
        assert_eq!(parse_path("/v1beta/models/x:countTokens"), None);
        assert_eq!(parse_path("/other"), None);
    }

    #[test]
    fn body_rewrite_swaps_budget_for_level_and_keeps_everything_else() {
        let raw = br#"{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":10,"thinkingConfig":{"includeThoughts":true,"thinkingBudget":-1}}}"#;
        let out: Value = serde_json::from_slice(&rewrite_body(raw, "medium")).unwrap();
        let config = &out["generationConfig"]["thinkingConfig"];
        assert!(config.get("thinkingBudget").is_none());
        assert_eq!(config["thinkingLevel"], "MEDIUM");
        assert_eq!(config["includeThoughts"], true);
        assert_eq!(out["generationConfig"]["maxOutputTokens"], 10);
        assert_eq!(out["contents"][0]["parts"][0]["text"], "hi");
        // The selected effort remains authoritative even without a CLI budget.
        let plain = br#"{"contents":[]}"#;
        let out: Value = serde_json::from_slice(&rewrite_body(plain, "high")).unwrap();
        assert_eq!(
            out["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "HIGH"
        );
        assert_eq!(rewrite_body(b"not json", "high"), b"not json".to_vec());
    }

    #[test]
    fn effort_resolution_and_display_names() {
        assert_eq!(
            effort_from_model_suffix("gemini-4-argon-high"),
            Some("high")
        );
        assert_eq!(effort_from_model_suffix("gemini-4-argon"), None);
        assert_eq!(normalize_effort("xhigh"), "high");
        assert_eq!(normalize_effort("LOW"), "low");
        let arg = format!("{BRIDGE_PREFIX}medium/models/gemini-4-argon");
        assert!(is_bridge_model(&arg));
        assert_eq!(display_model(&arg), "gemini-4-argon");
        assert_eq!(display_model("gemini-4-argon-high"), "gemini-4-argon-high");
    }

    #[test]
    fn vertex_selected_model_must_match_target_or_its_explicit_effort_variant() {
        assert_eq!(selected_model_effort(None, DEFAULT_MODEL).unwrap(), None);
        assert_eq!(
            selected_model_effort(Some(DEFAULT_MODEL), DEFAULT_MODEL).unwrap(),
            None
        );
        for level in ["low", "medium", "high"] {
            let variant = format!("{DEFAULT_MODEL}-{level}");
            assert_eq!(
                selected_model_effort(Some(&variant), DEFAULT_MODEL).unwrap(),
                Some(level)
            );
            let bridge = format!("{BRIDGE_PREFIX}{level}/models/{DEFAULT_MODEL}");
            assert_eq!(
                selected_model_effort(Some(&bridge), DEFAULT_MODEL).unwrap(),
                Some(level)
            );
        }
        for selected in [
            "claude-opus-5-5-high",
            "gpt-5",
            "gemini-4-argon-preview",
            "gemini-4-argon-xhigh",
            "other-gemini-4-argon-high",
        ] {
            assert!(
                selected_model_effort(Some(selected), DEFAULT_MODEL).is_err(),
                "{selected}"
            );
        }
        for selected in [
            format!("{BRIDGE_PREFIX}high/models/claude-opus-5-5"),
            format!("{BRIDGE_PREFIX}xhigh/models/{DEFAULT_MODEL}"),
            format!("{BRIDGE_PREFIX}high/models/{DEFAULT_MODEL}/extra"),
            format!("{BRIDGE_PREFIX}high"),
        ] {
            assert!(
                selected_model_effort(Some(&selected), DEFAULT_MODEL).is_err(),
                "{selected}"
            );
        }
    }

    #[test]
    fn custom_vertex_model_names_are_not_rewritten_or_misread_as_effort() {
        let custom = "custom-model-high";
        assert_eq!(selected_model_effort(Some(custom), custom).unwrap(), None);
        assert_eq!(
            selected_model_effort(Some("custom-model-high-medium"), custom).unwrap(),
            Some("medium")
        );
        assert!(selected_model_effort(Some("custom-model"), custom).is_err());
        assert!(selected_model_effort(Some(DEFAULT_MODEL), custom).is_err());
        assert_eq!(
            selected_model_effort(Some("other-provider-model"), "other-provider-model").unwrap(),
            None
        );
    }

    #[test]
    fn subscription_models_never_route_to_vertex_without_the_channel() {
        assert_eq!(
            route(Some("gemini-4-argon-high"), Some("high"), None).unwrap(),
            None
        );
        assert_eq!(
            route(Some("claude-opus-5-5-high"), None, None).unwrap(),
            None
        );
        assert_eq!(route(None, None, None).unwrap(), None);
        let other_channel = json!({"baseUrl": "https://relay.example/v1"});
        assert_eq!(
            route(Some("gemini-3.8-flash-high"), None, Some(&other_channel)).unwrap(),
            None
        );
    }

    #[test]
    fn vertex_channel_rejects_lookalikes_and_insecure_endpoints() {
        for url in [
            "https://aiplatform.googleapis.com/v1",
            "https://asia-southeast1-aiplatform.googleapis.com/v1",
        ] {
            assert_eq!(vertex_channel(Some(&json!({"baseUrl":url}))).unwrap(), true);
        }
        for url in [
            "http://aiplatform.googleapis.com/v1",
            "https://aiplatform.googleapis.com.evil.test/v1",
            "https://evil.test/aiplatform.googleapis.com",
            "https://user:secret@aiplatform.googleapis.com/v1",
        ] {
            assert!(vertex_channel(Some(&json!({"baseUrl":url}))).is_err());
        }
    }

    fn test_lease() -> PathBuf {
        let path = std::env::temp_dir().join(format!("ccgui-vertex-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "").unwrap();
        path
    }

    async fn fake_upstream(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (url, task)
    }

    #[tokio::test]
    async fn cancelling_one_run_aborts_its_header_wait_without_affecting_another() {
        let (url, server) = fake_upstream(Router::new().fallback(any(|| async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            "data: ok\n\n"
        })))
        .await;
        let first = test_lease();
        let second = test_lease();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            std::fs::remove_file(&first).unwrap();
        };
        let (a, b, _) = tokio::join!(
            forward(&client, &url, "test-key", vec![], first.clone()),
            forward(&client, &url, "test-key", vec![], second.clone()),
            cancel
        );
        assert_eq!(a.status(), StatusCode::GONE);
        assert_eq!(b.status(), StatusCode::OK);
        assert_eq!(
            axum::body::to_bytes(b.into_body(), 1024).await.unwrap(),
            "data: ok\n\n"
        );
        std::fs::remove_file(second).unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn cancellation_stops_an_idle_response_stream_and_redirects_are_not_followed() {
        let (url, server) = fake_upstream(
            Router::new()
                .route(
                    "/redirect",
                    any(|| async {
                        (
                            StatusCode::TEMPORARY_REDIRECT,
                            [(header::LOCATION, "/forbidden")],
                        )
                    }),
                )
                .route(
                    "/forbidden",
                    any(|| async {
                        panic!("API key must not follow redirects");
                        #[allow(unreachable_code)]
                        "bad"
                    }),
                )
                .route(
                    "/error",
                    any(|| async {
                        (
                            StatusCode::TOO_MANY_REQUESTS,
                            axum::Json(json!({"error":{"message":"quota exhausted for secret"}})),
                        )
                    }),
                )
                .route(
                    "/stream",
                    any(|| async {
                        Response::new(Body::from_stream(futures_util::stream::pending::<
                            Result<Bytes, std::io::Error>,
                        >()))
                    }),
                ),
        )
        .await;
        let lease = test_lease();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let response = forward(
            &client,
            &format!("{url}/redirect"),
            "secret",
            vec![],
            lease.clone(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let response = forward(
            &client,
            &format!("{url}/error"),
            "secret",
            vec![],
            lease.clone(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("quota exhausted"));
        assert!(!text.contains("secret"));
        let response = forward(
            &client,
            &format!("{url}/stream"),
            "secret",
            vec![],
            lease.clone(),
        )
        .await;
        std::fs::remove_file(lease).unwrap();
        let bytes = tokio::time::timeout(
            Duration::from_secs(1),
            axum::body::to_bytes(response.into_body(), 1024),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(bytes.is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn bridge_rejects_requests_without_its_token() {
        let (base, token) = ensure_bridge().unwrap();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let lease = lease_path(&id);
        std::fs::create_dir_all(lease.parent().unwrap()).unwrap();
        std::fs::write(&lease, "").unwrap();
        let token = format!("{token}:{id}");
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = format!("{base}/v1beta/models/high/models/gemini-4-argon:streamGenerateContent");
        let anonymous = client.post(&url).body("{}").send().await.unwrap();
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);
        let wrong = client
            .post(&url)
            .header("x-goog-api-key", "nope")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
        let unsupported = client
            .post(format!("{base}/v1beta/models/x:countTokens"))
            .header("x-goog-api-key", &token)
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(unsupported.status(), StatusCode::NOT_FOUND);
        // The same bridge is reused, never re-bound per launch.
        assert_eq!(ensure_bridge().unwrap().0, base);
        std::fs::remove_file(lease).unwrap();
    }

    /// `cargo test --lib agy_vertex_live -- --ignored --nocapture`
    /// Needs `agy` on PATH and `~/.gemini/vertex-gemini-4-argon.txt`.
    #[tokio::test]
    #[ignore = "spends Vertex tokens and needs local credentials"]
    async fn agy_vertex_live_round_trip() {
        let model_arg = route(Some("gemini-4-argon"), Some("medium"), None)
            .unwrap()
            .expect("the mounted Vertex model must route to the bridge");
        assert!(model_arg.ends_with("medium/models/gemini-4-argon"));
        let app_dir = prepare_app_dir().unwrap();
        let mut command = tokio::process::Command::new("agy");
        command.args(["--app_data_dir", &app_dir, "--model", &model_arg]);
        command.args([
            "--output-format",
            "stream-json",
            "--print",
            "Reply with exactly the single word PONG",
        ]);
        let mut built = super::super::BuiltCommand {
            command,
            stdin_payload: None,
            keep_stdin_open: false,
            cleanup_files: Vec::new(),
            mcp_restore: None,
            preassigned_session_id: None,
        };
        apply_env(&mut built).unwrap();
        let output = tokio::time::timeout(Duration::from_secs(180), built.command.output())
            .await
            .expect("agy finished in time")
            .unwrap();
        super::super::cleanup_staged_files(&built.cleanup_files);
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("\"status\":\"SUCCESS\""),
            "stdout: {stdout}\nstderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(stdout.contains("PONG"), "stdout: {stdout}");
        let real_key = load_target().unwrap().api_key;
        assert!(
            !stdout.contains(&real_key)
                && !String::from_utf8_lossy(&output.stderr).contains(&real_key),
            "the real API key reached agy's output"
        );
    }
}
