//! Profile-local, explicitly enabled GUI fixture transport. Never built in production.
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, fs, io::Read, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tauri::{Listener, Manager};

const INPUT_LIMIT: u64 = 512 * 1024;
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const REQUEST_LIMIT: usize = 10_000;
const IN_FLIGHT_LIMIT: usize = 4096;

#[derive(Deserialize)]
struct Request { id: String, expression: String }
#[derive(Serialize)]
struct Reply { value: serde_json::Value, error: Option<String> }
struct Pending { started: Instant, reply: Option<Reply> }
#[derive(Default)]
struct Requests { seen: HashSet<String>, pending: HashMap<String, Pending> }
struct Bridge { requests: Mutex<Requests>, window_label: String }

fn failure(message: &str) -> Reply {
    Reply { value: serde_json::Value::Null, error: Some(message.chars().take(2048).collect()) }
}

#[derive(Deserialize)]
struct ResultEvent { id: String, value: Option<String>, error: Option<String> }

fn runtime_fixture_result(state: &Bridge, result: ResultEvent) -> Result<(), String> {
    let ResultEvent { id, value, error } = result;
    let mut requests = state.requests.lock().map_err(|_| "fixture state poisoned")?;
    let pending = requests.pending.get_mut(&id).ok_or("fixture result ID was not admitted")?;
    if pending.reply.is_some() { return Err("fixture result already completed".into()); }
    pending.reply = Some(if let Some(error) = error {
        failure(&error)
    } else if let Some(value) = value {
        if value.len() > OUTPUT_LIMIT {
            failure("fixture result exceeds 8 MiB")
        } else {
            match serde_json::from_str(&value) {
                Ok(value) => Reply { value, error: None },
                Err(_) => failure("fixture result is not valid JSON"),
            }
        }
    } else { failure("fixture result omitted its value") });
    Ok(())
}

fn safe_directory(path: &Path, profile: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("inspect fixture directory: {e}"))?;
    if !meta.is_dir() || meta.file_type().is_symlink() || !dunce::canonicalize(path).map_err(|e| e.to_string())?.starts_with(profile) {
        return Err("fixture directory is linked or escapes development profile".into());
    }
    Ok(())
}

fn create_directory(path: &Path, profile: &Path) -> Result<(), String> {
    match fs::create_dir(path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(format!("create fixture directory: {e}")),
    }
    safe_directory(path, profile)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() { let _ = fs::remove_file(tmp); }
    result.map_err(|e| format!("write fixture receipt: {e}"))
}

fn reply_bytes(reply: &Reply) -> Vec<u8> {
    let bytes = serde_json::to_vec(reply).expect("JSON value serializes");
    if bytes.len() > OUTPUT_LIMIT {
        serde_json::to_vec(&failure("fixture result envelope exceeds 8 MiB")).unwrap()
    } else { bytes }
}

fn read_request(path: &Path, id: &str) -> Result<Request, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("inspect fixture request: {e}"))?;
    if !meta.is_file() || meta.file_type().is_symlink() { return Err("fixture request must be an ordinary file".into()); }
    if meta.len() > INPUT_LIMIT { return Err("fixture request exceeds 512 KiB".into()); }
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|e| format!("open fixture request: {e}"))?.take(INPUT_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| format!("read fixture request: {e}"))?;
    if bytes.len() as u64 > INPUT_LIMIT { return Err("fixture request exceeds 512 KiB".into()); }
    let request: Request = serde_json::from_slice(&bytes).map_err(|_| "fixture request is not valid JSON")?;
    if request.id != id { return Err("fixture request ID does not match filename".into()); }
    Ok(request)
}

fn script(id: &str, expression: &str) -> String {
    // Source is injected by the native WebView API; no eval/Function or CSP changes.
    format!(r#"(() => {{
const send = (value, error) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{event:'runtime-fixture-result',payload:{{id:{id},value,error}}}});
Promise.resolve().then(async () => await (
{expression}
)).then(value => send(JSON.stringify(value ?? null), null)).catch(error => send(null, String(error).slice(0,2048)));
}})();"#, id = serde_json::to_string(id).unwrap())
}

pub fn install_runtime_fixture_bridge(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    if !super::runtime_fixture_enabled() || std::env::var("CCGUI_RUNTIME_FIXTURE_COMMANDS").as_deref() != Ok("1") { return Ok(()); }
    let profile = dunce::canonicalize(crate::paths::app_home()).map_err(|e| format!("resolve fixture profile: {e}"))?;
    let base = profile.join("runtime-fixture-bridge");
    create_directory(&base, &profile)?;
    let root = base.join(std::process::id().to_string());
    // A fresh PID directory prevents stale requests from a previous process being replayed.
    fs::create_dir(&root).map_err(|e| format!("create fresh fixture bridge: {e}"))?;
    let inbox = root.join("inbox");
    let outbox = root.join("outbox");
    create_directory(&inbox, &profile)?;
    create_directory(&outbox, &profile)?;
    let state = Arc::new(Bridge { requests: Mutex::new(Requests::default()), window_label: window.label().to_owned() });
    // Reuse the application's existing core event permission; do not add an
    // unrestricted plugin command or change the production capability manifest.
    let result_state = state.clone();
    let listener = window.listen("runtime-fixture-result", move |event| {
        if event.payload().len() <= OUTPUT_LIMIT + 4096 {
            if let Ok(result) = serde_json::from_str(event.payload()) {
                let _ = runtime_fixture_result(&result_state, result);
            }
        }
    });
    let app = app.clone();
    let ready = root.join("ready.json");
    std::thread::Builder::new().name("runtime-fixture-bridge".into()).spawn(move || {
        poll(app, state, profile, root, inbox, outbox, listener);
    }).map_err(|e| format!("start fixture bridge: {e}"))?;
    atomic_write(&ready, &serde_json::to_vec(&serde_json::json!({"pid":std::process::id(),"bridgeVersion":1})).unwrap())
}

fn poll(app: tauri::AppHandle, state: Arc<Bridge>, profile: PathBuf, root: PathBuf, inbox: PathBuf, outbox: PathBuf, listener: tauri::EventId) {
    loop {
        let Some(window) = app.get_webview_window(&state.window_label) else { break; };
        // Recheck directories before each batch; never follow a replaced profile child.
        if [root.parent().unwrap(), &root, &inbox, &outbox].iter().any(|p| safe_directory(p, &profile).is_err()) { break; }
        {
            let mut requests = state.requests.lock().unwrap_or_else(|e| e.into_inner());
            requests.pending.retain(|id, pending| {
                if pending.reply.is_none() && pending.started.elapsed() > Duration::from_secs(120) {
                    pending.reply = Some(failure("fixture expression timed out after 120 seconds"));
                }
                match &pending.reply {
                    Some(reply) => atomic_write(&outbox.join(format!("{id}.json")), &reply_bytes(reply)).is_err(),
                    None => true,
                }
            });
        }
        if let Ok(entries) = fs::read_dir(&inbox) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
                let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else { continue; };
                if uuid::Uuid::parse_str(&id).is_err() { continue; }
                let mut requests = state.requests.lock().unwrap_or_else(|e| e.into_inner());
                if requests.pending.len() >= IN_FLIGHT_LIMIT { break; }
                if requests.seen.contains(&id) || outbox.join(format!("{id}.json")).exists() { continue; }
                let claimed = inbox.join(format!("{id}.claimed"));
                if fs::rename(&path, &claimed).is_err() { continue; }
                let request = read_request(&claimed, &id);
                let _ = fs::remove_file(&claimed);
                let request = if requests.seen.len() >= REQUEST_LIMIT { Err("fixture request limit of 10000 reached".into()) } else { requests.seen.insert(id.clone()); request };
                let reply = request.as_ref().err().map(|e| failure(e));
                requests.pending.insert(id.clone(), Pending { started: Instant::now(), reply });
                drop(requests);
                if let Ok(request) = request {
                    if let Err(e) = window.eval(&script(&id, &request.expression)) {
                        if let Some(pending) = state.requests.lock().unwrap_or_else(|e| e.into_inner()).pending.get_mut(&id) {
                            pending.reply = Some(failure(&format!("fixture WebView execution failed: {e}")));
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    app.unlisten(listener);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_envelope_is_bounded() {
        let reply = Reply { value: serde_json::Value::String("x".repeat(OUTPUT_LIMIT)), error: None };
        let bytes = reply_bytes(&reply);
        assert!(bytes.len() < OUTPUT_LIMIT);
        assert!(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["error"].as_str().unwrap().contains("8 MiB"));
    }
    #[test]
    fn script_uses_native_source_and_bounded_result_event() {
        let source = script("test-id", "Promise.resolve(42)");
        assert!(source.contains("await (\nPromise.resolve(42)\n)"));
        assert!(source.contains("runtime-fixture-result"));
        assert!(!source.contains("eval("));
    }
}
