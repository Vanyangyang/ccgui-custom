//! Isolated Codex Responses completion. No thread or turn is created.
//!
//! Protocol evidence is pinned to openai/codex rust-v0.159.2:
//! codex-api/src/common.rs (ResponsesApiRequest/TextFormat),
//! codex-api/src/endpoint/responses.rs (POST /responses, SSE),
//! model-provider-info/src/lib.rs (auth-dependent base URL), and
//! app-server/src/request_processors/account_processor.rs (getAuthStatus).
//! account_processor/workspace_routing.rs and model-provider/src/workspace_routing.rs
//! provide the selected workspace's authoritative origin and residency header.
//! OAuth rotation stays inside the stock CLI. This module never writes auth.

use super::{ProcessGuard, SideCallError, SideCallOutput, StructuredCall, MAX_OUTPUT};
use crate::engine::{command_for_binary, SendRequest};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

const OPENAI_BASE: &str = "https://api.openai.com/v1";
const CHATGPT_BASE: &str = "https://chatgpt.com/backend-api/codex";
const MAX_CONFIG: usize = 1024 * 1024;
const PREPARED_ROUTE_TTL: Duration = Duration::from_secs(90);
// Reasoning and token events repeat metadata/text on the wire. The transport
// budget must not use the much smaller final structured-answer budget.
const MAX_STREAM_BYTES: usize = 8 * 1024 * 1024;
const MAX_SSE_FRAME_BYTES: usize = 2 * 1024 * 1024;

#[derive(PartialEq)]
struct Route {
    base: Option<String>,
    headers: HeaderMap,
    key: Option<String>,
    requires_auth: bool,
}

struct AuthSnapshot {
    mode: String,
    token: String,
    user_agent: String,
    workspace_routing: Option<Value>,
    oauth: Option<VerifiedOauth>,
}

struct VerifiedOauth {
    account: String,
    fedramp: bool,
    file_hash: [u8; 32],
}

struct CachedPreparedRoute {
    pre_key: [u8; 32],
    auth_hash: Option<[u8; 32]>,
    verified_at: Instant,
    base: String,
    headers: HeaderMap,
}

static PREPARED_ROUTE_CACHE: LazyLock<Mutex<Option<CachedPreparedRoute>>> =
    LazyLock::new(|| Mutex::new(None));

fn sha256_bytes(bytes: &[u8]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(bytes);
    hash.finalize().into()
}

// This read only enables caching; it is not the authoritative auth check.
// Missing/unreadable bytes must bypass reuse instead of failing before the CLI
// and the strict OAuth snapshot validation have had a chance to run.
async fn optional_auth_file_hash(
    read: impl std::future::Future<Output = Result<Option<String>, SideCallError>>,
) -> Option<[u8; 32]> {
    read.await
        .ok()
        .flatten()
        .map(|text| sha256_bytes(text.as_bytes()))
}

fn hash_len_bytes(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

fn preparation_pre_key(
    home: &Path,
    bin: &str,
    native_text: &str,
    config: &toml::Table,
    explicit_env: &HashMap<String, String>,
    needs_auth: bool,
    env_lookup: impl Fn(&str) -> Option<String>,
) -> Result<[u8; 32], SideCallError> {
    let mut hash = Sha256::new();
    hash_len_bytes(&mut hash, b"codex-prepared-route-v1");
    hash_len_bytes(&mut hash, home.as_os_str().as_encoded_bytes());
    hash_len_bytes(&mut hash, bin.as_bytes());
    hash_len_bytes(&mut hash, native_text.as_bytes());
    let config_bytes = serde_json::to_vec(config).map_err(|_| SideCallError::Unavailable)?;
    hash_len_bytes(&mut hash, &config_bytes);
    let mut sorted_env: Vec<_> = explicit_env.iter().collect();
    sorted_env.sort_by(|a, b| a.0.cmp(b.0));
    hash.update((sorted_env.len() as u64).to_le_bytes());
    for (key, value) in sorted_env {
        hash_len_bytes(&mut hash, key.as_bytes());
        hash_len_bytes(&mut hash, value.as_bytes());
    }
    let mut route_env_keys = vec![
        "OPENAI_API_KEY".to_owned(),
        "OPENAI_BASE_URL".to_owned(),
        "OPENAI_ORGANIZATION".to_owned(),
        "OPENAI_PROJECT".to_owned(),
    ];
    if let Ok((_, Some(provider))) = selected_provider(config) {
        if let Some(env_key) = optional_str(provider, "env_key")? {
            route_env_keys.push(env_key.to_owned());
        }
        if let Some(env_headers) = provider
            .get("env_http_headers")
            .and_then(toml::Value::as_table)
        {
            for value in env_headers.values() {
                if let Some(name) = value.as_str() {
                    route_env_keys.push(name.to_owned());
                }
            }
        }
    }
    route_env_keys.sort();
    route_env_keys.dedup();
    hash.update((route_env_keys.len() as u64).to_le_bytes());
    for key in route_env_keys {
        hash_len_bytes(&mut hash, key.as_bytes());
        match env_lookup(&key) {
            Some(value) => {
                hash.update([1]);
                hash_len_bytes(&mut hash, value.as_bytes());
            }
            None => hash.update([0]),
        }
    }
    hash.update([u8::from(needs_auth)]);
    Ok(hash.finalize().into())
}

fn lookup_prepared_route_in(
    cache: &Mutex<Option<CachedPreparedRoute>>,
    pre_key: &[u8; 32],
    auth_hash: Option<[u8; 32]>,
    now: Instant,
) -> Option<(String, HeaderMap)> {
    let mut guard = cache.lock().ok()?;
    let entry = guard.as_ref()?;
    if now.saturating_duration_since(entry.verified_at) >= PREPARED_ROUTE_TTL {
        *guard = None;
        return None;
    }
    if &entry.pre_key != pre_key || entry.auth_hash != auth_hash {
        return None;
    }
    Some((entry.base.clone(), entry.headers.clone()))
}

fn store_prepared_route_in(
    cache: &Mutex<Option<CachedPreparedRoute>>,
    pre_key: [u8; 32],
    auth_hash: Option<[u8; 32]>,
    now: Instant,
    base: &str,
    headers: &HeaderMap,
) {
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(CachedPreparedRoute {
            pre_key,
            auth_hash,
            verified_at: now,
            base: base.to_owned(),
            headers: headers.clone(),
        });
    }
}

fn invalidate_prepared_route_in(cache: &Mutex<Option<CachedPreparedRoute>>) {
    if let Ok(mut guard) = cache.lock() {
        *guard = None;
    }
}

fn lookup_prepared_route(
    pre_key: &[u8; 32],
    auth_hash: Option<[u8; 32]>,
    now: Instant,
) -> Option<(String, HeaderMap)> {
    lookup_prepared_route_in(&PREPARED_ROUTE_CACHE, pre_key, auth_hash, now)
}

fn store_prepared_route(
    pre_key: [u8; 32],
    auth_hash: Option<[u8; 32]>,
    now: Instant,
    base: &str,
    headers: &HeaderMap,
) {
    store_prepared_route_in(&PREPARED_ROUTE_CACHE, pre_key, auth_hash, now, base, headers);
}

fn invalidate_prepared_route() {
    invalidate_prepared_route_in(&PREPARED_ROUTE_CACHE);
}

fn traced<T>(stage: &'static str, result: Result<T, SideCallError>) -> Result<T, SideCallError> {
    if let Err(error) = &result {
        super::diagnostics::record(stage);
        eprintln!("[side-call] codex stage={stage} error={error:?}");
    }
    result
}

fn bad_output(stage: &'static str) -> SideCallError {
    super::diagnostics::record(stage);
    SideCallError::BadOutput
}

pub(super) async fn structured(call: StructuredCall<'_>) -> Result<SideCallOutput, SideCallError> {
    completion_deadline(call.timeout, structured_inner(&call)).await
}

async fn completion_deadline<T>(
    timeout: std::time::Duration,
    operation: impl std::future::Future<Output = Result<T, SideCallError>>,
) -> Result<T, SideCallError> {
    super::diagnostics::deadline(timeout);
    let result = match tokio::time::timeout(timeout, operation).await {
        Ok(result) => result,
        Err(_) => {
            super::diagnostics::timed_out();
            Err(SideCallError::Timeout)
        }
    };
    traced("completion", result)
}

async fn structured_inner(call: &StructuredCall<'_>) -> Result<SideCallOutput, SideCallError> {
    let (base, headers) = serialized_preparation(&PREPARATION_GATE, prepare(call)).await?;
    complete_http(call, &base, headers).await
}

// Stock auth refresh and the subsequent file snapshot share CODEX_HOME across
// side calls. Keep that whole preparation atomic within this process, while
// allowing independent HTTP completions to overlap after headers are owned.
static PREPARATION_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct GuardedPreparation<'a, F> {
    // Field order ensures cancellation drops the operation (including its
    // process guard) before unlocking preparation for the next side call.
    operation: std::pin::Pin<Box<F>>,
    _guard: tokio::sync::MutexGuard<'a, ()>,
}

fn serialized_preparation<'a, T: 'a>(
    gate: &'a tokio::sync::Mutex<()>,
    preparation: impl std::future::Future<Output = Result<T, SideCallError>> + 'a,
) -> impl std::future::Future<Output = Result<T, SideCallError>> + 'a {
    // Box before constructing the waiting future: do not carry the large
    // preparation future inline through the Windows 1 MiB IPC stack.
    let preparation = Box::pin(preparation);
    async move {
        super::diagnostics::active_phase("preparation_wait");
        let guard = gate.lock().await;
        let mut guarded = GuardedPreparation {
            operation: preparation,
            _guard: guard,
        };
        guarded.operation.as_mut().await
    }
}

async fn prepare(call: &StructuredCall<'_>) -> Result<(String, HeaderMap), SideCallError> {
    super::diagnostics::active_phase("configuration");
    crate::config::ensure_engine_enabled("codex").map_err(|_| SideCallError::Unavailable)?;
    let provider = crate::config::resolve_provider("codex", call.provider_id)
        .map_err(|_| SideCallError::Unavailable)?;
    let channel_env = provider
        .as_ref()
        .map(|provider| crate::provider_files::channel_env("codex", provider))
        .transpose()
        .map_err(|_| SideCallError::Unavailable)?
        .unwrap_or_default();
    let home = crate::engine::codex_home();
    let native_text = read_optional(&home.join("config.toml"))
        .await?
        .unwrap_or_default();
    let mut config: toml::Table =
        toml::from_str(&native_text).map_err(|_| SideCallError::Unavailable)?;
    // This small transport cannot reproduce profiles, include layers or managed
    // configuration. Refuse them rather than guess which endpoint owns a key.
    if ["profile", "include", "config_files", "managed_config"]
        .iter()
        .any(|key| config.contains_key(*key))
    {
        return Err(SideCallError::Unavailable);
    }
    let settings = crate::settings::read_settings().map_err(|_| SideCallError::Unavailable)?;
    let bin = crate::engine::engine_bin(&settings, "codex");
    let mut command = command_for_binary(&bin);
    command.arg("app-server");
    command.env("CODEX_HOME", &home);
    for (key, value) in &channel_env {
        command.env(key, value);
    }
    if let Some(provider) = &provider {
        // Use the actual channel contract, including flat-provider selection,
        // OPENAI_API_KEY precedence and literal-header relocation into env.
        let req = SendRequest {
            host_instructions: None,
            session_id: None,
            workspace: home.clone(),
            prompt: String::new(),
            images: vec![],
            model: Some(call.model.into()),
            effort: Some(call.effort.into()),
            claude_ultracode: None,
            service_tier: None,
            permission: None,
            additional_dirs: vec![],
            provider_id: None,
            computer_use: None,
            allowed_tools: None,
        };
        crate::engine::codex::apply_channel(&mut command, provider, &channel_env, &req)
            .map_err(|_| SideCallError::Unavailable)?;
    }
    crate::engine::codex_provider_env::apply(&mut command).await;
    let explicit_env = routing_snapshot(&command, &mut config)?;
    let route = resolve_route(&config, |key| {
        explicit_env
            .get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
    })?;
    let needs_auth = route.key.is_none() && route.requires_auth;
    if needs_auth
        && config
            .get("cli_auth_credentials_store")
            .and_then(toml::Value::as_str)
            .is_some_and(|store| store != "file")
    {
        return Err(SideCallError::Unavailable);
    }
    let pre_key = preparation_pre_key(
        &home,
        &bin,
        &native_text,
        &config,
        &explicit_env,
        needs_auth,
        |key| std::env::var(key).ok(),
    )?;
    let pre_auth_hash = if needs_auth {
        optional_auth_file_hash(read_optional(&home.join("auth.json"))).await
    } else {
        None
    };
    if !needs_auth || pre_auth_hash.is_some() {
        if let Some(cached) = lookup_prepared_route(&pre_key, pre_auth_hash, Instant::now()) {
            return Ok(cached);
        }
    }
    // Every path, including explicit channel keys, checks the stock CLI's
    // managed effective config before a credential can reach HTTP.
    super::diagnostics::active_phase("auth_snapshot");
    let auth = traced(
        "auth_snapshot",
        stock_snapshot(command, &home, &config, &explicit_env, needs_auth).await,
    )?;
    super::diagnostics::active_phase("configuration");
    let mut cache_auth_hash = None;
    let (base, headers) = if let Some(key) = route.key {
        let mut headers = route.headers;
        set_bearer(&mut headers, &key)?;
        (route.base.unwrap_or_else(|| OPENAI_BASE.into()), headers)
    } else if !route.requires_auth {
        (
            route.base.unwrap_or_else(|| OPENAI_BASE.into()),
            route.headers,
        )
    } else {
        if config
            .get("cli_auth_credentials_store")
            .and_then(toml::Value::as_str)
            .is_some_and(|store| store != "file")
        {
            return Err(SideCallError::Unavailable);
        }
        // Ask the stock auth manager which identity wins. Reading an old
        // OPENAI_API_KEY field alone can bypass a selected ChatGPT identity.
        let auth = auth.ok_or(SideCallError::Unavailable)?;
        let mut headers = route.headers;
        if !headers.contains_key("user-agent") {
            insert_header(&mut headers, "user-agent", &auth.user_agent)?;
        }
        if !headers.contains_key("originator") {
            headers.insert("originator", HeaderValue::from_static("ccgui_auto_title"));
        }
        if auth.mode == "apikey" {
            set_bearer(&mut headers, &auth.token)?;
            // The RPC key has no verified file snapshot. Do not bind it to a
            // later file hash and accidentally cache old headers as new auth.
            (route.base.unwrap_or_else(|| OPENAI_BASE.into()), headers)
        } else {
            let oauth = traced("oauth_snapshot", auth.oauth.ok_or(SideCallError::Unavailable))?;
            let account = oauth.account.as_str();
            set_bearer(&mut headers, &auth.token)?;
            headers.insert(
                "chatgpt-account-id",
                HeaderValue::from_str(account).map_err(|_| SideCallError::Unavailable)?,
            );
            if oauth.fedramp {
                headers.insert("x-openai-fedramp", HeaderValue::from_static("true"));
            }
            let base = oauth_route(
                route.base.as_deref(),
                auth.workspace_routing
                    .as_ref()
                    .ok_or(SideCallError::Unavailable)?,
                account,
                &mut headers,
            )?;
            cache_auth_hash = Some(oauth.file_hash);
            (base, headers)
        }
    };
    if !needs_auth || cache_auth_hash.is_some() {
        store_prepared_route(pre_key, cache_auth_hash, Instant::now(), &base, &headers);
    }
    Ok((base, headers))
}

#[cfg(test)]
#[path = "codex_concurrency_tests.rs"]
mod concurrency_tests;

#[cfg(test)]
#[path = "codex_auth_snapshot_tests.rs"]
mod auth_snapshot_tests;

fn routing_snapshot(
    command: &tokio::process::Command,
    config: &mut toml::Table,
) -> Result<HashMap<String, String>, SideCallError> {
    let args: Vec<_> = command
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    for pair in args.windows(2).filter(|pair| pair[0] == "-c") {
        let overlay: toml::Table =
            toml::from_str(&pair[1]).map_err(|_| SideCallError::Unavailable)?;
        config.extend(overlay);
    }
    Ok(command
        .as_std()
        .get_envs()
        .filter_map(|(key, value)| {
            value.map(|value| {
                (
                    key.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
        })
        .collect())
}

async fn read_optional(path: &Path) -> Result<Option<String>, SideCallError> {
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(SideCallError::Unavailable),
    };
    let mut bytes = Vec::new();
    file.take((MAX_CONFIG + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| SideCallError::Unavailable)?;
    if bytes.len() > MAX_CONFIG {
        return Err(SideCallError::Unavailable);
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| SideCallError::Unavailable)
}

fn resolve_route(
    config: &toml::Table,
    env: impl Fn(&str) -> Option<String>,
) -> Result<Route, SideCallError> {
    let selected = optional_str(config, "model_provider")?.unwrap_or("openai");
    let provider = config
        .get("model_providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| providers.get(selected));
    let empty = toml::Table::new();
    let provider = match provider {
        Some(provider) => provider.as_table().ok_or(SideCallError::Unavailable)?,
        None if selected == "openai" => &empty,
        None => return Err(SideCallError::Unavailable),
    };
    if optional_str(provider, "wire_api")?.is_some_and(|api| api != "responses")
        || [
            "auth",
            "aws",
            "gateway_oauth",
            "experimental_bearer_token_command",
        ]
        .iter()
        .any(|key| provider.contains_key(*key))
    {
        return Err(SideCallError::Unavailable);
    }
    // Query-param providers (notably Azure) need their own URL contract.
    if provider
        .get("query_params")
        .is_some_and(|value| value.as_table().map_or(true, |table| !table.is_empty()))
    {
        return Err(SideCallError::Unavailable);
    }
    let mut headers = HeaderMap::new();
    if selected == "openai" {
        for (header, key) in [
            ("OpenAI-Organization", "OPENAI_ORGANIZATION"),
            ("OpenAI-Project", "OPENAI_PROJECT"),
        ] {
            if let Some(value) = env(key).filter(|value| !value.trim().is_empty()) {
                insert_header(&mut headers, header, &value)?;
            }
        }
    }
    if let Some(literals) = provider.get("http_headers") {
        for (key, value) in literals.as_table().ok_or(SideCallError::Unavailable)? {
            insert_header(
                &mut headers,
                key,
                value.as_str().ok_or(SideCallError::Unavailable)?,
            )?;
        }
    }
    if let Some(env_headers) = provider.get("env_http_headers") {
        for (key, name) in env_headers.as_table().ok_or(SideCallError::Unavailable)? {
            if let Some(value) = env(name.as_str().ok_or(SideCallError::Unavailable)?)
                .filter(|value| !value.trim().is_empty())
            {
                insert_header(&mut headers, key, &value)?;
            }
        }
    }
    let key = if let Some(name) = provider.get("env_key") {
        Some(
            env(name.as_str().ok_or(SideCallError::Unavailable)?)
                .filter(|value| !value.trim().is_empty())
                .ok_or(SideCallError::Unavailable)?,
        )
    } else {
        optional_str(provider, "experimental_bearer_token")?
            .filter(|key| !key.trim().is_empty())
            .map(str::to_owned)
    };
    let base = optional_str(provider, "base_url")?
        .map(str::to_owned)
        .or_else(|| {
            (selected == "openai")
                .then(|| env("OPENAI_BASE_URL"))
                .flatten()
        });
    if let Some(base) = &base {
        let url = reqwest::Url::parse(base).map_err(|_| SideCallError::Unavailable)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(SideCallError::Unavailable);
        }
    }
    let requires_auth = provider
        .get("requires_openai_auth")
        .map(|value| value.as_bool().ok_or(SideCallError::Unavailable))
        .transpose()?
        .unwrap_or(selected == "openai");
    Ok(Route {
        base,
        headers,
        key,
        requires_auth,
    })
}

fn optional_str<'a>(table: &'a toml::Table, key: &str) -> Result<Option<&'a str>, SideCallError> {
    table
        .get(key)
        .map(|value| value.as_str().ok_or(SideCallError::Unavailable))
        .transpose()
}

fn effective_routing_config(reply: &Value) -> Result<toml::Table, SideCallError> {
    let config = reply
        .get("config")
        .and_then(Value::as_object)
        .ok_or(SideCallError::Unavailable)?;
    let mut minimal = serde_json::Map::new();
    for key in [
        "model_provider",
        "model_providers",
        "preferred_auth_method",
        "cli_auth_credentials_store",
        "chatgpt_base_url",
        "forced_login_method",
        "forced_chatgpt_workspace_id",
        "respect_system_proxy",
        "profile",
        "include",
        "config_files",
        "managed_config",
    ] {
        if let Some(value) = config.get(key).filter(|value| !value.is_null()) {
            minimal.insert(key.into(), without_nulls(value));
        }
    }
    serde_json::from_value(Value::Object(minimal)).map_err(|_| SideCallError::Unavailable)
}

fn without_nulls(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .filter(|(_, value)| !value.is_null())
                .map(|(key, value)| (key.clone(), without_nulls(value)))
                .collect(),
        ),
        Value::Array(array) => Value::Array(array.iter().map(without_nulls).collect()),
        value => value.clone(),
    }
}

fn selected_provider<'a>(
    config: &'a toml::Table,
) -> Result<(&'a str, Option<&'a toml::Table>), SideCallError> {
    let selected = optional_str(config, "model_provider")?.unwrap_or("openai");
    let providers = config
        .get("model_providers")
        .map(|value| value.as_table().ok_or(SideCallError::Unavailable))
        .transpose()?;
    let provider = providers
        .and_then(|providers| providers.get(selected))
        .map(|provider| provider.as_table().ok_or(SideCallError::Unavailable))
        .transpose()?;
    if provider.is_none() && selected != "openai" {
        return Err(SideCallError::Unavailable);
    }
    Ok((selected, provider))
}

fn routing_identity(config: &toml::Table) -> Result<Value, SideCallError> {
    let (selected, provider) = selected_provider(config)?;
    let empty = toml::Table::new();
    let provider = provider.unwrap_or(&empty);
    const KNOWN_PROVIDER_FIELDS: &[&str] = &[
        "name",
        "base_url",
        "model_catalog_url",
        "env_key",
        "env_key_instructions",
        "experimental_bearer_token",
        "auth",
        "gateway_oauth",
        "aws",
        "wire_api",
        "query_params",
        "http_headers",
        "env_http_headers",
        "request_max_retries",
        "stream_max_retries",
        "stream_idle_timeout_ms",
        "websocket_connect_timeout_ms",
        "requires_openai_auth",
        "supports_websockets",
        "supports_standalone_web_search",
    ];
    if provider
        .keys()
        .any(|key| !KNOWN_PROVIDER_FIELDS.contains(&key.as_str()))
    {
        return Err(SideCallError::Unavailable);
    }
    let mut identity = serde_json::Map::new();
    identity.insert("model_provider".into(), json!(selected));
    for key in [
        "base_url",
        "env_key",
        "experimental_bearer_token",
        "http_headers",
        "env_http_headers",
        "query_params",
        "auth",
        "gateway_oauth",
        "aws",
    ] {
        if let Some(value) = provider.get(key) {
            identity.insert(
                key.into(),
                serde_json::to_value(value).map_err(|_| SideCallError::Unavailable)?,
            );
        }
    }
    identity.insert(
        "wire_api".into(),
        json!(optional_str(provider, "wire_api")?.unwrap_or("responses")),
    );
    for key in [
        "preferred_auth_method",
        "forced_login_method",
        "forced_chatgpt_workspace_id",
        "profile",
        "include",
        "config_files",
        "managed_config",
    ] {
        if let Some(value) = config.get(key) {
            identity.insert(
                key.into(),
                serde_json::to_value(value).map_err(|_| SideCallError::Unavailable)?,
            );
        }
    }
    identity.insert(
        "cli_auth_credentials_store".into(),
        json!(optional_str(config, "cli_auth_credentials_store")?.unwrap_or("file")),
    );
    identity.insert(
        "chatgpt_base_url".into(),
        json!(
            optional_str(config, "chatgpt_base_url")?.unwrap_or("https://chatgpt.com/backend-api/")
        ),
    );
    let proxy = config
        .get("respect_system_proxy")
        .map(|value| value.as_bool().ok_or(SideCallError::Unavailable))
        .transpose()?
        .unwrap_or(true);
    identity.insert("respect_system_proxy".into(), json!(proxy));
    Ok(Value::Object(identity))
}

fn validate_effective_routing(
    candidate: &toml::Table,
    reply: &Value,
    env: impl Fn(&str) -> Option<String>,
) -> Result<(), SideCallError> {
    let effective = effective_routing_config(reply)?;
    if routing_identity(candidate)? != routing_identity(&effective)?
        || resolve_route(candidate, &env)? != resolve_route(&effective, &env)?
    {
        return Err(SideCallError::Unavailable);
    }
    Ok(())
}

fn insert_header(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), SideCallError> {
    let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| SideCallError::Unavailable)?;
    let mut value = HeaderValue::from_str(value).map_err(|_| SideCallError::Unavailable)?;
    value.set_sensitive(true);
    headers.insert(name, value);
    Ok(())
}

fn set_bearer(headers: &mut HeaderMap, token: &str) -> Result<(), SideCallError> {
    let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| SideCallError::Unavailable)?;
    value.set_sensitive(true);
    headers.insert(AUTHORIZATION, value);
    Ok(())
}

fn ensure_file_oauth(config: &toml::Table, auth: &Value) -> Result<(), SideCallError> {
    if config
        .get("cli_auth_credentials_store")
        .and_then(toml::Value::as_str)
        .is_some_and(|store| store != "file")
        || auth
            .get("auth_mode")
            .and_then(Value::as_str)
            .is_some_and(|mode| !matches!(mode, "chatgpt" | "chatgptAuthTokens"))
        || [
            "agent_identity",
            "personal_access_token",
            "bedrock_api_key",
            "bedrock_access_keys",
        ]
        .iter()
        .any(|key| auth.get(*key).is_some_and(|value| !value.is_null()))
        || !auth
            .pointer("/tokens/access_token")
            .and_then(Value::as_str)
            .is_some_and(|token| !token.is_empty())
        || !auth
            .pointer("/tokens/account_id")
            .and_then(Value::as_str)
            .is_some_and(|account| !account.is_empty())
    {
        return Err(SideCallError::Unavailable);
    }
    Ok(())
}

fn oauth_metadata<'a>(auth: &'a Value, token: &str) -> Result<(&'a str, bool), SideCallError> {
    if auth.pointer("/tokens/access_token").and_then(Value::as_str) != Some(token) {
        return Err(SideCallError::Unavailable);
    }
    let account = auth
        .pointer("/tokens/account_id")
        .and_then(Value::as_str)
        .filter(|account| !account.is_empty() && account.trim() == *account)
        .ok_or(SideCallError::Unavailable)?;
    // Match the stock bearer auth's FedRAMP routing from the ID token, never
    // derive the selected account from access-token claims.
    let id_token = auth
        .pointer("/tokens/id_token")
        .and_then(Value::as_str)
        .ok_or(SideCallError::Unavailable)?;
    use base64::Engine;
    let claims = id_token
        .split('.')
        .nth(1)
        .ok_or(SideCallError::Unavailable)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(claims.trim_end_matches('='))
        .map_err(|_| SideCallError::Unavailable)?;
    let claims: Value = serde_json::from_slice(&decoded).map_err(|_| SideCallError::Unavailable)?;
    let fedramp = claims
        .pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_is_fedramp")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok((account, fedramp))
}

fn oauth_route(
    base: Option<&str>,
    routing: &Value,
    account: &str,
    headers: &mut HeaderMap,
) -> Result<String, SideCallError> {
    if routing.get("chatgptAccountId").and_then(Value::as_str) != Some(account) {
        return Err(SideCallError::Unavailable);
    }
    let backend = routing
        .get("backendOrigin")
        .and_then(Value::as_str)
        .ok_or(SideCallError::Unavailable)?;
    let backend = reqwest::Url::parse(backend).map_err(|_| SideCallError::Unavailable)?;
    if backend.scheme() != "https"
        || backend.host_str().is_none()
        || !backend.username().is_empty()
        || backend.password().is_some()
        || backend.path() != "/"
        || backend.query().is_some()
        || backend.fragment().is_some()
    {
        return Err(SideCallError::Unavailable);
    }
    let mut url = reqwest::Url::parse(base.unwrap_or(CHATGPT_BASE))
        .map_err(|_| SideCallError::Unavailable)?;
    // Independent OAuth relay destinations need their own routing contract.
    // Accept only the stock inference path at its default/discovered origin.
    let default_origin = reqwest::Url::parse(CHATGPT_BASE)
        .map_err(|_| SideCallError::Unavailable)?
        .origin();
    if url.path() != "/backend-api/codex"
        || (url.origin() != default_origin && url.origin() != backend.origin())
    {
        return Err(SideCallError::Unavailable);
    }
    url.set_scheme(backend.scheme())
        .map_err(|_| SideCallError::Unavailable)?;
    url.set_host(backend.host_str())
        .map_err(|_| SideCallError::Unavailable)?;
    url.set_port(backend.port())
        .map_err(|_| SideCallError::Unavailable)?;
    headers.remove("x-openai-account-routing-override");
    match routing
        .get("accountRoutingOverride")
        .and_then(Value::as_str)
    {
        Some("NO_CONSTRAINT") => {}
        Some(value @ ("us" | "us_cr")) => {
            insert_header(headers, "x-openai-account-routing-override", value)?
        }
        _ => return Err(SideCallError::Unavailable),
    }
    Ok(url.into())
}

async fn stock_snapshot(
    mut command: tokio::process::Command,
    home: &Path,
    candidate: &toml::Table,
    explicit_env: &HashMap<String, String>,
    needs_auth: bool,
) -> Result<Option<AuthSnapshot>, SideCallError> {
    // These are process-only overrides; user auth storage remains owned by
    // Codex. No thread/start, turn/start or chat registry is involved.
    for value in [
        "mcp_servers={}",
        "features.hooks=false",
        "features.apps=false",
        "features.plugins=false",
        "features.remote_plugin=false",
        "features.memories=false",
        "features.goals=false",
        "cloud.skills.enabled=false",
        "notify=[]",
    ] {
        command.args(["-c", value]);
    }
    command
        .current_dir(home)
        .env("PATH", crate::engine::resolve::cli_search_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    crate::engine::hide_console(&mut command);
    crate::development_profile::enforce_homes(&mut command);
    let child = command.spawn().map_err(|_| SideCallError::Unavailable)?;
    let mut guard = ProcessGuard::new(child);
    let mut stdin = guard.child.stdin.take().ok_or(SideCallError::Failed)?;
    let mut stdout = BufReader::new(guard.child.stdout.take().ok_or(SideCallError::Failed)?);
    let stderr = guard.child.stderr.take().ok_or(SideCallError::Failed)?;
    let result = tokio::select! {
        result = async {
            // workspaceRouting is experimental in this version; stable schema
            // exports omit it. Opt in only to read the auth owner's route.
            traced("rpc_initialize_write", rpc_write(&mut stdin, json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"ccgui_auto_title","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}})).await)?;
            let initialized = traced("rpc_initialize", rpc_reply(&mut stdout, 1).await)?;
            let user_agent = initialized.get("userAgent").and_then(Value::as_str).ok_or(SideCallError::Unavailable)?;
            traced("rpc_initialized_write", rpc_write(&mut stdin, json!({"method":"initialized","params":{}})).await)?;
            traced("rpc_config_read_write", rpc_write(&mut stdin, json!({"id":2,"method":"config/read","params":{"includeLayers":false}})).await)?;
            let effective = traced("rpc_config_read", rpc_reply(&mut stdout, 2).await)?;
            traced("routing_config", validate_effective_routing(candidate, &effective, |key| explicit_env.get(key).cloned().or_else(|| std::env::var(key).ok())))?;
            if !needs_auth { return Ok(None); }
            let route = resolve_route(candidate, |key| explicit_env.get(key).cloned().or_else(|| std::env::var(key).ok()))?;
            read_stock_auth(&mut stdin, &mut stdout, candidate, route.base.as_deref(), user_agent, || async {
                read_optional(&home.join("auth.json")).await?.ok_or(SideCallError::Unavailable)
            }).await.map(Some)
        } => result,
        _ = drain_stderr(stderr) => Err(SideCallError::Failed),
    };
    guard.stop();
    // Drop is the abort backstop. The enclosing total timeout includes reaping.
    let _ = guard.child.wait().await;
    result
}

// Keep RPC identity, routing and file metadata in one verified snapshot while
// the auth owner is alive. An external refresh may rotate the file between RPCs;
// only a same-account token mismatch permits one non-refreshing reread.
async fn read_stock_auth<W, R, F, Fut>(
    stdin: &mut W,
    stdout: &mut BufReader<R>,
    config: &toml::Table,
    base: Option<&str>,
    user_agent: &str,
    mut read_file: F,
) -> Result<AuthSnapshot, SideCallError>
where
    W: AsyncWrite + Unpin,
    R: AsyncRead + Unpin,
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<String, SideCallError>>,
{
    let mut account_anchor: Option<String> = None;
    for attempt in 0..2u64 {
        let auth_id = 3 + attempt * 2;
        let account_id = auth_id + 1;
        super::diagnostics::active_phase("rpc_auth_status");
        traced(
            "rpc_auth_status_write",
            rpc_write(stdin, json!({
                "id": auth_id,
                "method": "getAuthStatus",
                "params": {"includeToken": true, "refreshToken": attempt == 0}
            })).await,
        )?;
        let auth = traced("rpc_auth_status", rpc_reply(stdout, auth_id).await)?;
        let mode = traced(
            "auth_mode",
            auth.get("authMethod")
                .and_then(Value::as_str)
                .filter(|mode| *mode == "chatgpt" || (attempt == 0 && *mode == "apikey"))
                .ok_or(SideCallError::Unavailable),
        )?;
        let token = traced(
            "auth_token",
            auth.get("authToken")
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
                .ok_or(SideCallError::Unavailable),
        )?;
        if mode == "apikey" {
            return Ok(AuthSnapshot {
                mode: mode.into(),
                token: token.into(),
                user_agent: user_agent.into(),
                workspace_routing: None,
                oauth: None,
            });
        }
        super::diagnostics::active_phase("rpc_account_read");
        traced(
            "rpc_account_read_write",
            rpc_write(stdin, json!({
                "id": account_id,
                "method": "account/read",
                "params": {"refreshToken": false}
            })).await,
        )?;
        let account = traced("rpc_account_read", rpc_reply(stdout, account_id).await)?;
        traced(
            "oauth_account_type",
            if account.pointer("/account/type").and_then(Value::as_str) == Some("chatgpt") {
                Ok(())
            } else {
                Err(SideCallError::Unavailable)
            },
        )?;
        let routing = traced(
            "oauth_routing",
            account.get("workspaceRouting")
                .filter(|routing| routing.is_object())
                .ok_or(SideCallError::Unavailable),
        )?;
        let selected = traced(
            "oauth_account",
            routing.get("chatgptAccountId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.trim() == *id)
                .ok_or(SideCallError::Unavailable),
        )?;
        if account_anchor.as_deref().is_some_and(|anchor| anchor != selected) {
            return traced("oauth_account_changed", Err(SideCallError::Unavailable));
        }
        account_anchor.get_or_insert_with(|| selected.to_owned());
        super::diagnostics::active_phase("oauth_file_read");
        let text = traced("oauth_file_read", read_file().await)?;
        let file: Value = traced(
            "oauth_file_json",
            serde_json::from_str(&text).map_err(|_| SideCallError::Unavailable),
        )?;
        traced("oauth_file_identity", ensure_file_oauth(config, &file))?;
        let file_token = file.pointer("/tokens/access_token")
            .and_then(Value::as_str)
            .ok_or(SideCallError::Unavailable)?;
        // Validate all metadata and routing even on mismatch: a malformed or
        // changed identity must never become a reason to retry authentication.
        let (file_account, fedramp) = traced(
            "oauth_file_metadata",
            oauth_metadata(&file, file_token),
        )?;
        if file_account != selected {
            return traced("oauth_account_changed", Err(SideCallError::Unavailable));
        }
        traced(
            "oauth_routing",
            oauth_route(base, routing, file_account, &mut HeaderMap::new()),
        )?;
        if file_token == token {
            return Ok(AuthSnapshot {
                mode: mode.into(),
                token: token.into(),
                user_agent: user_agent.into(),
                workspace_routing: Some(routing.clone()),
                oauth: Some(VerifiedOauth {
                    account: file_account.into(),
                    fedramp,
                    file_hash: sha256_bytes(text.as_bytes()),
                }),
            });
        }
        // Do not record a recoverable mismatch as the call's first failure.
    }
    traced("oauth_token_mismatch", Err(SideCallError::Unavailable))
}

async fn drain_stderr(mut pipe: impl AsyncRead + Unpin) {
    let mut bytes = [0u8; 4096];
    let mut total = 0usize;
    while let Ok(count) = pipe.read(&mut bytes).await {
        if count == 0 {
            break;
        }
        total += count;
        if total > super::MAX_STDERR {
            break;
        }
    }
}

async fn rpc_write(
    pipe: &mut (impl AsyncWrite + Unpin),
    value: Value,
) -> Result<(), SideCallError> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| SideCallError::Failed)?;
    bytes.push(b'\n');
    pipe.write_all(&bytes)
        .await
        .map_err(|_| SideCallError::Failed)?;
    pipe.flush().await.map_err(|_| SideCallError::Failed)
}

async fn rpc_reply(
    pipe: &mut BufReader<impl AsyncRead + Unpin>,
    id: u64,
) -> Result<Value, SideCallError> {
    let mut total = 0usize;
    loop {
        let mut line = Vec::new();
        loop {
            let available = pipe.fill_buf().await.map_err(|_| SideCallError::Failed)?;
            if available.is_empty() {
                return Err(SideCallError::Failed);
            }
            let count = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |index| index + 1);
            if count > MAX_OUTPUT.saturating_sub(total) {
                eprintln!("[side-call] codex stage=rpc_stdout_limit error=BadOutput total_bytes={total} chunk_bytes={count}");
                return Err(SideCallError::BadOutput);
            }
            let complete = available[count - 1] == b'\n';
            line.extend_from_slice(&available[..count]);
            total += count;
            pipe.consume(count);
            if complete {
                break;
            }
        }
        let value: Value = serde_json::from_slice(&line).map_err(|_| {
            eprintln!(
                "[side-call] codex stage=rpc_stdout_json error=BadOutput line_bytes={}",
                line.len()
            );
            SideCallError::BadOutput
        })?;
        // A server request would require executing a capability; this flow has
        // none. Notifications can be ignored without retaining their payload.
        if value.get("method").is_some() {
            if value.get("id").is_some() {
                return Err(SideCallError::Unavailable);
            }
            continue;
        }
        if value.get("id").and_then(Value::as_u64) == Some(id) {
            if value.get("error").is_some() {
                return Err(SideCallError::Unavailable);
            }
            return value.get("result").cloned().ok_or(SideCallError::BadOutput);
        }
    }
}

fn request_body(call: &StructuredCall<'_>) -> Result<Value, SideCallError> {
    if call.model.trim().is_empty()
        || !matches!(
            call.effort,
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        )
    {
        return Err(SideCallError::Unavailable);
    }
    Ok(json!({
        "model":call.model,"instructions":call.system_prompt,
        "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":call.input}]}],
        "tools":[],"tool_choice":"auto","parallel_tool_calls":false,
        "reasoning":{"effort":call.effort},"store":false,"stream":true,"include":[],
        "text":{"format":{"type":"json_schema","strict":true,"name":"session_title","schema":call.json_schema}}
    }))
}

async fn complete_http(
    call: &StructuredCall<'_>,
    base: &str,
    mut headers: HeaderMap,
) -> Result<SideCallOutput, SideCallError> {
    headers.insert("accept", HeaderValue::from_static("text/event-stream"));
    // This client has no compression decoder enabled. Ask for identity rather
    // than advertise encodings that would turn a valid response into binary.
    headers.insert("accept-encoding", HeaderValue::from_static("identity"));
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| SideCallError::Unavailable)?;
    super::diagnostics::active_phase("http_headers");
    let mut response = traced(
        "http_send",
        client
            .post(format!("{}/responses", base.trim_end_matches('/')))
            .headers(headers)
            .json(&request_body(call)?)
            .send()
            .await
            .map_err(|_| SideCallError::Failed),
    )?;
    super::diagnostics::record_http_status(response.status().as_u16());
    if !response.status().is_success() {
        let status_code = response.status().as_u16();
        if matches!(status_code, 401 | 403) {
            invalidate_prepared_route();
        }
        super::diagnostics::record("http_status");
        eprintln!(
            "[side-call] codex stage=http_status error=Failed status={}",
            status_code
        );
        return Err(SideCallError::Failed);
    }
    let mut sse = response
        .headers()
        .get("content-type")
        .and_then(|header| header.to_str().ok())
        .is_some_and(|content| {
            content
                .split(';')
                .next()
                .is_some_and(|content| content.trim().eq_ignore_ascii_case("text/event-stream"))
        });
    let encoding = match response
        .headers()
        .get("content-encoding")
        .and_then(|header| header.to_str().ok())
        .map(str::trim)
    {
        None | Some("") | Some("identity") => "identity",
        Some("gzip") => "gzip",
        Some("deflate") => "deflate",
        Some("br") => "br",
        Some("zstd") => "zstd",
        _ => "other",
    };
    let response_stage = if sse {
        "http_response_sse"
    } else {
        "http_response_json"
    };
    eprintln!(
        "[side-call] codex stage={response_stage} status={}",
        response.status().as_u16()
    );
    let mut collected = Vec::new();
    let mut state = SseState::default();
    let mut total = 0usize;
    let mut prefix_checked = false;
    super::diagnostics::body_started();
    loop {
        super::diagnostics::active_phase(if sse { "http_stream_wait" } else { "http_json_body_wait" });
        let Some(chunk) = traced(
            "http_stream_read",
            response.chunk().await.map_err(|_| SideCallError::Failed),
        )? else { break; };
        super::diagnostics::received_bytes(chunk.len());
        total = total
            .checked_add(chunk.len())
            .ok_or_else(|| bad_output("http_stream_limit"))?;
        if total > MAX_STREAM_BYTES {
            eprintln!(
                "[side-call] codex stage=http_stream_limit error=BadOutput total_bytes={total}"
            );
            return Err(bad_output("http_stream_limit"));
        }
        collected.extend_from_slice(&chunk);
        if !prefix_checked && collected.len() >= 3 {
            prefix_checked = true;
            if collected.starts_with(&[0xef, 0xbb, 0xbf]) {
                collected.drain(..3);
            }
        }
        // Compatible gateways sometimes label a Responses event stream as
        // JSON. Recognize only standard SSE field framing, then retain the
        // same strict completion, tool/refusal and final-JSON validation.
        if !sse && looks_like_sse(&collected) {
            sse = true;
            eprintln!("[side-call] codex stage=http_response_sse_detected");
        }
        if sse {
            if let Some(output) = consume_sse_frames(&mut collected, &mut state)? {
                return Ok(output);
            }
        } else if collected.len() > MAX_OUTPUT {
            return Err(bad_output("http_json_limit"));
        }
    }
    if sse {
        eprintln!("[side-call] codex stage=sse_missing_completion error=BadOutput total_bytes={total} pending_bytes={}", collected.len());
        return Err(bad_output("sse_missing_completion"));
    }
    let response: Value = serde_json::from_slice(&collected).map_err(|_| {
        eprintln!("[side-call] codex stage=http_response_json error=BadOutput encoding={encoding} body_kind={} total_bytes={total}", body_kind(&collected));
        bad_output("http_response_json")
    })?;
    parse_nonstreamed(&response)
}

fn parse_nonstreamed(response: &Value) -> Result<SideCallOutput, SideCallError> {
    // Unlike SSE, a JSON envelope has no response.completed event proving that
    // generation finished. Missing or incorrectly typed status is not success.
    if response.get("status").and_then(Value::as_str) != Some("completed")
        && response.get("status").and_then(Value::as_str) != Some("failed")
        && !response.get("error").is_some_and(|value| !value.is_null())
    {
        return Err(bad_output("final_response_status"));
    }
    parse_completed(response, &[])
}

fn consume_sse_frames(
    collected: &mut Vec<u8>,
    state: &mut SseState,
) -> Result<Option<SideCallOutput>, SideCallError> {
    let mut consumed = 0;
    while let Some((end, width)) = frame_boundary(&collected[consumed..]) {
        if end > MAX_SSE_FRAME_BYTES {
            return Err(bad_output("sse_frame_limit"));
        }
        let frame = traced(
            "sse_utf8",
            std::str::from_utf8(&collected[consumed..consumed + end])
                .map_err(|_| SideCallError::BadOutput),
        )?;
        if let Some(output) = state.frame(frame)? {
            return Ok(Some(output));
        }
        consumed += end + width;
    }
    collected.drain(..consumed);
    // A chunk can contain many valid frames. Limit only the remaining single
    // incomplete frame, allowing a split CRLF delimiter at the limit.
    if collected.len() > MAX_SSE_FRAME_BYTES + 3 {
        return Err(bad_output("sse_frame_limit"));
    }
    Ok(None)
}

fn looks_like_sse(bytes: &[u8]) -> bool {
    let bytes = bytes.trim_ascii_start();
    [b":".as_slice(), b"data:", b"event:", b"id:", b"retry:"]
        .iter()
        .any(|prefix| bytes.starts_with(prefix))
}

/// Closed shape labels only: never print a byte from an upstream body.
fn body_kind(bytes: &[u8]) -> &'static str {
    let bytes = bytes.trim_ascii_start();
    if bytes.is_empty() {
        "empty"
    } else if bytes.starts_with(&[0x1f, 0x8b]) {
        "gzip"
    } else if bytes.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        "zstd"
    } else if looks_like_sse(bytes) {
        "sse"
    } else if matches!(bytes.first(), Some(b'{' | b'[')) {
        "json"
    } else if bytes.starts_with(b"<") {
        "html"
    } else if std::str::from_utf8(bytes).is_ok() {
        "text"
    } else {
        "binary"
    }
}

fn frame_boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    // Stop at the first boundary of either kind. Scanning the entire remainder
    // for CRLF for every LF frame makes a coalesced chunk quadratic to parse.
    for (position, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' && bytes.get(position + 1) == Some(&b'\n') {
            return Some((position, 2));
        }
        if *byte == b'\r' && bytes[position..].starts_with(b"\r\n\r\n") {
            return Some((position, 4));
        }
    }
    None
}

#[derive(Default)]
struct SseState {
    items: Vec<Value>,
}

impl SseState {
    fn frame(&mut self, frame: &str) -> Result<Option<SideCallOutput>, SideCallError> {
        let data = frame
            .lines()
            .filter_map(|line| {
                line.strip_prefix("data:")
                    .map(|data| data.strip_prefix(' ').unwrap_or(data))
            })
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            return Ok(None);
        }
        if data == "[DONE]" {
            eprintln!("[side-call] codex stage=sse_done_before_completion error=BadOutput");
            return Err(bad_output("sse_done_before_completion"));
        }
        let event: Value = traced(
            "sse_json",
            serde_json::from_str(&data).map_err(|_| SideCallError::BadOutput),
        )?;
        super::diagnostics::sse_event(event.get("type").and_then(Value::as_str).unwrap_or(""));
        let kind = traced(
            "sse_event_type",
            event
                .get("type")
                .and_then(Value::as_str)
                .ok_or(SideCallError::BadOutput),
        )?;
        if kind.contains("tool_call")
            || kind.contains("function_call")
            || matches!(
                kind,
                "error"
                    | "response.failed"
                    | "response.incomplete"
                    | "response.output_text.refusal"
                    | "response.refusal.delta"
                    | "response.refusal.done"
            )
        {
            let stage = match kind {
                "error" => "sse_error",
                "response.failed" => "sse_response_failed",
                "response.incomplete" => "sse_response_incomplete",
                "response.output_text.refusal"
                | "response.refusal.delta"
                | "response.refusal.done" => "sse_refusal",
                _ => "sse_tool_call",
            };
            let error = if matches!(kind, "error" | "response.failed") {
                SideCallError::Failed
            } else {
                SideCallError::BadOutput
            };
            return traced(stage, Err(error));
        }
        match kind {
            "response.output_item.added" | "response.output_item.done" => {
                let item = event
                    .get("item")
                    .ok_or_else(|| bad_output("sse_missing_item"))?;
                traced("sse_output_item", check_item(item))?;
                if kind.ends_with("done") {
                    self.items.push(item.clone());
                }
                Ok(None)
            }
            "response.completed" => parse_completed(
                event
                    .get("response")
                    .ok_or_else(|| bad_output("sse_missing_response"))?,
                &self.items,
            )
            .map(Some),
            _ => Ok(None),
        }
    }
}

fn message_phase(item: &Value) -> &'static str {
    match item.get("phase") {
        None | Some(Value::Null) => "legacy",
        Some(Value::String(phase)) if phase == "commentary" => "commentary",
        Some(Value::String(phase)) if phase == "final_answer" => "final_answer",
        _ => "unknown",
    }
}

fn check_item(item: &Value) -> Result<(), SideCallError> {
    let result = match item.get("type").and_then(Value::as_str) {
        Some("reasoning") => Ok(()),
        Some("message") if item.get("role").and_then(Value::as_str) == Some("assistant") => {
            match item.get("content").and_then(Value::as_array) {
                Some(content)
                    if message_phase(item) != "unknown"
                        && content.iter().all(|part| {
                            part.get("type").and_then(Value::as_str) == Some("output_text")
                        }) =>
                {
                    Ok(())
                }
                _ => Err(SideCallError::BadOutput),
            }
        }
        _ => Err(SideCallError::BadOutput),
    };
    if result.is_err() {
        super::diagnostics::record("item_shape");
        let item_type = match item.get("type").and_then(Value::as_str) {
            Some("message") => "message",
            Some("reasoning") => "reasoning",
            Some("agent_message") => "agent_message",
            Some("function_call") => "function_call",
            Some("custom_tool_call") => "custom_tool_call",
            Some("local_shell_call") => "local_shell_call",
            _ => "unknown",
        };
        let phase = message_phase(item);
        let parts = item
            .get("content")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        eprintln!("[side-call] codex stage=item_shape error=BadOutput type={item_type} phase={phase} content_parts={parts}");
    }
    result
}

fn parse_completed(
    response: &Value,
    completed_items: &[Value],
) -> Result<SideCallOutput, SideCallError> {
    if response.get("error").is_some_and(|value| !value.is_null())
        || response.get("status").and_then(Value::as_str) == Some("failed")
    {
        return traced("final_response_failed", Err(SideCallError::Failed));
    }
    if !response.is_object()
        || response
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status != "completed")
        || response
            .get("incomplete_details")
            .is_some_and(|value| !value.is_null())
        || response.get("end_turn").and_then(Value::as_bool) == Some(false)
    {
        eprintln!("[side-call] codex stage=final_response_status error=BadOutput");
        return Err(bad_output("final_response_status"));
    }
    let items = response
        .get("output")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .map(Vec::as_slice)
        .unwrap_or(completed_items);
    let mut candidates = Vec::new();
    let (mut commentary_count, mut final_count, mut legacy_count) = (0usize, 0usize, 0usize);
    for item in items {
        traced("final_output_item", check_item(item))?;
        if item.get("type").and_then(Value::as_str) == Some("message") {
            if item
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|status| status != "completed")
            {
                eprintln!("[side-call] codex stage=final_message_status error=BadOutput");
                return Err(bad_output("final_message_status"));
            }
            match message_phase(item) {
                "commentary" => {
                    commentary_count += 1;
                    continue;
                }
                "final_answer" => final_count += 1,
                "legacy" => legacy_count += 1,
                _ => return Err(bad_output("final_message_phase")),
            }
            candidates.push(item);
        }
    }
    // Official MessagePhase distinguishes progress narration from a terminal
    // answer. Legacy Responses retain compatibility only with one unambiguous
    // assistant message; multiple answers cannot form one schema JSON value.
    if candidates.len() != 1 {
        eprintln!("[side-call] codex stage=final_message_selection error=BadOutput commentary_count={commentary_count} final_count={final_count} legacy_count={legacy_count}");
        return Err(bad_output("final_message_selection"));
    }
    let message = candidates[0];
    let mut text = String::new();
    for part in message
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| bad_output("final_message_content"))?
    {
        let part = traced(
            "final_message_text",
            part.get("text")
                .and_then(Value::as_str)
                .ok_or(SideCallError::BadOutput),
        )?;
        if text.len().saturating_add(part.len()) > MAX_OUTPUT {
            return Err(bad_output("final_text_limit"));
        }
        text.push_str(part);
    }
    let structured: Value = serde_json::from_str(&text).map_err(|_| {
        eprintln!("[side-call] codex stage=final_json error=BadOutput commentary_count={commentary_count} final_count={final_count} legacy_count={legacy_count} text_bytes={}", text.len());
        bad_output("final_json")
    })?;
    if !structured.is_object() {
        eprintln!(
            "[side-call] codex stage=final_json_shape error=BadOutput text_bytes={}",
            text.len()
        );
        return Err(bad_output("final_json_shape"));
    }
    Ok(SideCallOutput {
        structured,
        usage: response
            .get("usage")
            .filter(|value| !value.is_null())
            .cloned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::net::TcpListener;

    fn call<'a>(schema: &'a Value) -> StructuredCall<'a> {
        StructuredCall {
            provider_id: None,
            system_prompt: "Return a title",
            input: "fixture input",
            json_schema: schema,
            model: "gpt-6.1-sol",
            effort: "high",
            timeout: Duration::from_secs(3),
        }
    }
    fn message(text: &str) -> Value {
        json!({"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text}]})
    }
    fn completed(text: &str) -> Value {
        json!({"status":"completed","output":[message(text)],"usage":{"input_tokens":8,"output_tokens":4}})
    }

    #[tokio::test(start_paused = true)]
    async fn handoff_deadline_allows_completion_after_the_old_sixty_second_cutoff() {
        let schema = json!({"type":"object"});
        let mut selected = call(&schema);
        selected.effort = "max";
        selected.timeout = crate::app_cache::HANDOFF_TIMEOUT;
        let started = tokio::time::Instant::now();
        let output = completion_deadline(selected.timeout, async {
            let body = request_body(&selected)?;
            assert_eq!(body["model"], "gpt-6.1-sol");
            assert_eq!(body["reasoning"]["effort"], "max");
            tokio::time::sleep(Duration::from_secs(61)).await;
            let terminal = json!({"type":"response.completed", "response":completed(r#"{"summary":"保留完整摘要和待验证事项。"}"#)});
            SseState::default().frame(&format!("data: {terminal}"))?.ok_or(SideCallError::BadOutput)
        }).await.unwrap();
        assert_eq!(started.elapsed(), Duration::from_secs(61));
        assert_eq!(output.structured["summary"], "保留完整摘要和待验证事项。");
    }

    // A real loopback body remains open until the client drops it. No account,
    // engine startup or external endpoint is involved, and extra requests fail.
    async fn stalled_stream(prefix: String, heartbeat: bool) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 2048];
            loop {
                let count = stream.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = std::str::from_utf8(&request[..end]).unwrap();
                    let length: usize = head.lines().find_map(|line| line.to_ascii_lowercase()
                        .strip_prefix("content-length:").map(|value| value.trim().parse().unwrap())).unwrap();
                    if request.len() >= end + 4 + length { break; }
                }
            }
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            stream.write_all(prefix.as_bytes()).await.unwrap();
            loop {
                tokio::select! {
                    _ = listener.accept() => panic!("completion must not issue a duplicate request"),
                    result = stream.read(&mut buffer) => {
                        match result {
                            Ok(0) => {},
                            Err(error) if matches!(error.kind(), std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::BrokenPipe) => {},
                            other => panic!("client must drop its stalled response: {other:?}"),
                        }
                        break;
                    },
                    _ = tokio::time::sleep(Duration::from_millis(10)), if heartbeat => {
                        if stream.write_all(b": heartbeat\n\n").await.is_err() { break; }
                    },
                }
            }
        });
        (url, task)
    }

    #[tokio::test]
    async fn stalled_http_200_and_heartbeat_only_streams_keep_deadline_diagnostics() {
        let schema = json!({"type":"object"});
        for (prefix, events, last_event, heartbeat) in [
            (": heartbeat\n\n".to_owned(), 0, None, true),
            // A valid unknown event and an unfinished terminal frame must not
            // be accepted as completion, even while the connection stays open.
            ("data: {\"type\":\"private-unknown-event\"}\n\ndata: {\"type\":\"response.completed\"".to_owned(), 1, Some("other"), false),
        ] {
            let (base, server) = stalled_stream(prefix.clone(), heartbeat).await;
            let deadline = Duration::from_millis(200);
            let failure = super::super::diagnostics::capture(completion_deadline(deadline,
                complete_http(&call(&schema), &base, HeaderMap::new()),
            )).await.unwrap_err();
            assert_eq!(failure.kind, SideCallError::Timeout);
            assert_eq!(failure.stage, Some("http_stream_wait"));
            assert_eq!(failure.http_status, Some(200));
            assert_eq!(failure.timeout_ms, Some(200));
            assert!(failure.received_bytes.unwrap() >= prefix.len() as u64);
            assert_eq!(failure.sse_events, Some(events));
            assert_eq!(failure.last_event, last_event);
            assert!(!format!("{failure:?}").contains("private-unknown-event"));
            tokio::time::timeout(Duration::from_secs(2), server).await.unwrap().unwrap();
        }
    }

    async fn fixture(
        body: Vec<u8>,
        content_type: &str,
        status: &str,
    ) -> (String, tokio::task::JoinHandle<(String, Value)>) {
        fixture_chunked(body, content_type, status, 7).await
    }

    async fn fixture_chunked(
        body: Vec<u8>,
        content_type: &str,
        status: &str,
        chunk_size: usize,
    ) -> (String, tokio::task::JoinHandle<(String, Value)>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let content_type = content_type.to_owned();
        let status = status.to_owned();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 2048];
            let (head, value) = loop {
                let count = stream.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                request.extend_from_slice(&chunk[..count]);
                if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    let head = String::from_utf8(request[..end].to_vec()).unwrap();
                    let length: usize = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    if request.len() >= end + 4 + length {
                        break (
                            head,
                            serde_json::from_slice(&request[end + 4..end + 4 + length]).unwrap(),
                        );
                    }
                }
            };
            let head_out = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            stream.write_all(head_out.as_bytes()).await.unwrap();
            // Split through UTF-8 and SSE delimiters to exercise byte framing.
            for chunk in body.chunks(chunk_size) {
                if stream.write_all(chunk).await.is_err() {
                    break;
                }
            }
            (head, value)
        });
        (url, task)
    }

    fn fixture_stock(reply: &Value) -> tokio::process::Command {
        // Development Node is the fake stdio peer. It has no account files,
        // hooks, tools, network calls or access to the user's stock CLI.
        let script = format!(
            r#"
            const readline = await import('node:readline');
            const configReply = {};
            for await (const line of readline.createInterface({{ input: process.stdin }})) {{
                const request = JSON.parse(line);
                if (request.method === 'initialize') {{
                    process.stdout.write(JSON.stringify({{ id: request.id, result: {{ userAgent: 'fixture-cli/0.159.2' }} }}) + '\n');
                }} else if (request.method === 'config/read') {{
                    process.stdout.write(JSON.stringify({{ id: request.id, result: configReply }}) + '\n');
                }} else if (request.id !== undefined) {{
                    process.stdout.write(JSON.stringify({{ id: request.id, error: {{ code: -32601, message: 'Unsupported fixture request' }} }}) + '\n');
                }}
            }}
        "#,
            reply
        );
        let mut command = command_for_binary("node");
        command.args(["--input-type=module", "--eval", &script, "--"]);
        command
    }

    #[tokio::test]
    async fn api_key_request_has_selected_model_effort_schema_and_no_tools_or_storage() {
        let body = serde_json::to_vec(&completed(r#"{"title":"测试标题"}"#)).unwrap();
        let (base, server) = fixture(body, "application/json", "200 OK").await;
        let config: toml::Table = toml::from_str(&format!("model_provider='relay'\n[model_providers.relay]\nbase_url='{base}'\nwire_api='responses'\nenv_key='FIXTURE_KEY'\n[model_providers.relay.http_headers]\nx-route='literal'\n[model_providers.relay.env_http_headers]\nx-route='ROUTE_HEADER'\n")).unwrap();
        let route = resolve_route(&config, |key| match key {
            "FIXTURE_KEY" => Some("test-only-key".into()),
            "ROUTE_HEADER" => Some("env-wins".into()),
            _ => None,
        })
        .unwrap();
        let mut headers = route.headers;
        set_bearer(&mut headers, route.key.as_deref().unwrap()).unwrap();
        let schema = json!({"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false});
        let output = complete_http(&call(&schema), route.base.as_deref().unwrap(), headers)
            .await
            .unwrap();
        assert_eq!(output.structured["title"], "测试标题");
        let (headers, request) = server.await.unwrap();
        assert!(headers.starts_with("POST /responses "));
        assert!(headers
            .to_lowercase()
            .contains("authorization: bearer test-only-key"));
        assert!(headers.to_lowercase().contains("x-route: env-wins"));
        assert!(headers.to_lowercase().contains("accept-encoding: identity"));
        assert_eq!(request["model"], "gpt-6.1-sol");
        assert_eq!(request["reasoning"]["effort"], "high");
        assert_eq!(request["tools"], json!([]));
        assert_eq!(request["store"], false);
        assert_eq!(request["parallel_tool_calls"], false);
        assert_eq!(request["text"]["format"]["schema"], schema);
    }

    #[tokio::test]
    async fn subscription_sse_uses_authoritative_completed_items_and_requires_completion() {
        let item =
            json!({"type":"response.output_item.done","item":message(r#"{"title":"订阅标题"}"#)});
        let terminal = json!({"type":"response.completed","response":{"status":"completed","output":[],"usage":{"output_tokens":5}}});
        let body =
            format!(": heartbeat\r\n\r\ndata: {item}\r\n\r\ndata: {terminal}\r\n\r\n").into_bytes();
        let (base, server) = fixture(body, "text/event-stream; charset=utf-8", "200 OK").await;
        let schema = json!({"type":"object"});
        let output = complete_http(&call(&schema), &base, HeaderMap::new())
            .await
            .unwrap();
        assert_eq!(output.structured["title"], "订阅标题");
        assert_eq!(output.usage.unwrap()["output_tokens"], 5);
        server.await.unwrap();
        let (base, server) = fixture(
            format!("data: {item}\n\n").into_bytes(),
            "text/event-stream",
            "200 OK",
        )
        .await;
        assert_eq!(
            complete_http(&call(&schema), &base, HeaderMap::new())
                .await
                .unwrap_err(),
            SideCallError::BadOutput
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn commentary_is_excluded_from_chunked_final_schema_json() {
        let answer =
            json!({"action":"rename","title":"🧩 中文与emoji｜核查流式标题","reason":"测试"});
        let mut commentary = message("这段中间说明不是 JSON。正在整理标题。🔎");
        commentary["phase"] = json!("commentary");
        let mut final_answer = message(&serde_json::to_string(&answer).unwrap());
        final_answer["phase"] = json!("final_answer");
        let added = json!({"type":"response.output_item.added","item":commentary});
        let intermediate = json!({"type":"response.output_item.done","item":commentary});
        let final_item = json!({"type":"response.output_item.done","item":final_answer});
        let terminal = json!({"type":"response.completed","response":{"status":"completed","output":[commentary,final_answer],"end_turn":true}});
        let body = format!("data: {added}\r\n\r\ndata: {intermediate}\r\n\r\ndata: {final_item}\r\n\r\ndata: {terminal}\r\n\r\n").into_bytes();
        let (base, server) = fixture(body, "text/event-stream", "200 OK").await;
        let schema = json!({"type":"object"});
        let output = complete_http(&call(&schema), &base, HeaderMap::new())
            .await
            .unwrap();
        assert_eq!(
            output.structured, answer,
            "final text must retain Chinese and emoji without intermediate narration"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn response_sse_survives_json_or_missing_mime_without_relaxing_validation() {
        let answer =
            json!({"action":"rename","title":"\u{1f4a7} 雨水滤网｜说明作用","reason":"测试"});
        let terminal =
            json!({"type":"response.completed","response":completed(&answer.to_string())});
        for mime in ["application/json", "", "Text/Event-Stream; charset=utf-8"] {
            let body = format!("\u{feff}: heartbeat\r\n\r\ndata: {terminal}\r\n\r\n").into_bytes();
            let (base, server) = fixture(body, mime, "200 OK").await;
            let schema = json!({"type":"object"});
            assert_eq!(
                complete_http(&call(&schema), &base, HeaderMap::new())
                    .await
                    .unwrap()
                    .structured,
                answer
            );
            server.await.unwrap();
        }
        let incomplete = b"data: {\"type\":\"response.created\"}\n\n".to_vec();
        let (base, server) = fixture(incomplete, "application/json", "200 OK").await;
        let schema = json!({"type":"object"});
        assert_eq!(
            complete_http(&call(&schema), &base, HeaderMap::new())
                .await
                .unwrap_err(),
            SideCallError::BadOutput
        );
        server.await.unwrap();
    }

    #[test]
    fn body_shape_diagnostics_are_closed_and_do_not_expose_upstream_text() {
        for (bytes, expected) in [
            (b"".as_slice(), "empty"),
            (b" \n{}", "json"),
            (b"data: private response", "sse"),
            (b"<html>private response", "html"),
            (b"private response", "text"),
            (&[0xff, 0x00], "binary"),
            (&[0x1f, 0x8b, 0x00], "gzip"),
            (&[0x28, 0xb5, 0x2f, 0xfd], "zstd"),
        ] {
            assert_eq!(body_kind(bytes), expected);
        }
    }

    #[tokio::test]
    #[ignore = "explicitly enabled live Codex account smoke test"]
    async fn live_codex_naming_smoke() {
        assert_eq!(
            std::env::var("CCGUI_CODEX_LIVE_TITLE_TEST").as_deref(),
            Ok("1")
        );
        let schema = json!({"type":"object","properties":{"action":{"type":"string","enum":["keep","rename"]},"title":{"type":"string"},"reason":{"type":"string"}},"required":["action","title","reason"],"additionalProperties":false});
        let result = structured(StructuredCall {
            provider_id: None,
            system_prompt: include_str!("../../auto_title/naming.md"),
            input: "这是隔离的 CC GUI 命名验收。用户请求：请用三句话说明雨水收集装置中滤网的作用。仅文本回答，不调用工具、不访问文件。当前标题是首条用户消息，请生成简短标题。",
            json_schema: &schema,
            model: "gpt-6.1-sol",
            effort: "low",
            timeout: Duration::from_secs(60),
        }).await.unwrap();
        assert!(result
            .structured
            .get("title")
            .and_then(Value::as_str)
            .is_some_and(|title| !title.is_empty()));
        assert!(matches!(
            result.structured.get("action").and_then(Value::as_str),
            Some("rename" | "keep")
        ));
    }

    #[test]
    fn unknown_phases_and_multiple_possible_final_messages_are_rejected() {
        let valid = message(r#"{"title":"🧩 对象｜目标"}"#);
        for phase in [json!("unknown"), json!("final"), json!(1)] {
            let mut item = valid.clone();
            item["phase"] = phase;
            assert_eq!(
                parse_completed(&json!({"status":"completed","output":[item]}), &[]).unwrap_err(),
                SideCallError::BadOutput
            );
        }
        let mut explicit_final = valid.clone();
        explicit_final["phase"] = json!("final_answer");
        let mut commentary = valid.clone();
        commentary["phase"] = json!("commentary");
        for items in [
            vec![message(r#"{"title":"#), message(r#""split"}"#)],
            vec![valid.clone(), explicit_final.clone()],
            vec![explicit_final.clone(), explicit_final],
            vec![commentary],
        ] {
            assert_eq!(
                parse_completed(&json!({"status":"completed","output":items}), &[]).unwrap_err(),
                SideCallError::BadOutput
            );
        }
        assert!(
            parse_completed(&json!({"status":"completed","output":[valid]}), &[]).is_ok(),
            "one legacy message remains supported"
        );
        let agent_message = json!({"type":"agent_message","author":"root","recipient":"user","content":[{"type":"input_text","text":"{}"}]});
        assert_eq!(
            parse_completed(&json!({"status":"completed","output":[agent_message]}), &[])
                .unwrap_err(),
            SideCallError::BadOutput
        );
    }

    #[tokio::test]
    async fn reasoning_stream_budget_is_independent_of_final_summary_size() {
        let schema = json!({"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false});
        let answer =
            json!({"summary":"- 已完成中文与 emoji 🧩 回归；待验证失败、取消和恢复路径。"});
        let delta =
            json!({"type":"response.reasoning_summary_text.delta","delta":"x".repeat(1024)});
        let mut body = format!("data: {delta}\n\n").repeat(280);
        let terminal =
            json!({"type":"response.completed","response":completed(&answer.to_string())});
        body.push_str(&format!("data: {terminal}\n\n"));
        assert!(body.len() > MAX_OUTPUT);
        let (base, server) = fixture(body.into_bytes(), "text/event-stream", "200 OK").await;
        let result = complete_http(&call(&schema), &base, HeaderMap::new()).await;
        server.await.unwrap();
        assert_eq!(result.unwrap().structured, answer);
    }

    #[tokio::test]
    async fn a_combined_chunk_is_not_mistaken_for_one_oversized_frame() {
        let mut bytes = format!(": {}\n\n", "x".repeat(1024))
            .repeat(2200)
            .into_bytes();
        assert!(bytes.len() > MAX_SSE_FRAME_BYTES);
        bytes.extend_from_slice(format!("data: {}\n\n", json!({
            "type":"response.completed", "response":completed(r#"{"summary":"有效的中文摘要，保留待处理任务。"}"#)
        })).as_bytes());
        let result = consume_sse_frames(&mut bytes, &mut SseState::default())
            .unwrap()
            .unwrap();
        assert_eq!(
            result.structured["summary"],
            "有效的中文摘要，保留待处理任务。"
        );
    }

    #[tokio::test]
    async fn stream_frame_and_final_text_limits_report_distinct_stages() {
        for complete_frame in [false, true] {
            let mut frame = vec![b' '; MAX_SSE_FRAME_BYTES + 4];
            if complete_frame {
                frame.extend_from_slice(b"\n\n");
            }
            let failure = super::super::diagnostics::capture(async {
                consume_sse_frames(&mut frame, &mut SseState::default())
            })
            .await
            .unwrap_err();
            assert_eq!(failure.stage, Some("sse_frame_limit"));
        }
        let large_answer = json!({"summary":"界".repeat(MAX_OUTPUT / 3 + 1)}).to_string();
        let failure = super::super::diagnostics::capture(async {
            parse_completed(&completed(&large_answer), &[])
        })
        .await
        .unwrap_err();
        assert_eq!(failure.stage, Some("final_text_limit"));

        // Valid individually bounded frames still have a finite total budget.
        let body = format!(": {}\n\n", "x".repeat(4096))
            .repeat(2050)
            .into_bytes();
        assert!(body.len() > MAX_STREAM_BYTES);
        let (base, server) = fixture_chunked(body, "text/event-stream", "200 OK", 64 * 1024).await;
        let schema = json!({"type":"object"});
        let failure = super::super::diagnostics::capture(complete_http(
            &call(&schema),
            &base,
            HeaderMap::new(),
        ))
        .await
        .unwrap_err();
        server.await.unwrap();
        assert_eq!(failure.stage, Some("http_stream_limit"));
        assert_eq!(failure.http_status, Some(200));
    }

    #[tokio::test]
    async fn json_requires_completion_and_sse_refusals_cannot_be_overwritten() {
        let valid = completed(r#"{"summary":"完整的中文摘要，不省略待验证事项。"}"#);
        assert!(parse_nonstreamed(&valid).is_ok());
        for status in [
            None,
            Some(Value::Null),
            Some(json!(1)),
            Some(json!("in_progress")),
        ] {
            let mut response = valid.clone();
            response.as_object_mut().unwrap().remove("status");
            if let Some(status) = status {
                response["status"] = status;
            }
            let failure =
                super::super::diagnostics::capture(async { parse_nonstreamed(&response) })
                    .await
                    .unwrap_err();
            assert_eq!(failure.stage, Some("final_response_status"));
        }
        let terminal = json!({"type":"response.completed","response":valid});
        for kind in [
            "response.output_text.refusal",
            "response.refusal.delta",
            "response.refusal.done",
        ] {
            let event = json!({"type":kind,"delta":"private refusal text"});
            let mut body = format!("data: {event}\n\ndata: {terminal}\n\n").into_bytes();
            let failure = super::super::diagnostics::capture(async {
                consume_sse_frames(&mut body, &mut SseState::default())
            })
            .await
            .unwrap_err();
            assert_eq!(failure.kind, SideCallError::BadOutput);
            assert_eq!(failure.stage, Some("sse_refusal"));
        }
    }

    #[test]
    fn frame_boundary_uses_the_first_complete_delimiter() {
        assert_eq!(frame_boundary(b"a\n\nb\r\n\r\n"), Some((1, 2)));
        assert_eq!(frame_boundary(b"a\r\n\r\nb\n\n"), Some((1, 4)));
        assert_eq!(frame_boundary(b"a\r\n\r"), None);
        assert_eq!(frame_boundary(b"a\n"), None);
    }

    #[tokio::test]
    async fn failed_incomplete_and_malformed_responses_keep_content_free_diagnostics() {
        for (event, kind, stage) in [
            (
                json!({"type":"error","message":"private upstream text"}),
                SideCallError::Failed,
                "sse_error",
            ),
            (
                json!({"type":"response.failed","response":{"error":{"message":"private upstream text"}}}),
                SideCallError::Failed,
                "sse_response_failed",
            ),
            (
                json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}),
                SideCallError::BadOutput,
                "sse_response_incomplete",
            ),
            (
                json!({"type":"response.completed","response":completed("private upstream text")}),
                SideCallError::BadOutput,
                "final_json",
            ),
        ] {
            let failure = super::super::diagnostics::capture(async {
                SseState::default().frame(&format!("data: {event}"))
            })
            .await
            .unwrap_err();
            assert_eq!(failure.kind, kind);
            assert_eq!(failure.stage, Some(stage));
            assert!(!format!("{failure:?}").contains("private upstream text"));
        }
        assert_eq!(
            parse_completed(
                &json!({"status":"failed","error":{"message":"private upstream text"}}),
                &[]
            )
            .unwrap_err(),
            SideCallError::Failed
        );
    }

    #[tokio::test]
    async fn rejects_server_errors_tools_refusals_incomplete_and_oversized_output() {
        let schema = json!({"type":"object"});
        let fixtures = [
            (
                json!({"type":"response.failed","response":{"error":{"message":"private server body"}}}),
                "text/event-stream",
                SideCallError::Failed,
            ),
            (
                json!({"type":"response.output_item.done","item":{"type":"function_call","name":"shell","arguments":"{}"}}),
                "text/event-stream",
                SideCallError::BadOutput,
            ),
            (
                json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}),
                "text/event-stream",
                SideCallError::BadOutput,
            ),
            (
                json!({"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"no"}]}]}),
                "application/json",
                SideCallError::BadOutput,
            ),
        ];
        for (value, content_type, expected) in fixtures {
            let body = if content_type == "text/event-stream" {
                format!("data: {value}\n\n").into_bytes()
            } else {
                serde_json::to_vec(&value).unwrap()
            };
            let (base, server) = fixture(body, content_type, "200 OK").await;
            assert_eq!(
                complete_http(&call(&schema), &base, HeaderMap::new())
                    .await
                    .unwrap_err(),
                expected
            );
            server.await.unwrap();
        }
        let (base, server) =
            fixture(vec![b' '; MAX_OUTPUT + 1], "application/json", "200 OK").await;
        assert_eq!(
            complete_http(&call(&schema), &base, HeaderMap::new())
                .await
                .unwrap_err(),
            SideCallError::BadOutput
        );
        server.await.unwrap();
        let (base, server) = fixture(
            b"private error".to_vec(),
            "application/json",
            "401 Unauthorized",
        )
        .await;
        assert_eq!(
            complete_http(&call(&schema), &base, HeaderMap::new())
                .await
                .unwrap_err(),
            SideCallError::Failed
        );
        server.await.unwrap();
    }

    #[test]
    fn unsupported_auth_never_guesses_an_account_or_falls_back() {
        let auth = json!({"tokens":{"access_token":"fixture-token","account_id":"selected-workspace","id_token":"header.e30.signature"}});
        assert!(ensure_file_oauth(&toml::Table::new(), &auth).is_ok());
        let keyring: toml::Table = toml::from_str("cli_auth_credentials_store='keyring'").unwrap();
        assert_eq!(
            ensure_file_oauth(&keyring, &auth),
            Err(SideCallError::Unavailable)
        );
        for mode in ["headers", "agentIdentity", "personalAccessToken", "apiKey"] {
            let mut auth = auth.clone();
            auth["auth_mode"] = json!(mode);
            assert_eq!(
                ensure_file_oauth(&toml::Table::new(), &auth),
                Err(SideCallError::Unavailable)
            );
        }
        assert_eq!(
            oauth_metadata(&auth, "different-token"),
            Err(SideCallError::Unavailable)
        );
        assert_eq!(
            oauth_metadata(&auth, "fixture-token").unwrap(),
            ("selected-workspace", false)
        );
        let mut missing = auth.clone();
        missing["tokens"]["account_id"] = Value::Null;
        assert_eq!(
            ensure_file_oauth(&toml::Table::new(), &missing),
            Err(SideCallError::Unavailable)
        );
        let command_auth: toml::Table = toml::from_str(
            "model_provider='relay'\n[model_providers.relay]\nauth={command='custom'}",
        )
        .unwrap();
        assert!(matches!(
            resolve_route(&command_auth, |_| None),
            Err(SideCallError::Unavailable)
        ));
    }

    #[test]
    fn channel_snapshot_overrides_native_provider_and_keeps_secrets_out_of_arguments() {
        let mut command = tokio::process::Command::new("unused-fixture-cli");
        command.arg("app-server");
        let provider = json!({"baseUrl":"https://channel.example/v1","apiKey":"fixture-channel-key","env":{"HEADER_ENV":"fixture-env-header"},"settingsConfig":{"config":""}});
        let env = crate::provider_files::channel_env("codex", &provider).unwrap();
        for (key, value) in &env {
            command.env(key, value);
        }
        let request = SendRequest {
            host_instructions: None,
            session_id: None,
            workspace: "fixture".into(),
            prompt: String::new(),
            images: vec![],
            model: Some("gpt-6.1-sol".into()),
            effort: Some("high".into()),
            claude_ultracode: None,
            service_tier: None,
            permission: None,
            additional_dirs: vec![],
            provider_id: None,
            computer_use: None,
            allowed_tools: None,
        };
        crate::engine::codex::apply_channel(&mut command, &provider, &env, &request).unwrap();
        let mut config: toml::Table = toml::from_str("model_provider='native'\n[model_providers.native]\nbase_url='https://native.example/v1'\nenv_key='NATIVE_KEY'").unwrap();
        let explicit = routing_snapshot(&command, &mut config).unwrap();
        let route = resolve_route(&config, |key| explicit.get(key).cloned()).unwrap();
        // config/read normalizes Option fields to null and fills provider
        // defaults. These do not undo an explicit channel's selected provider.
        let mut effective = serde_json::to_value(&config).unwrap();
        effective["model_providers"]["ccgui"]["http_headers"] = Value::Null;
        effective["model_providers"]["ccgui"]["env_http_headers"] = Value::Null;
        effective["model_providers"]["ccgui"]["auth"] = Value::Null;
        effective["model_providers"]["ccgui"]["gateway_oauth"] = Value::Null;
        effective["profile"] = Value::Null;
        assert!(
            validate_effective_routing(&config, &json!({"config":effective}), |key| explicit
                .get(key)
                .cloned())
            .is_ok()
        );
        assert_eq!(route.base.as_deref(), Some("https://channel.example/v1"));
        assert_eq!(route.key.as_deref(), Some("fixture-channel-key"));
        assert!(!route.requires_auth);
        assert!(!command
            .as_std()
            .get_args()
            .any(|arg| arg.to_string_lossy().contains("fixture-channel-key")));
        let missing: toml::Table = toml::from_str("model_provider='missing'").unwrap();
        assert!(matches!(
            resolve_route(&missing, |_| None),
            Err(SideCallError::Unavailable)
        ));
    }

    #[test]
    fn workspace_routing_uses_stock_origin_and_never_sends_to_an_unknown_backend() {
        let mut headers = HeaderMap::new();
        let routing = json!({"chatgptAccountId":"selected-workspace","backendOrigin":"https://regional.example","accountRoutingOverride":"us_cr"});
        assert_eq!(
            oauth_route(None, &routing, "selected-workspace", &mut headers).unwrap(),
            "https://regional.example/backend-api/codex"
        );
        assert_eq!(headers["x-openai-account-routing-override"], "us_cr");
        let mut unconstrained = routing.clone();
        unconstrained["accountRoutingOverride"] = json!("NO_CONSTRAINT");
        assert!(oauth_route(None, &unconstrained, "selected-workspace", &mut headers).is_ok());
        assert!(!headers.contains_key("x-openai-account-routing-override"));
        for change in [
            json!({"backendOrigin":"http://regional.example"}),
            json!({"backendOrigin":"https://regional.example/path"}),
            json!({"accountRoutingOverride":"unknown"}),
            json!({"chatgptAccountId":"different-workspace"}),
        ] {
            let mut invalid = routing.clone();
            for (key, value) in change.as_object().unwrap() {
                invalid[key] = value.clone();
            }
            assert_eq!(
                oauth_route(None, &invalid, "selected-workspace", &mut headers),
                Err(SideCallError::Unavailable)
            );
        }
        assert_eq!(
            oauth_route(
                Some("https://independent-relay.example/v1"),
                &routing,
                "selected-workspace",
                &mut headers
            ),
            Err(SideCallError::Unavailable)
        );
        assert_eq!(
            oauth_route(None, &Value::Null, "selected-workspace", &mut headers),
            Err(SideCallError::Unavailable)
        );
    }

    #[tokio::test]
    async fn managed_effective_endpoint_mismatch_prevents_http() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let candidate: toml::Table = toml::from_str(&format!("model_provider='relay'\n[model_providers.relay]\nname='Fixture'\nbase_url='{base}'\nenv_key='FIXTURE_KEY'\nwire_api='responses'")).unwrap();
        let mut effective = serde_json::to_value(&candidate).unwrap();
        effective["model_providers"]["relay"]["base_url"] = json!("https://managed.example/v1");
        let reply = json!({"config":effective,"layers":null,"origins":{}});
        let env = HashMap::from([("FIXTURE_KEY".into(), "test-only-key".into())]);
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            stock_snapshot(
                fixture_stock(&reply),
                &std::env::temp_dir(),
                &candidate,
                &env,
                false,
            ),
        )
        .await
        .unwrap();
        if result.is_ok() {
            // Same gate as production: HTTP is reachable only after stock
            // snapshot verification. A removed verifier sends this request.
            let route = resolve_route(&candidate, |key| env.get(key).cloned()).unwrap();
            let mut headers = route.headers;
            set_bearer(&mut headers, route.key.as_deref().unwrap()).unwrap();
            let schema = json!({"type":"object"});
            let _ = tokio::time::timeout(
                Duration::from_millis(100),
                complete_http(&call(&schema), &base, headers),
            )
            .await;
        }
        assert!(matches!(result, Err(SideCallError::Unavailable)));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "routing mismatch must not deliver a request or key"
        );
    }

    #[tokio::test]
    async fn verified_effective_api_key_snapshot_preserves_endpoint_and_credentials() {
        let (base, server) = fixture(
            serde_json::to_vec(&completed(r#"{"title":"Verified route"}"#)).unwrap(),
            "application/json",
            "200 OK",
        )
        .await;
        let candidate: toml::Table = toml::from_str(&format!("model_provider='relay'\n[model_providers.relay]\nname='Fixture'\nbase_url='{base}'\nenv_key='FIXTURE_KEY'\nwire_api='responses'\n[model_providers.relay.http_headers]\nx-route='literal'\n[model_providers.relay.env_http_headers]\nx-route='FIXTURE_HEADER'")).unwrap();
        let env = HashMap::from([
            ("FIXTURE_KEY".into(), "test-only-key".into()),
            ("FIXTURE_HEADER".into(), "environment-wins".into()),
        ]);
        let reply =
            json!({"config":serde_json::to_value(&candidate).unwrap(),"layers":null,"origins":{}});
        assert!(tokio::time::timeout(
            Duration::from_secs(3),
            stock_snapshot(
                fixture_stock(&reply),
                &std::env::temp_dir(),
                &candidate,
                &env,
                false
            )
        )
        .await
        .unwrap()
        .unwrap()
        .is_none());
        let route = resolve_route(&candidate, |key| env.get(key).cloned()).unwrap();
        let mut headers = route.headers;
        set_bearer(&mut headers, route.key.as_deref().unwrap()).unwrap();
        let schema = json!({"type":"object"});
        let output = complete_http(&call(&schema), route.base.as_deref().unwrap(), headers)
            .await
            .unwrap();
        assert_eq!(output.structured["title"], "Verified route");
        let (headers, _) = server.await.unwrap();
        assert!(headers
            .to_lowercase()
            .contains("authorization: bearer test-only-key"));
        assert!(headers.to_lowercase().contains("x-route: environment-wins"));
    }

    #[test]
    fn redacted_or_changed_effective_auth_fields_are_unavailable() {
        let candidate: toml::Table = toml::from_str("model_provider='relay'\n[model_providers.relay]\nname='Fixture'\nbase_url='https://fixture.example/v1'\nenv_key='FIXTURE_KEY'\nwire_api='responses'\n[model_providers.relay.http_headers]\nx-secret='test-only-header'").unwrap();
        let original = serde_json::to_value(&candidate).unwrap();
        for (pointer, value) in [
            ("/model_provider", json!("different-provider")),
            ("/model_providers/relay/env_key", json!("OTHER_KEY")),
            (
                "/model_providers/relay/http_headers/x-secret",
                json!("[REDACTED]"),
            ),
            (
                "/model_providers/relay/auth",
                json!({"command":"unsupported"}),
            ),
            ("/cli_auth_credentials_store", json!("keyring")),
            (
                "/chatgpt_base_url",
                json!("https://managed.example/backend-api/"),
            ),
            ("/preferred_auth_method", json!("unknown")),
        ] {
            let mut effective = original.clone();
            if pointer.matches('/').count() == 1 {
                effective[pointer.trim_start_matches('/')] = value;
            } else if pointer == "/model_providers/relay/auth" {
                effective["model_providers"]["relay"]["auth"] = value;
            } else {
                *effective.pointer_mut(pointer).unwrap() = value;
            }
            assert_eq!(
                validate_effective_routing(
                    &candidate,
                    &json!({"config":effective}),
                    |key| match key {
                        "FIXTURE_KEY" => Some("test-only-key".into()),
                        _ => None,
                    }
                ),
                Err(SideCallError::Unavailable)
            );
        }
        assert_eq!(
            validate_effective_routing(&candidate, &json!({"config":null}), |_| None),
            Err(SideCallError::Unavailable)
        );
    }

    #[test]
    fn prepared_route_cache_reuses_identical_inputs_and_invalidates_on_change_expiry_or_401() {
        let cache = Mutex::new(None);
        let config: toml::Table = toml::from_str(
            "model_provider='relay'\n[model_providers.relay]\nname='Fixture'\nbase_url='https://fixture.example/v1'\nenv_key='FIXTURE_KEY'\nwire_api='responses'",
        )
        .unwrap();
        let explicit_env = HashMap::from([("CODEX_HOME".to_owned(), "/tmp/codex-a".to_owned())]);
        let pre_key = preparation_pre_key(
            Path::new("/tmp/codex-a"),
            "codex",
            "",
            &config,
            &explicit_env,
            true,
            |key| match key {
                "FIXTURE_KEY" => Some("secret-1".to_owned()),
                _ => None,
            },
        )
        .unwrap();
        let auth_a = Some(sha256_bytes(br#"{"tokens":{"access_token":"a"}}"#));
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer test"));
        let t0 = Instant::now();

        store_prepared_route_in(
            &cache,
            pre_key,
            auth_a,
            t0,
            "https://fixture.example/v1",
            &headers,
        );
        assert!(
            lookup_prepared_route_in(&cache, &pre_key, auth_a, t0 + Duration::from_secs(30))
                .is_some()
        );

        let auth_b = Some(sha256_bytes(br#"{"tokens":{"access_token":"b"}}"#));
        assert!(
            lookup_prepared_route_in(&cache, &pre_key, auth_b, t0 + Duration::from_secs(30))
                .is_none()
        );

        let changed_env_key = preparation_pre_key(
            Path::new("/tmp/codex-a"),
            "codex",
            "",
            &config,
            &explicit_env,
            true,
            |key| match key {
                "FIXTURE_KEY" => Some("secret-2".to_owned()),
                _ => None,
            },
        )
        .unwrap();
        assert_ne!(changed_env_key, pre_key);
        assert!(
            lookup_prepared_route_in(
                &cache,
                &changed_env_key,
                auth_a,
                t0 + Duration::from_secs(30)
            )
            .is_none()
        );

        assert!(
            lookup_prepared_route_in(&cache, &pre_key, auth_a, t0 + PREPARED_ROUTE_TTL).is_none()
        );

        store_prepared_route_in(
            &cache,
            pre_key,
            auth_a,
            t0,
            "https://fixture.example/v1",
            &headers,
        );
        invalidate_prepared_route_in(&cache);
        assert!(
            lookup_prepared_route_in(&cache, &pre_key, auth_a, t0 + Duration::from_secs(1))
                .is_none()
        );
    }
}
