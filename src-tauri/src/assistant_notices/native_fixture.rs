//! Debug-only real-window fixture with synthetic sources and an owned scratch profile.
//! Registered only by its dedicated binary, never by ordinary CCGUI startup.
use super::*;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{Read, Write};
use tauri::{WebviewUrl, WebviewWindowBuilder};

const ORIGIN: &str = "http://127.0.0.1:5175";
const LIFETIME_SECONDS: u64 = 15 * 60;

pub(crate) struct FixturePaths {
    pub(crate) overlay_data: PathBuf,
    main_data: PathBuf,
    root: PathBuf,
    sources: [NoticeSource; 2],
    log: Mutex<File>,
}
impl FixturePaths {
    fn log(&self, event: &str, detail: Value) {
        let line = json!({"atMs": now(), "event": event, "detail": detail});
        let mut file = self.log.lock();
        let _ = writeln!(file, "{line}");
        let _ = file.flush();
    }
}

fn fixture_main(window: &tauri::Window, paths: &FixturePaths) -> Result<(), String> {
    if window.label() != MAIN || crate::paths::app_home() != paths.root.join(".ccgui-next") {
        return Err("fixture_window_required".into());
    }
    Ok(())
}

#[tauri::command]
fn get_app_settings() -> Value {
    // Real overlay bootstrap may ask for presentation preferences; no AppState or disk read.
    json!({"theme":"light","language":"zh","systemProxyEnabled":false})
}

#[tauri::command]
fn get_cli_config() -> Value {
    json!({"codex":{"current":"fixture","providers":{"fixture":{"name":"Synthetic provider"}}}})
}

#[tauri::command]
fn auto_title_models() -> Value {
    // The service's observer probe is permanently false: this catalog only
    // exercises the settings UI and never makes a real inference route ready.
    json!([{"engine":"codex","id":"fixture-model","name":"Synthetic model",
        "provider":"Synthetic provider","resolvedModel":null,"supportsEffort":true,
        "effortLevels":["low","medium","high"]}])
}

#[tauri::command]
fn assistant_notices_fixture_state(
    window: tauri::Window,
    paths: tauri::State<'_, FixturePaths>,
    service: tauri::State<'_, Arc<Service>>,
) -> Result<Value, String> {
    fixture_main(&window, &paths)?;
    let notices = service
        .store
        .as_ref()
        .ok_or("storage_unavailable")?
        .history(512)?;
    let windows: Vec<_> = [MAIN, overlay::LABEL].into_iter().map(|label| {
        let info = service.app.get_webview_window(label).map(|window| json!({
            "position":window.outer_position().ok(),"size":window.outer_size().ok(),
            "visible":window.is_visible().ok(),"focused":window.is_focused().ok(),"scale":window.scale_factor().ok()
        }));
        json!({"label":label,"info":info})
    }).collect();
    let monitors: Vec<_> = service.app.available_monitors().unwrap_or_default().iter().map(|monitor| json!({
        "name":monitor.name(),"scale":monitor.scale_factor(),"position":monitor.position(),"size":monitor.size()
    })).collect();
    Ok(
        json!({"sources":paths.sources,"notices":notices,"status":service.status(),"root":paths.root,"observerDisabled":true,"mainForeground":overlay::main_focused(&service.app),"windows":windows,"monitors":monitors}),
    )
}

#[tauri::command]
async fn assistant_notices_fixture_seed(
    window: tauri::Window,
    paths: tauri::State<'_, FixturePaths>,
    service: tauri::State<'_, Arc<Service>>,
    source: String,
    kind: String,
) -> Result<Value, String> {
    fixture_main(&window, &paths)?;
    let source = match source.as_str() {
        "a" => &paths.sources[0],
        "b" => &paths.sources[1],
        _ => return Err("invalid_fixture_source".into()),
    };
    let at = now();
    let id = format!("fixture-{}", uuid::Uuid::new_v4());
    let store = service.store.as_ref().ok_or("storage_unavailable")?;
    let committed = match kind.as_str() {
        "completion" => store.record_completion(&Pending {
            id: id.clone(), engine: source.engine.clone(), session_id: source.session_id.clone(),
            workspace_path: source.workspace_path.clone(), prompt: "Synthetic GUI fixture only".into(),
            summary: format!("{}：合成任务已完成 ✅。点击回到会话将验证真实窗口聚焦与来源切换；没有真实模型或用户历史。",source.label),
            started_at_ms: at, completed_at_ms: at, generation: 1, cancel: false, started: false,
        }, source)?,
        "aside" => store.add_aside(&id, source, &id, &format!("合成旁白 💡 {}", &id[id.len()-8..]), "这条内容仅用于原生窗口验收。展开后带入原会话草稿，验证真实 focus-request / acknowledgement 和 insertSideAnswer。不会发送消息或调用模型。", at, 36_000)?,
        _ => return Err("invalid_fixture_kind".into()),
    };
    paths.log(
        "seed",
        json!({"id":id,"kind":kind,"source":source.session_id,"status":committed.status}),
    );
    service.refresh(true);
    Ok(json!({"id":id,"commit":committed}))
}

#[tauri::command]
async fn assistant_notices_fixture_control(
    window: tauri::Window,
    paths: tauri::State<'_, FixturePaths>,
    service: tauri::State<'_, Arc<Service>>,
    action: String,
) -> Result<(), String> {
    fixture_main(&window, &paths)?;
    match action.as_str() {
        "recreateOverlay" => {
            if let Some(overlay) = service.app.get_webview_window(overlay::LABEL) {
                overlay.destroy().map_err(|_| "window_unavailable")?;
            }
            service.refresh(true);
        }
        "close" => {
            paths.log("close_requested", json!({}));
            service.app.exit(0);
        }
        "clear" => {
            let store = service.store.as_ref().ok_or("storage_unavailable")?;
            let mut inner = service.inner.lock();
            for notice in store.history(512)? {
                store.mark_read(&notice.id)?;
            }
            inner.holds.clear();
            drop(inner);
            service.refresh(true);
        }
        _ => return Err("invalid_fixture_action".into()),
    }
    paths.log("control", json!({"action":action}));
    Ok(())
}

fn install_service(app: &tauri::AppHandle) -> Result<Arc<Service>, String> {
    let home = crate::paths::app_home();
    let service = Arc::new(Service {
        app: app.clone(),
        path: home.join("assistant-notices.json"),
        store: Some(Store::open(home.join("assistant-notices.sqlite"))?),
        outbox: Some(Outbox::open(home.join("fixture-completion-outbox.sqlite"))?),
        observer_probe: |_| false,
        audio: completion_audio::AudioService::new(now()),
        inner: Mutex::new(Inner {
            config: Config {
                enabled: true,
                observer_enabled: true,
                paused: false,
                focus_mode: false,
                voice_enabled: false,
                ..Config::default()
            },
            generation: 1,
            policy_epoch: 0,
            policy_context: None,
            fatal: None,
            configuration_error: None,
            storage_error: None,
            window_error: false,
            observer_available: false,
            observer_storage_error: false,
            observer_error: None,
            observer_route: None,
            source_engines: crate::config::ENGINES
                .iter()
                .map(|engine| engine.to_string())
                .collect(),
            stopped: false,
            policy: Policy::default(),
            locale: "zh-CN".into(),
            actually_focused: false,
            document_id: String::new(),
            attention: Attention::default(),
            sources: HashMap::new(),
            focus: HashMap::new(),
            jobs: HashMap::new(),
            holds: HashMap::new(),
            dragging: false,
            last_reap: 0,
            desktop_ids: Vec::new(),
        }),
        presentation: Mutex::new(()),
        emitted_status: Mutex::new(None),
        loop_handle: Mutex::new(None),
    });
    app.manage(service.clone());
    let runner = service.clone();
    *service.loop_handle.lock() = Some(tauri::async_runtime::spawn(async move {
        loop {
            runner.tick();
            if runner.inner.lock().stopped {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }));
    Ok(service)
}

fn allowed_url(url: &tauri::Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(5175)
        && url.username().is_empty()
        && url.password().is_none()
}

fn check_fixture_server() -> Result<(), String> {
    // Fixed numeric loopback only: no proxies, DNS, redirects or external fallback.
    let address = "127.0.0.1:5175"
        .parse()
        .map_err(|_| "invalid_fixture_origin")?;
    let mut socket = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(5))
        .map_err(|_| "start the dedicated fixture Vite server on 127.0.0.1:5175 first")?;
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|_| "fixture_server_unavailable")?;
    socket
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| "fixture_server_unavailable")?;
    socket.write_all(b"GET /tests/browser/assistant-notices-native.html HTTP/1.1\r\nHost: 127.0.0.1:5175\r\nConnection: close\r\n\r\n").map_err(|_| "fixture_server_unavailable")?;
    let mut bytes = Vec::new();
    socket
        .take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| "fixture_server_unavailable")?;
    let response = String::from_utf8_lossy(&bytes);
    if bytes.len() > 65_536
        || !response.starts_with("HTTP/1.1 200 ")
        || !response.contains("assistant-notices-native.tsx")
    {
        return Err("fixed loopback server did not return the native fixture page".into());
    }
    Ok(())
}

/// The binary requires an explicit, existing task-owned artifact directory.
pub fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 || args[0] != "--artifacts" {
        return Err(
            "usage: assistant-notices-fixture --artifacts <absolute task-owned directory>".into(),
        );
    }
    let artifacts = PathBuf::from(&args[1]);
    if !artifacts.is_absolute() {
        return Err("fixture artifact directory must be absolute".into());
    }
    let artifacts = dunce::canonicalize(artifacts)
        .map_err(|_| "fixture artifact directory must already exist")?;
    if !artifacts.is_dir()
        || artifacts.file_name().and_then(|n| n.to_str()) != Some("native-notices-fixture")
    {
        return Err("fixture artifact directory must be named native-notices-fixture".into());
    }
    check_fixture_server()?;
    let harness = crate::test_harness::TestHarness::new()?;
    let root = harness.root().to_path_buf();
    if crate::paths::app_home() != root.join(".ccgui-next") || crate::paths::is_dev_profile() {
        return Err("fixture profile isolation failed".into());
    }
    let main_data = root.join("webview-main");
    let overlay_data = root.join("webview-overlay");
    for path in [
        &main_data,
        &overlay_data,
        &root.join("ws/a"),
        &root.join("ws/b"),
    ] {
        std::fs::create_dir(path).map_err(|_| "fixture directory creation failed")?;
    }
    let sources = ["a", "b"].map(|name| NoticeSource {
        engine: "codex".into(),
        session_id: format!("fixture-source-{name}"),
        workspace_path: root
            .join(format!("ws/{name}"))
            .to_string_lossy()
            .into_owned(),
        label: format!(
            "测试来源 {} · 中文长标题与 emoji 🧑‍💻🚀 · 原生提醒独立验收",
            name.to_uppercase()
        ),
    });
    let logfile = artifacts.join(format!("native-{}.jsonl", std::process::id()));
    let log = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&logfile)
        .map_err(|_| "fixture log creation failed")?;
    let paths = FixturePaths {
        root: root.clone(),
        main_data,
        overlay_data,
        sources,
        log: Mutex::new(log),
    };
    paths.log("isolation", json!({"pid":std::process::id(),"appHome":crate::paths::app_home(),"mainData":paths.main_data,"overlayData":paths.overlay_data,"origin":ORIGIN,"observerProbe":false,"ordinaryStartup":false,"lifetimeSeconds":LIFETIME_SECONDS}));

    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "local.ccgui.assistant-notices-fixture".into();
    context.config_mut().product_name = Some("CCGUI Native Notices Fixture".into());
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url =
        Some(ORIGIN.parse().map_err(|_| "invalid_fixture_origin")?);
    context.config_mut().build.frontend_dist = Some(tauri::utils::config::FrontendDist::Url(
        ORIGIN.parse().map_err(|_| "invalid_fixture_origin")?,
    ));
    context.config_mut().app.security.asset_protocol.enable = false;
    let watchdog = Arc::new(Mutex::new(None::<tauri::async_runtime::JoinHandle<()>>));
    let setup_watchdog = watchdog.clone();
    let app = tauri::Builder::default()
        .manage(paths)
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("fixture-navigation")
                .on_navigation(|_, url| allowed_url(url))
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_app_settings,
            get_cli_config,
            auto_title_models,
            assistant_notices_fixture_state,
            assistant_notices_fixture_seed,
            assistant_notices_fixture_control,
            assistant_notices_status,
            assistant_notices_configure,
            assistant_notices_displays,
            assistant_notices_attach,
            assistant_notices_sync,
            assistant_notices_list,
            assistant_notices_history,
            assistant_notices_read,
            assistant_notices_pin,
            assistant_notices_open,
            assistant_notices_focus_ack,
            assistant_notices_hold,
            assistant_notices_drag,
            assistant_notices_pointer,
            assistant_notices_size,
        ])
        .setup(move |app| {
            let paths = app.state::<FixturePaths>();
            install_service(app.handle()).map_err(std::io::Error::other)?;
            let window = WebviewWindowBuilder::new(
                app,
                MAIN,
                WebviewUrl::App("tests/browser/assistant-notices-native.html".into()),
            )
            .title("CCGUI 原生提醒测试 — 合成来源 / 无模型 / 15分钟自动退出")
            .data_directory(paths.main_data.clone())
            .inner_size(860.0, 760.0)
            .build()?;
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                    handle.exit(0);
                }
            });
            let handle = app.handle().clone();
            *setup_watchdog.lock() = Some(tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(LIFETIME_SECONDS)).await;
                if let Some(paths) = handle.try_state::<FixturePaths>() {
                    paths.log("watchdog_exit", json!({}));
                }
                handle.exit(0);
            }));
            paths.log(
                "ready",
                json!({"mainLabel":MAIN,"overlayLabel":overlay::LABEL}),
            );
            Ok(())
        })
        .build(context)
        .map_err(|error| format!("fixture startup failed: {error}"))?;
    let exit_code = app.run_return(|handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            if let Some(service) = handle.try_state::<Arc<Service>>() {
                service.stop();
            }
        }
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(service) = handle.unmanage::<Arc<Service>>() {
                service.stop();
                if let Some(paths) = handle.try_state::<FixturePaths>() {
                    let notices = service
                        .store
                        .as_ref()
                        .and_then(|store| store.history(512).ok());
                    paths.log("exit", json!({"notices":notices,"status":service.status()}));
                }
            }
        }
    });
    if let Some(task) = watchdog.lock().take() {
        task.abort();
    }
    drop(harness);
    let cleanup = json!({"exitCode":exit_code,"scratchRoot":root,"scratchRemoved":!root.exists(),"log":logfile});
    std::fs::write(
        artifacts.join(format!("result-{}.json", std::process::id())),
        serde_json::to_vec_pretty(&cleanup).unwrap(),
    )
    .map_err(|_| "fixture result write failed")?;
    println!("{cleanup}");
    if exit_code != 0 {
        return Err(format!("fixture exited with {exit_code}"));
    }
    Ok(())
}
