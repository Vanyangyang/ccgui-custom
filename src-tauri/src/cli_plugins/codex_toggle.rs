//! User-level Codex plugin toggles through the native app-server config API.
//! The caller owns binary/home selection, installed-plugin identity checks, and
//! workspace authorization. No thread/session or MCP/plugin operation is sent.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Command;

const TIMEOUT: Duration = Duration::from_secs(20);
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const PROTOCOL: &str = "Codex plugin toggle: unsupported or invalid config protocol";
const UNCERTAIN: &str =
    "Codex plugin toggle: write could not be verified; refresh configuration before retrying";
const OVERRIDDEN: &str = "Codex plugin toggle: user setting was saved but is overridden; effective plugin state did not change";

/// `workspace` must already have passed the host's workspace authorization.
/// A failure after the write may still have saved the user preference. Never
/// roll back automatically: doing so could overwrite a concurrent user edit.
pub(super) async fn set_enabled(
    bin: &str,
    codex_home: &Path,
    workspace: Option<&Path>,
    plugin_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let (mut command, target, cwd) = prepare(bin, codex_home, workspace, plugin_id)?;
    run(&mut command, &target, &cwd, plugin_id, enabled, TIMEOUT).await
}

pub(super) async fn set_hook_enabled(
    bin: &str, codex_home: &Path, workspace: Option<&Path>, id: &str, hash: &str, enabled: bool,
) -> Result<(), String> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || hash.len() != 71 || !hash.starts_with("sha256:")
        || !hash[7..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("Codex hook toggle: invalid selection".into());
    }
    let (mut command, target, cwd) = prepare_hook(bin, codex_home, workspace)?;
    run_hook(&mut command, &target, &cwd, id, hash, enabled).await
}

fn prepare_hook(bin: &str, codex_home: &Path, workspace: Option<&Path>) -> Result<(Command, PathBuf, PathBuf), String> {
    let (_, target, cwd) = prepare(bin, codex_home, workspace, "hook-control")?;
    // Hook discovery needs the actual plugin and hook feature settings.
    // Rebuild the harmless process flags without disabling either feature.
    let mut command = crate::engine::command_for_binary(bin);
    command.env("PATH", crate::engine::resolve::cli_search_path()).arg("app-server");
    for flag in ["mcp_servers={}", "features.apps=false", "features.remote_plugin=false",
        "features.memories=false", "features.goals=false", "cloud.skills.enabled=false", "notify=[]"] {
        command.args(["-c", flag]);
    }
    command.env("CODEX_HOME", target.parent().ok_or(PROTOCOL)?).current_dir(&cwd);
    Ok((command, target, cwd))
}

async fn run_hook(command: &mut Command, target: &Path, cwd: &Path, id: &str, hash: &str, enabled: bool) -> Result<(), String> {
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    crate::engine::hide_console(command);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| "Codex hook toggle: cannot start app-server")?;
    #[cfg(windows)]
    let tree = {
        let job = crate::engine::job::assign_kill_on_close(&child);
        if job.is_none() {
            if let Some(pid) = child.id() { crate::engine::kill_process_group(pid); }
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            return Err("Codex hook toggle: cannot secure app-server process cleanup".into());
        }
        ProcessTree { job }
    };
    #[cfg(unix)]
    let tree = ProcessTree { pid: child.id().ok_or(PROTOCOL)? };
    let result = tokio::time::timeout(TIMEOUT, async {
        let mut rpc = Rpc { input: child.stdin.take().ok_or(PROTOCOL)?,
            output: BufReader::new(child.stdout.take().ok_or(PROTOCOL)?), remaining: OUTPUT_LIMIT, next_id: 0 };
        transact_hook(&mut rpc, target, cwd, id, hash, enabled).await
    }).await.unwrap_or_else(|_| Err("Codex hook toggle: timed out; refresh before retrying".into()));
    drop(tree);
    let _ = child.start_kill();
    if !matches!(tokio::time::timeout(Duration::from_secs(2), child.wait()).await, Ok(Ok(_))) && result.is_ok() {
        return Err("Codex hook toggle: app-server cleanup failed".into());
    }
    result
}

fn hook_from_list<'a>(list: &'a Value, id: &str, hash: &str) -> Result<&'a Value, String> {
    let data = list.get("data").and_then(Value::as_array).ok_or(PROTOCOL)?;
    if data.len() != 1 { return Err(PROTOCOL.into()); }
    let hooks = data[0].get("hooks").and_then(Value::as_array).ok_or(PROTOCOL)?;
    let mut matching = hooks.iter().filter(|hook| hook.get("key").and_then(Value::as_str)
        .is_some_and(|key| format!("{:x}", Sha256::digest(key.as_bytes())) == id));
    let hook = matching.next().ok_or("Codex hook changed; refresh and retry")?;
    if matching.next().is_some() || hook.get("isManaged").and_then(Value::as_bool) != Some(false)
        || hook.get("currentHash").and_then(Value::as_str) != Some(hash)
        || hook.get("enabled").and_then(Value::as_bool).is_none() {
        return Err("Codex hook changed or is managed; refresh and retry".into());
    }
    Ok(hook)
}

async fn transact_hook<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    rpc: &mut Rpc<R, W>, target: &Path, cwd: &Path, id: &str, hash: &str, enabled: bool,
) -> Result<(), String> {
    let init = rpc.request("initialize", json!({"clientInfo":{"name":"ccgui_hook_toggle", "version":env!("CARGO_PKG_VERSION")},
        "capabilities":{"experimentalApi":true}})).await?;
    nonempty(&init, "userAgent")?;
    rpc.send(json!({"method":"initialized","params":{}})).await?;
    let list_params = json!({"cwds":[cwd.to_str().ok_or(PROTOCOL)?]});
    let list = rpc.request("hooks/list", list_params.clone()).await?;
    let hook = hook_from_list(&list, id, hash)?;
    let key = nonempty(hook, "key")?;
    let key_path = format!("hooks.state.{}.enabled", quoted_config_key(key)?);
    let params = json!({"includeLayers":true,"cwd":cwd.to_str().ok_or(PROTOCOL)?});
    let before = rpc.request("config/read", params.clone()).await?;
    let user = user_layer(&before, target)?;
    let mut expected = user["config"].clone();
    let hooks = expected.as_object_mut().ok_or(PROTOCOL)?.entry("hooks").or_insert_with(|| json!({})).as_object_mut().ok_or(PROTOCOL)?;
    let states = hooks.entry("state").or_insert_with(|| json!({})).as_object_mut().ok_or(PROTOCOL)?;
    let state = states.entry(key).or_insert_with(|| json!({})).as_object_mut().ok_or(PROTOCOL)?;
    state.insert("enabled".into(), json!(enabled));
    let write = rpc.request("config/batchWrite", json!({"edits":[{"keyPath":key_path,"value":enabled,"mergeStrategy":"replace"}],
        "filePath":user["name"]["file"],"expectedVersion":nonempty(user,"version")?,"reloadUserConfig":true})).await?;
    if write.get("status").and_then(Value::as_str) != Some("ok")
        || write.get("overriddenMetadata").is_some_and(|v| !v.is_null()) { return Err(UNCERTAIN.into()); }
    let version = nonempty(&write, "version")?;
    if config_identity(Path::new(nonempty(&write, "filePath")?))? != config_identity(target)? { return Err(UNCERTAIN.into()); }
    let after = rpc.request("config/read", params).await?;
    let user_after = user_layer(&after, target)?;
    if nonempty(user_after, "version")? != version || user_after["config"] != expected { return Err(UNCERTAIN.into()); }
    let verified = rpc.request("hooks/list", list_params).await?;
    if hook_from_list(&verified, id, hash)?.get("enabled").and_then(Value::as_bool) != Some(enabled) {
        return Err("Codex hook toggle: effective state did not change; refresh before retrying".into());
    }
    Ok(())
}

fn quoted_config_key(key: &str) -> Result<String, String> {
    // Codex's config API accepts double-quoted path segments, but its key-path
    // parser does not handle TOML literal (single-quoted) strings. In particular,
    // TOML's automatic formatting chooses single quotes for Windows paths and
    // would cause a dotted hook key to be split into unintended segments.
    serde_json::to_string(key).map_err(|_| PROTOCOL.into())
}

fn key_path(plugin_id: &str) -> Result<String, String> {
    if plugin_id.is_empty() || plugin_id.len() > 1024 || plugin_id.chars().any(char::is_control) {
        return Err("Codex plugin toggle: invalid plugin identity".into());
    }
    Ok(format!("plugins.{}.enabled", quoted_config_key(plugin_id)?))
}

fn prepare(
    bin: &str,
    home: &Path,
    workspace: Option<&Path>,
    plugin_id: &str,
) -> Result<(Command, PathBuf, PathBuf), String> {
    key_path(plugin_id)?;
    if !home.is_absolute() || !home.is_dir() {
        return Err("Codex plugin toggle: invalid Codex home".into());
    }
    let home =
        dunce::canonicalize(home).map_err(|_| "Codex plugin toggle: cannot resolve Codex home")?;
    let target = home.join("config.toml");
    // Do not follow a config symlink into an unrelated write destination.
    if config_identity(&target)?.parent() != Some(home.as_path()) {
        return Err("Codex plugin toggle: user config resolves outside Codex home".into());
    }
    let cwd = workspace.unwrap_or(&home);
    if !cwd.is_absolute() || !cwd.is_dir() || cwd.to_str().is_none() || home.to_str().is_none() {
        return Err("Codex plugin toggle: invalid workspace or Codex home".into());
    }
    let mut command = crate::engine::command_for_binary(bin);
    command.env("PATH", crate::engine::resolve::cli_search_path());
    command.arg("app-server");
    // Transient process flags only; never persist them. The plugin enabled leaf
    // remains visible to config/read. No thread/start or tool call is permitted.
    for flag in [
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
        command.args(["-c", flag]);
    }
    command.env("CODEX_HOME", &home).current_dir(cwd);
    Ok((command, target, cwd.to_path_buf()))
}

fn config_identity(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(PROTOCOL.into());
    }
    match dunce::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent =
                dunce::canonicalize(path.parent().ok_or(PROTOCOL)?).map_err(|_| PROTOCOL)?;
            Ok(parent.join(path.file_name().ok_or(PROTOCOL)?))
        }
        Err(_) => Err(PROTOCOL.into()),
    }
}

// Owns the process tree even when the enclosing future is cancelled.
struct ProcessTree {
    #[cfg(windows)]
    job: Option<std::sync::Arc<crate::engine::job::KillOnCloseJob>>,
    #[cfg(unix)]
    pid: u32,
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(windows)]
        drop(self.job.take());
        #[cfg(unix)]
        crate::engine::kill_process_group(self.pid);
    }
}

async fn run(
    command: &mut Command,
    target: &Path,
    cwd: &Path,
    plugin_id: &str,
    enabled: bool,
    deadline: Duration,
) -> Result<(), String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    crate::engine::hide_console(command);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| "Codex plugin toggle: cannot start app-server")?;
    #[cfg(windows)]
    let tree = {
        let job = crate::engine::job::assign_kill_on_close(&child);
        if job.is_none() {
            // No RPC has been sent; refuse to write without cancellation cleanup.
            if let Some(pid) = child.id() {
                crate::engine::kill_process_group(pid);
            }
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            return Err("Codex plugin toggle: cannot secure app-server process cleanup".into());
        }
        ProcessTree { job }
    };
    #[cfg(unix)]
    let tree = ProcessTree {
        pid: child.id().ok_or(PROTOCOL)?,
    };
    let result = tokio::time::timeout(deadline, async {
        let mut rpc = Rpc {
            input: child.stdin.take().ok_or(PROTOCOL)?,
            output: BufReader::new(child.stdout.take().ok_or(PROTOCOL)?),
            remaining: OUTPUT_LIMIT,
            next_id: 0,
        };
        transact(&mut rpc, target, cwd, plugin_id, enabled).await
    })
    .await
    .unwrap_or_else(|_| {
        Err(
            "Codex plugin toggle: app-server timed out; refresh configuration before retrying"
                .into(),
        )
    });
    // All pipes are dropped, then the whole tree is terminated and reaped. A
    // valid RPC result plus readback is the commit acknowledgement, not exit 0.
    drop(tree);
    let _ = child.start_kill();
    if !matches!(
        tokio::time::timeout(Duration::from_secs(2), child.wait()).await,
        Ok(Ok(_))
    ) && result.is_ok()
    {
        return Err("Codex plugin toggle: app-server cleanup failed".into());
    }
    result
}

struct Rpc<R, W> {
    output: R,
    input: W,
    remaining: usize,
    next_id: u64,
}

impl<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin> Rpc<R, W> {
    async fn send(&mut self, value: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| PROTOCOL)?;
        bytes.push(b'\n');
        self.input.write_all(&bytes).await.map_err(|_| UNCERTAIN)?;
        self.input.flush().await.map_err(|_| UNCERTAIN.into())
    }

    async fn line(&mut self) -> Result<Value, String> {
        let mut line = Vec::new();
        loop {
            let bytes = self.output.fill_buf().await.map_err(|_| UNCERTAIN)?;
            if bytes.is_empty() {
                return Err(UNCERTAIN.into());
            }
            let newline = bytes.iter().position(|b| *b == b'\n');
            let count = newline.map_or(bytes.len(), |index| index + 1);
            if count > self.remaining {
                return Err("Codex plugin toggle: app-server output limit exceeded".into());
            }
            self.remaining -= count;
            line.extend_from_slice(&bytes[..count]);
            self.output.consume(count);
            if newline.is_some() {
                break;
            }
        }
        serde_json::from_slice(&line).map_err(|_| PROTOCOL.into())
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"id": id, "method": method, "params": params}))
            .await?;
        loop {
            let reply = self.line().await?;
            if !reply.is_object() {
                return Err(PROTOCOL.into());
            }
            if reply.get("id").is_none() && reply.get("method").and_then(Value::as_str).is_some() {
                continue; // Notifications are bounded by the shared output/time budgets.
            }
            if reply.get("method").is_some() || reply.get("id").and_then(Value::as_u64) != Some(id)
            {
                return Err(PROTOCOL.into()); // Never service server-initiated requests.
            }
            if let Some(error) = reply.get("error") {
                return Err(rpc_error(error));
            }
            return reply
                .get("result")
                .filter(|v| v.is_object())
                .cloned()
                .ok_or_else(|| PROTOCOL.into());
        }
    }
}

fn rpc_error(error: &Value) -> String {
    // Do not copy error.message/data/config values, even into logs.
    match error.pointer("/data/config_write_error_code").and_then(Value::as_str) {
        Some("configVersionConflict") => "Codex plugin toggle: configuration changed concurrently; refresh and retry",
        Some("configLayerReadonly") => "Codex plugin toggle: native API refused the user config write",
        _ if error.get("code").and_then(Value::as_i64) == Some(-32601) => "Codex plugin toggle: native config API is unavailable in this CLI",
        _ => "Codex plugin toggle: native config request failed; refresh configuration before retrying",
    }.into()
}

fn user_layer<'a>(read: &'a Value, target: &Path) -> Result<&'a Value, String> {
    let layers = read
        .get("layers")
        .and_then(Value::as_array)
        .ok_or(PROTOCOL)?;
    let mut users = layers.iter().filter(|layer| {
        layer.pointer("/name/type").and_then(Value::as_str) == Some("user")
            && layer.pointer("/name/profile").is_none_or(Value::is_null)
    });
    let user = users.next().ok_or(PROTOCOL)?;
    if users.next().is_some() || user.get("disabledReason").is_some_and(|v| !v.is_null()) {
        return Err(PROTOCOL.into());
    }
    let file = user
        .pointer("/name/file")
        .and_then(Value::as_str)
        .ok_or(PROTOCOL)?;
    if config_identity(Path::new(file))? != config_identity(target)? {
        return Err(
            "Codex plugin toggle: native user config does not match selected Codex home".into(),
        );
    }
    nonempty(user, "version")?;
    if !user.get("config").is_some_and(Value::is_object) {
        return Err(PROTOCOL.into());
    }
    Ok(user)
}

fn nonempty<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| PROTOCOL.into())
}

fn expected_config(before: &Value, plugin_id: &str, enabled: bool) -> Result<Value, String> {
    let mut expected = before.clone();
    let root = expected.as_object_mut().ok_or(PROTOCOL)?;
    let plugins = root
        .entry("plugins")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or(PROTOCOL)?;
    let plugin = plugins
        .entry(plugin_id)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or(PROTOCOL)?;
    plugin.insert("enabled".into(), json!(enabled));
    Ok(expected)
}

async fn transact<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    rpc: &mut Rpc<R, W>,
    target: &Path,
    cwd: &Path,
    plugin_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let key = key_path(plugin_id)?;
    let init = rpc
        .request(
            "initialize",
            json!({"clientInfo": {
                "name": "ccgui_plugin_toggle", "version": env!("CARGO_PKG_VERSION")
            }}),
        )
        .await?;
    nonempty(&init, "userAgent")?;
    rpc.send(json!({"method": "initialized", "params": {}}))
        .await?;
    let params = json!({"includeLayers": true, "cwd": cwd.to_str().ok_or(PROTOCOL)?});
    let before = rpc.request("config/read", params.clone()).await?;
    let user = user_layer(&before, target)?;
    let expected = expected_config(&user["config"], plugin_id, enabled)?;
    let write = rpc
        .request(
            "config/value/write",
            json!({
                "keyPath": key, "value": enabled, "mergeStrategy": "replace",
                // Use the native spelling, after identity validation. On Windows a short
                // path for a nonexistent config file can otherwise fail readonly checks.
                "filePath": user["name"]["file"], "expectedVersion": nonempty(user, "version")?
            }),
        )
        .await?;
    match write.get("status").and_then(Value::as_str) {
        Some("okOverridden") => return Err(OVERRIDDEN.into()),
        Some("ok") => (),
        _ => return Err(UNCERTAIN.into()),
    }
    if write
        .get("overriddenMetadata")
        .is_some_and(|v| !v.is_null())
    {
        return Err(OVERRIDDEN.into());
    }
    let version = nonempty(&write, "version")?;
    let written = Path::new(nonempty(&write, "filePath")?);
    if config_identity(written)? != config_identity(target)? {
        return Err(UNCERTAIN.into());
    }
    let after = rpc.request("config/read", params).await?;
    let user_after = user_layer(&after, target)?;
    if nonempty(user_after, "version")? != version || user_after["config"] != expected {
        return Err(UNCERTAIN.into());
    }
    // Codex 0.162.1 can report `ok` even when project plugin settings win.
    let effective = after
        .get("config")
        .and_then(|c| c.get("plugins"))
        .and_then(|p| p.get(plugin_id))
        .and_then(|p| p.get("enabled"))
        .and_then(Value::as_bool)
        .ok_or(UNCERTAIN)?;
    if effective != enabled {
        return Err(OVERRIDDEN.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("ccgui-codex-toggle-{}", uuid::Uuid::new_v4()));
            for dir in ["codex", "home", "work"] {
                std::fs::create_dir_all(root.join(dir)).unwrap();
            }
            Self(root)
        }
        fn target(&self) -> PathBuf {
            self.0.join("codex/config.toml")
        }
        fn read(&self, config: Value, version: &str, effective: bool) -> Value {
            json!({"config":{"plugins":{"demo.v1@market.test":{"enabled":effective}}},
                "layers":[{"name":{"type":"user","file":self.target(),"profile":null},
                "config":config,"version":version}]})
        }
        fn native(&self, bin: &str) -> (Command, PathBuf, PathBuf) {
            let (mut command, target, cwd) = prepare(
                bin,
                &self.0.join("codex"),
                Some(&self.0.join("work")),
                "demo.v1@market.test",
            )
            .unwrap();
            // Child-only environment; never mutate the test process/global HOME.
            command
                .env("HOME", self.0.join("home"))
                .env("USERPROFILE", self.0.join("home"));
            (command, target, cwd)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // UUID-owned directory, checked against the original temp parent.
            if self.0.parent() == Some(std::env::temp_dir().as_path())
                && self
                    .0
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("ccgui-codex-toggle-")
            {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    async fn scripted(f: &Fixture, replies: Vec<Value>) -> (Result<(), String>, Vec<Value>) {
        let (client, server) = tokio::io::duplex(65536);
        let (read, write) = tokio::io::split(client);
        let task = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server);
            let mut lines = BufReader::new(read).lines();
            let mut requests = Vec::new();
            let mut replies = replies.into_iter();
            while let Some(line) = lines.next_line().await.unwrap() {
                let request: Value = serde_json::from_str(&line).unwrap();
                if request.get("id").is_some() {
                    let body = replies.next().expect("unexpected request after failure");
                    let response = if body.get("error").is_some() {
                        json!({"id":request["id"],"error":body["error"]})
                    } else {
                        json!({"id":request["id"],"result":body})
                    };
                    write
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .unwrap();
                }
                requests.push(request);
            }
            requests
        });
        let mut rpc = Rpc {
            output: BufReader::new(read),
            input: write,
            remaining: OUTPUT_LIMIT,
            next_id: 0,
        };
        let result = transact(
            &mut rpc,
            &f.target(),
            &f.0.join("work"),
            "demo.v1@market.test",
            true,
        )
        .await;
        drop(rpc);
        (result, task.await.unwrap())
    }

    async fn scripted_hook(f: &Fixture, replies: Vec<Value>, id: &str, hash: &str, enabled: bool) -> (Result<(), String>, Vec<Value>) {
        let (client, server) = tokio::io::duplex(65536);
        let (read, write) = tokio::io::split(client);
        let task = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server);
            let mut lines = BufReader::new(read).lines();
            let mut requests = Vec::new();
            let mut replies = replies.into_iter();
            while let Some(line) = lines.next_line().await.unwrap() {
                let request: Value = serde_json::from_str(&line).unwrap();
                if request.get("id").is_some() {
                    let body = replies.next().expect("unexpected request after failure");
                    write.write_all(format!("{}\n", json!({"id":request["id"],"result":body})).as_bytes()).await.unwrap();
                }
                requests.push(request);
            }
            requests
        });
        let mut rpc = Rpc { output: BufReader::new(read), input: write, remaining: OUTPUT_LIMIT, next_id: 0 };
        let result = transact_hook(&mut rpc, &f.target(), &f.0.join("work"), id, hash, enabled).await;
        drop(rpc);
        (result, task.await.unwrap())
    }

    async fn native_fixture_hook_list(f: &Fixture, bin: &str) -> Value {
        let (mut command, _, cwd) = prepare_hook(bin, &f.0.join("codex"), Some(&f.0.join("work"))).unwrap();
        command.env("HOME", f.0.join("home")).env("USERPROFILE", f.0.join("home"));
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        #[cfg(windows)]
        crate::engine::hide_console(&mut command);
        let mut child = command.spawn().unwrap();
        #[cfg(windows)]
        let _job = crate::engine::job::assign_kill_on_close(&child).expect("fixture process job");
        let mut rpc = Rpc { input: child.stdin.take().unwrap(), output: BufReader::new(child.stdout.take().unwrap()),
            remaining: OUTPUT_LIMIT, next_id: 0 };
        rpc.request("initialize", json!({"clientInfo":{"name":"ccgui_hook_test","version":"1"},
            "capabilities":{"experimentalApi":true}})).await.unwrap();
        rpc.send(json!({"method":"initialized","params":{}})).await.unwrap();
        let list = rpc.request("hooks/list", json!({"cwds":[cwd]})).await.unwrap();
        drop(rpc);
        let _ = child.start_kill();
        let _ = child.wait().await;
        list
    }

    #[tokio::test]
    async fn hook_toggle_changes_only_enabled_and_verifies_the_native_result() {
        let f = Fixture::new();
        let key = r"C:\Users\fixture\sample\hooks.json:pre_tool_use:0:0";
        let id = format!("{:x}", Sha256::digest(key.as_bytes()));
        let hash = format!("sha256:{}", "a".repeat(64));
        let list = |enabled| json!({"data":[{"hooks":[{"key":key,"currentHash":hash,"isManaged":false,"enabled":enabled}]}]});
        let before = json!({"model":"keep","hooks":{"state":{(key):{"trusted_hash":"keep-trust"}}}});
        let after = json!({"model":"keep","hooks":{"state":{(key):{"trusted_hash":"keep-trust","enabled":false}}}});
        let replies = vec![init(), list(true), f.read(before, "v1", false), write_ok(&f), f.read(after, "v2", false), list(false)];
        let (result, requests) = scripted_hook(&f, replies, &id, &hash, false).await;
        assert!(result.is_ok(), "{result:?}");
        let write = requests.iter().find(|item| item["method"] == "config/batchWrite").unwrap();
        assert_eq!(write["params"]["edits"][0]["value"], false);
        assert_eq!(write["params"]["edits"][0]["keyPath"],
            format!("hooks.state.{}.enabled", serde_json::to_string(key).unwrap()));
        assert_eq!(write["params"]["expectedVersion"], "v1");
    }

    #[tokio::test]
    async fn hook_toggle_rejects_changed_or_managed_hooks_before_writing() {
        let f = Fixture::new();
        let key = "user:stop:0:0";
        let id = format!("{:x}", Sha256::digest(key.as_bytes()));
        let hash = format!("sha256:{}", "a".repeat(64));
        for item in [json!({"key":key,"currentHash":format!("sha256:{}", "b".repeat(64)),"isManaged":false,"enabled":true}),
            json!({"key":key,"currentHash":hash,"isManaged":true,"enabled":true})] {
            let (result, requests) = scripted_hook(&f, vec![init(), json!({"data":[{"hooks":[item]}]})], &id, &hash, false).await;
            assert!(result.is_err());
            assert!(!requests.iter().any(|item| item["method"] == "config/batchWrite"));
        }
    }

    #[tokio::test]
    #[ignore = "explicit isolated test of the installed Codex app-server; no account or model turn"]
    async fn native_hook_toggle_preserves_trust_and_other_configuration() {
        let bin = std::env::var("CCGUI_TEST_CODEX_BIN").expect("explicit Codex binary path");
        for trusted in [false, true] {
            let f = Fixture::new();
            std::fs::write(f.target(), "model = 'gpt-5'\n[features]\nhooks = true\n").unwrap();
            std::fs::write(f.0.join("codex/hooks.json"), r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"fixture-never-run"}]}]}}"#).unwrap();
            let list = native_fixture_hook_list(&f, &bin).await;
            let hook = &list["data"][0]["hooks"][0];
            let key = nonempty(hook, "key").unwrap().to_owned();
            let hash = nonempty(hook, "currentHash").unwrap().to_owned();
            let id = format!("{:x}", Sha256::digest(key.as_bytes()));
            if trusted {
                let mut config = std::fs::read_to_string(f.target()).unwrap().parse::<toml_edit::DocumentMut>().unwrap();
                config["hooks"]["state"][key.as_str()]["trusted_hash"] = toml_edit::value(hash.clone());
                std::fs::write(f.target(), config.to_string()).unwrap();
            }
            let expected_trust = if trusted { "trusted" } else { "untrusted" };
            for enabled in [false, true] {
                let (mut command, target, cwd) = prepare_hook(&bin, &f.0.join("codex"), Some(&f.0.join("work"))).unwrap();
                command.env("HOME", f.0.join("home")).env("USERPROFILE", f.0.join("home"));
                run_hook(&mut command, &target, &cwd, &id, &hash, enabled).await.unwrap();
                let list = native_fixture_hook_list(&f, &bin).await;
                let hook = hook_from_list(&list, &id, &hash).unwrap();
                assert_eq!(hook["enabled"], enabled);
                assert_eq!(hook["trustStatus"], expected_trust);
                let config = std::fs::read_to_string(f.target()).unwrap().parse::<toml_edit::DocumentMut>().unwrap();
                assert_eq!(config["model"].as_str(), Some("gpt-5"));
                assert_eq!(config["hooks"]["state"][key.as_str()].get("trusted_hash").and_then(|v| v.as_str()),
                    trusted.then_some(hash.as_str()));
            }
        }
    }

    #[tokio::test]
    #[ignore = "explicit isolated test of the installed Codex app-server; no account or model turn"]
    async fn native_hook_inventory_does_not_execute_trusted_session_hooks() {
        let bin = std::env::var("CCGUI_TEST_CODEX_BIN").expect("explicit Codex binary path");
        let f = Fixture::new();
        std::fs::write(f.target(), "[features]\nhooks = true\n").unwrap();
        std::fs::write(f.0.join("work/marker.js"), "require('fs').writeFileSync('hook-ran','yes')").unwrap();
        std::fs::write(f.0.join("codex/hooks.json"), r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node marker.js"}]}]}}"#).unwrap();
        let first = native_fixture_hook_list(&f, &bin).await;
        let hook = &first["data"][0]["hooks"][0];
        let key = nonempty(hook, "key").unwrap();
        let hash = nonempty(hook, "currentHash").unwrap();
        let mut config = std::fs::read_to_string(f.target()).unwrap().parse::<toml_edit::DocumentMut>().unwrap();
        config["hooks"]["state"][key]["trusted_hash"] = toml_edit::value(hash);
        std::fs::write(f.target(), config.to_string()).unwrap();
        let trusted = native_fixture_hook_list(&f, &bin).await;
        assert_eq!(trusted["data"][0]["hooks"][0]["trustStatus"], "trusted");
        assert!(!f.0.join("work/hook-ran").exists());
    }

    fn init() -> Value {
        json!({"userAgent":"ccgui-test/0.162.1"})
    }
    fn config() -> Value {
        json!({"model":"keep","plugins":{"demo.v1@market.test":{"enabled":false,"other":"keep"},
            "other@market":{"enabled":false}},"mcp_servers":{"secret":{"env":{"TOKEN":"never-echo"}}}})
    }
    fn write_ok(f: &Fixture) -> Value {
        json!({"status":"ok","version":"v2","filePath":f.target(),"overriddenMetadata":null})
    }

    #[test]
    fn key_quotes_single_plugin_identity_and_rejects_controls() {
        for id in ["demo.v1@market.test", "a\".b@c", "a\\b@c", "插件@商店"] {
            let key = key_path(id).unwrap();
            assert!(key.starts_with("plugins.\"") && key.ends_with("\".enabled"));
            let doc = format!("{key} = true")
                .parse::<toml_edit::DocumentMut>()
                .unwrap();
            assert_eq!(doc["plugins"].as_table().unwrap().len(), 1);
            assert_eq!(doc["plugins"][id]["enabled"].as_bool(), Some(true));
        }
        for id in ["", "bad\nname", "bad\0name"] {
            assert!(key_path(id).is_err());
        }
    }

    #[tokio::test]
    async fn cas_exact_leaf_preserves_other_fields_and_verifies_readback() {
        let f = Fixture::new();
        let before = config();
        let expected = expected_config(&before, "demo.v1@market.test", true).unwrap();
        let (result, requests) = scripted(
            &f,
            vec![
                init(),
                f.read(before, "v1", false),
                write_ok(&f),
                f.read(expected, "v2", true),
            ],
        )
        .await;
        result.unwrap();
        assert_eq!(
            requests
                .iter()
                .filter_map(|r| r["method"].as_str())
                .collect::<Vec<_>>(),
            [
                "initialize",
                "initialized",
                "config/read",
                "config/value/write",
                "config/read"
            ]
        );
        assert_eq!(
            requests[3]["params"],
            json!({"keyPath":"plugins.\"demo.v1@market.test\".enabled",
            "mergeStrategy":"replace","value":true,"expectedVersion":"v1","filePath":f.target()})
        );
        assert_eq!(requests[2]["params"]["cwd"], json!(f.0.join("work")));
    }

    #[tokio::test]
    async fn conflicts_and_errors_are_not_success_and_never_leak_response_text() {
        let f = Fixture::new();
        for code in [
            "configVersionConflict",
            "configLayerReadonly",
            "unknown-secret",
        ] {
            let (result, requests) = scripted(&f, vec![init(), f.read(config(), "v1", false),
                json!({"error":{"code":-32600,"message":"credential-never-echo","data":{"config_write_error_code":code}}})]).await;
            let error = result.unwrap_err();
            assert!(!error.contains("credential-never-echo"));
            assert!(!error.contains("unknown-secret"));
            assert_eq!(requests.len(), 4); // No retry with a stale or missing CAS.
            if code == "configVersionConflict" {
                assert!(error.contains("concurrently"));
            }
        }
    }

    #[tokio::test]
    async fn overridden_and_unverified_writes_fail_closed() {
        let f = Fixture::new();
        let expected = expected_config(&config(), "demo.v1@market.test", true).unwrap();
        for write in [
            json!({"status":"okOverridden","overriddenMetadata":{"message":"secret"}}),
            json!({"status":"ok","overriddenMetadata":{"effectiveValue":false}}),
            json!({"status":"future"}),
        ] {
            let (result, _) =
                scripted(&f, vec![init(), f.read(config(), "v1", false), write]).await;
            assert!(result.is_err());
        }
        for after in [
            f.read(expected.clone(), "v2", false),
            f.read(expected, "v3", true),
            f.read(
                json!({"plugins":{"demo.v1@market.test":{"enabled":true}}}),
                "v2",
                true,
            ),
        ] {
            let (result, _) = scripted(
                &f,
                vec![init(), f.read(config(), "v1", false), write_ok(&f), after],
            )
            .await;
            assert!(result.is_err());
        }
    }

    #[tokio::test]
    async fn rejects_missing_version_wrong_user_layer_and_invalid_plugin_table_before_write() {
        let f = Fixture::new();
        let mut missing_version = f.read(config(), "v1", false);
        missing_version["layers"][0]["version"] = Value::Null;
        let mut wrong_home = f.read(config(), "v1", false);
        wrong_home["layers"][0]["name"]["file"] = json!(f.0.join("home/config.toml"));
        let mut disabled = f.read(config(), "v1", false);
        disabled["layers"][0]["disabledReason"] = json!("not active");
        for read in [
            missing_version,
            wrong_home,
            disabled,
            f.read(json!({"plugins":false}), "v1", false),
        ] {
            let (result, requests) = scripted(&f, vec![init(), read]).await;
            assert!(result.is_err());
            assert_eq!(requests.len(), 3);
        }
    }

    #[tokio::test]
    async fn bounded_protocol_rejects_eof_malformed_wrong_id_and_server_requests() {
        for bytes in [
            b"".as_slice(),
            b"secret\n",
            b"{\"id\":2,\"result\":{}}\n",
            b"{\"id\":1,\"method\":\"tool/call\",\"params\":{}}\n",
            b"{\"id\":1}\n",
        ] {
            let mut rpc = Rpc {
                output: BufReader::new(bytes),
                input: tokio::io::sink(),
                remaining: 1000,
                next_id: 0,
            };
            let error = rpc.request("config/read", json!({})).await.unwrap_err();
            assert!(!error.contains("secret"));
        }
        let data = vec![b'x'; 100];
        let mut rpc = Rpc {
            output: BufReader::new(data.as_slice()),
            input: tokio::io::sink(),
            remaining: 20,
            next_id: 0,
        };
        assert!(rpc
            .request("config/read", json!({}))
            .await
            .unwrap_err()
            .contains("output limit"));
        let data = b"{\"method\":\"notice\"}\n".repeat(10);
        let mut rpc = Rpc {
            output: BufReader::new(data.as_slice()),
            input: tokio::io::sink(),
            remaining: 25,
            next_id: 0,
        };
        assert!(rpc
            .request("config/read", json!({}))
            .await
            .unwrap_err()
            .contains("output limit"));
        let (read, _pending_writer) = tokio::io::duplex(64);
        let mut rpc = Rpc {
            output: BufReader::new(read),
            input: tokio::io::sink(),
            remaining: 100,
            next_id: 0,
        };
        assert!(tokio::time::timeout(
            Duration::from_millis(10),
            rpc.request("config/read", json!({}))
        )
        .await
        .is_err());
    }

    #[test]
    fn prepare_rejects_relative_paths_and_distinguishes_config_destinations() {
        assert!(prepare("unused", Path::new("relative"), None, "x@y").is_err());
        let f = Fixture::new();
        assert!(prepare(
            "unused",
            &f.0.join("codex"),
            Some(Path::new("relative")),
            "x@y"
        )
        .is_err());
        // The filesystem identity fence is also used for native response paths.
        assert_ne!(
            config_identity(&f.target()).unwrap(),
            config_identity(&f.0.join("home/config.toml")).unwrap()
        );
    }

    // Opt-in only: every write goes to a UUID temp CODEX_HOME and HOME. No real
    // user config, login, plugin installation, or network endpoint is required.
    #[tokio::test]
    #[ignore = "requires CCGUI_CODEX_TOGGLE_TEST_BIN pointing to local Codex CLI"]
    async fn native_isolated_round_trip_missing_file_and_project_override() {
        let bin =
            std::env::var("CCGUI_CODEX_TOGGLE_TEST_BIN").expect("explicit local CLI required");
        let f = Fixture::new();
        let original = "model = \"fixture\"\n[plugins.\"demo.v1@market.test\"]\nenabled = false\nother = \"keep\"\n[plugins.\"other@market\"]\nenabled = false\n";
        std::fs::write(f.target(), original).unwrap();
        for enabled in [true, false] {
            let (mut command, target, cwd) = f.native(&bin);
            run(
                &mut command,
                &target,
                &cwd,
                "demo.v1@market.test",
                enabled,
                TIMEOUT,
            )
            .await
            .unwrap();
            let text = std::fs::read_to_string(f.target()).unwrap();
            let doc = text.parse::<toml_edit::DocumentMut>().unwrap();
            assert_eq!(
                doc["plugins"]["demo.v1@market.test"]["enabled"].as_bool(),
                Some(enabled)
            );
            assert_eq!(
                doc["plugins"]["demo.v1@market.test"]["other"].as_str(),
                Some("keep")
            );
            assert_eq!(
                doc["plugins"]["other@market"]["enabled"].as_bool(),
                Some(false)
            );
            assert_eq!(doc["model"].as_str(), Some("fixture"));
        }
        let empty = Fixture::new();
        let (mut command, target, cwd) = empty.native(&bin);
        run(
            &mut command,
            &target,
            &cwd,
            "demo.v1@market.test",
            true,
            TIMEOUT,
        )
        .await
        .unwrap();
        assert!(empty.target().is_file());

        std::fs::create_dir_all(f.0.join("work/.codex")).unwrap();
        std::fs::create_dir_all(f.0.join("work/.git")).unwrap();
        let project = "[plugins.\"demo.v1@market.test\"]\nenabled = false\n";
        std::fs::write(f.0.join("work/.codex/config.toml"), project).unwrap();
        let work = dunce::canonicalize(f.0.join("work")).unwrap();
        std::fs::write(
            f.target(),
            format!(
                "{original}\n[projects.{}]\ntrust_level = \"trusted\"\n",
                toml_edit::Value::from(work.to_str().unwrap())
            ),
        )
        .unwrap();
        let (mut command, target, cwd) = f.native(&bin);
        let error = run(
            &mut command,
            &target,
            &cwd,
            "demo.v1@market.test",
            true,
            TIMEOUT,
        )
        .await
        .unwrap_err();
        assert!(error.contains("overridden"));
        assert_eq!(
            std::fs::read_to_string(f.0.join("work/.codex/config.toml")).unwrap(),
            project
        );
    }

    #[tokio::test]
    async fn cancelled_transport_releases_owned_pipes() {
        let (client, mut server) = tokio::io::duplex(1024);
        let (read, write) = tokio::io::split(client);
        let task = tokio::spawn(async move {
            let mut rpc = Rpc {
                output: BufReader::new(read),
                input: write,
                remaining: 1024,
                next_id: 0,
            };
            rpc.request("config/read", json!({})).await
        });
        let mut byte = [0; 1];
        server.read_exact(&mut byte).await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(1), server.read_to_end(&mut rest))
            .await
            .unwrap()
            .unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn timeout_and_cancellation_reap_the_owned_windows_process() {
        async fn wait_for_pid(path: &Path) -> u32 {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Ok(text) = std::fs::read_to_string(path) {
                        if let Ok(pid) = text.parse() {
                            return pid;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("fixture child must start")
        }
        async fn assert_reaped(pid: u32) {
            use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
            let mut system = System::new();
            let pid = Pid::from_u32(pid);
            for _ in 0..100 {
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&[pid]),
                    true,
                    ProcessRefreshKind::nothing(),
                );
                if system.process(pid).is_none() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            panic!("owned fixture process survived cleanup");
        }
        for cancel in [false, true] {
            let f = Fixture::new();
            let marker = f.0.join("pid.txt");
            let mut command = crate::engine::command_for_binary("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command",
                "[System.IO.File]::WriteAllText($env:CCGUI_CODEX_TOGGLE_PID, [string]$PID); Start-Sleep -Seconds 60"])
                .env("CCGUI_CODEX_TOGGLE_PID", &marker)
                .env("CODEX_HOME", f.0.join("codex"))
                .env("HOME", f.0.join("home")).env("USERPROFILE", f.0.join("home"));
            let target = f.target();
            let cwd = f.0.join("work");
            let task = tokio::spawn(async move {
                run(
                    &mut command,
                    &target,
                    &cwd,
                    "demo@market",
                    true,
                    if cancel {
                        Duration::from_secs(30)
                    } else {
                        Duration::from_secs(3)
                    },
                )
                .await
            });
            let pid = wait_for_pid(&marker).await;
            if cancel {
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            } else {
                assert!(task.await.unwrap().unwrap_err().contains("timed out"));
            }
            assert_reaped(pid).await;
        }
    }
}
