pub mod agent_catalog;
pub mod app_cache;
pub mod auto_title;
pub mod composer_prediction;
pub mod agents;
pub mod browser;
pub mod cc_switch;
pub mod cli_lifecycle;
pub mod claude_quota;
pub mod codex_quota;
pub mod codex_context_window;
pub mod agy_quota;
pub mod agy_vertex_credits;
pub mod cursor_quota;
pub mod throughput_stats;
pub mod computer_use;
pub mod computer_use_ax;
pub mod config;
pub mod creator_skill;
pub mod cu_overlay;
pub mod db;
mod development_profile;
pub mod dsh_host;
pub mod engine;
pub mod event_sink;
pub mod files;
pub mod fonts;
pub mod git;
pub mod git_worktree;
pub mod history;
pub mod interactive_answer_state;
mod assistant_notices;
#[cfg(feature = "test-harness")]
pub use assistant_notices::native_fixture::run as run_assistant_notices_fixture;
pub mod host_chat;
pub mod leader;
pub mod mcp;
pub mod metrics;
pub mod mission;
pub mod open_app;
pub mod paths;
#[cfg(feature = "test-harness")]
pub mod test_harness;
pub mod pet_overlay;
pub mod pets;
pub mod plugin_caps;
pub mod plugins;
pub mod prompts;
pub mod provider_files;
pub mod provider_models;
pub mod proxy;
pub mod quit_guard;
pub mod relay;
mod runtime_events;
mod task_worker;
mod worker_host;
mod worker_archive;
mod handoff;
mod live_update;
mod frontend_assets;
pub mod settings;
pub mod skills_hub;
#[cfg(windows)]
mod process_liveness;
pub mod slash_commands;
mod launch_protection;
mod startup;
#[cfg(windows)]
mod single_instance;
#[cfg(windows)]
mod windows_shortcuts;
pub mod terminal;
pub mod updater;
pub mod usage;
pub mod web;

use std::sync::Arc;
use tauri::Emitter;
use tauri::Manager;

pub struct AppState {
    pub db: Arc<db::Db>,
    pub sink: Arc<event_sink::EventSink>,
    pub terminal_sink: Arc<event_sink::EventSink>,
    /// 插件 agent 轮次（plugin_agent_start）的独立事件流：与聊天引擎流
    /// 隔离，chat store 不会把插件 run 当孤儿会话收养。
    pub plugin_sink: Arc<event_sink::EventSink>,
    /// 任务工作台 agent 节点的独立事件流（mission-agent://event）。
    pub mission_sink: Arc<event_sink::EventSink>,
    /// Webview + any attached web-access broadcasters (web.rs).
    pub emitters: Arc<event_sink::BroadcastEmit>,
    pub terminals: terminal::TerminalRegistry,
    pub processes: Arc<engine::ProcessRegistry>,
    pub web: web::WebAccessState,
    pub relay: relay::RelayState,
    pub dsh_host: std::sync::Arc<dsh_host::DshHostState>,
    pub opencode_server: std::sync::Arc<engine::opencode_server::OpencodeServerState>,
    /// In-flight worktree creations (git_worktree_create) by creationId —
    /// the cancel command signals through this registry.
    pub worktree_creations: git_worktree::CreationRegistry,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let options = match startup::options(std::env::args_os()) {
        Ok(options) => options,
        Err(error) => { eprintln!("[startup] {error}"); std::process::exit(2); }
    };
    if options.mode == startup::Mode::TaskWorkerProbe {
        println!("{}", task_worker::probe());
        return;
    }
    if let Err(error) = paths::initialize_profile(options.profile.as_deref()) {
        eprintln!("[startup] {error}");
        std::process::exit(2);
    }
    let mode = options.mode;
    // Protect both the installed launcher and retained self-update releases.
    // Service modes inherit the strict environment without opening a dialog.
    launch_protection::arm(&mode);
    if mode == startup::Mode::UpdateSupervisor {
        if let Err(error) = live_update::activation::run_stdio() {
            eprintln!("[live-update] {error}");
            std::process::exit(1);
        }
        return;
    }
    if mode == startup::Mode::TaskWorker {
        if let Err(error) = task_worker::run_worker_stdio() {
            eprintln!("[task-worker] {error}");
            std::process::exit(1);
        }
        return;
    }
    // The CLI's per-run chat MCP child only relays to its owning desktop.
    // It must not initialize another GUI, scan history, or emit stdout logs.
    if mode == startup::Mode::HostChatMcp {
        if let Err(error) = host_chat::serve_stdio() {
            eprintln!("[host-chat] MCP server exited: {error}");
            std::process::exit(1);
        }
        return;
    }
    // MCP server mode: engine CLIs spawn this binary as a computer-use MCP
    // child process (`--mcp-config`). stdout is the protocol channel, so no
    // Tauri runtime — and nothing that prints to stdout — may start here.
    if mode == startup::Mode::ComputerUseMcp {
        paths::ensure_dirs().expect("failed to create app home");
        if let Err(error) = computer_use::mcp::serve_stdio() {
            eprintln!("[computer-use] MCP server exited: {error}");
            std::process::exit(1);
        }
        return;
    }
    // Each GUI generation owns an inner breakaway scope, including launchers
    // that redirect to the committed version. An independent supervisor may
    // inherit a restrictive outer Job; its next GUI must still be able to start
    // another worker/supervisor without escaping that external restriction.
    #[cfg(windows)]
    let _gui_service_scope = match engine::job::GuiServiceScope::acquire() {
        Ok(scope) => scope,
        Err(error) => {
            eprintln!("[startup] {error}");
            std::process::exit(1);
        }
    };
    if options.resume.is_none() {
        match handoff::redirect_committed() {
            Ok(true) => return,
            Ok(false) => {},
            Err(error) => { eprintln!("[live-update] {error}"); std::process::exit(1); }
        }
    }
    // Hold ownership on this main thread until the event loop has returned.
    // Service children above remain independent; a duplicate GUI stops before
    // sweeping files, importing configuration or starting any app services.
    #[cfg(windows)]
    let gui_instance = match single_instance::Gate::acquire(&paths::app_home()) {
        Ok(single_instance::Outcome::Primary(guard)) => guard,
        Ok(single_instance::Outcome::Secondary) => return,
        Err(error) => {
            eprintln!("[single-instance] {error}");
            startup::show_single_instance_error(&error);
            std::process::exit(1);
        }
    };
    #[cfg(windows)]
    let window_marker = gui_instance.window_marker();
    paths::ensure_dirs().expect("failed to create app home");
    if let Err(error) = handoff::load_resume(options.resume.as_deref()) {
        eprintln!("[live-update] {error}");
        std::process::exit(1);
    }
    let mut context = tauri::generate_context!();
    if let Err(error) = frontend_assets::configure(&mut context) {
        eprintln!("[frontend-assets] {error}");
        std::process::exit(1);
    }
    let running_workers = worker_host::startup_workers().unwrap_or_else(|error| {
        eprintln!("[worker-host] {error}");
        #[cfg(windows)]
        startup::show_single_instance_error(&error);
        std::process::exit(1);
    });
    let has_running_workers = !running_workers.is_empty() || handoff::has_resume();
    if !has_running_workers { engine::images::sweep_pasted_images(); }
    // Restore workspace .omp/mcp.json files left injected by a crash
    // (computer use writes them per send and restores on run exit).
    if !has_running_workers { computer_use::sweep_mcp_injections(); }
    if !paths::is_dev_profile() {
        config::import_legacy_config_once();
    }
    // A .app launched from Finder/Launchpad gets the launchd PATH
    // (/usr/bin:/bin:…), so `which::which` can't see CLIs installed via
    // homebrew/npm/nvm and every engine greys out. Adopt the login shell's
    // PATH before any detection/spawn runs.
    if development_profile::automatic_integrations_allowed() {
        adopt_login_shell_path();
    }
    // Apply the persisted network proxy to this process's env before any
    // engine/terminal spawn, so children inherit HTTP(S)_PROXY/ALL_PROXY.
    if let Ok(settings) = settings::read_settings() {
        if development_profile::automatic_integrations_allowed() {
        if let Err(error) = proxy::apply_app_proxy_settings(&settings) {
            eprintln!("[proxy] failed to apply persisted proxy settings: {error}");
        }
        settings::apply_codex_home(&settings);
        }
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    let builder = if development_profile::automatic_integrations_allowed() {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else { builder };
    builder
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Esc-to-stop: only fires while a computer-use run armed
                    // it (computer_use::computer_use_set_active), so Esc is
                    // never swallowed outside a session.
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed
                        && computer_use::esc_armed()
                    {
                        let _ = app.emit(computer_use::ESCAPE_EVENT, ());
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let db = Arc::new(db::Db::open().expect("failed to open app db"));
            // Sweep per-send credential staging left behind by a crash.
            if !has_running_workers { engine::sweep_staging_dirs(); }
            // Explicit development profiles start empty; never import user data.
            if !paths::is_dev_profile() {
                if let Err(error) = db::import_legacy_workspaces_once(&db) {
                    // Import failure must never block startup; the sidebar simply
                    // starts empty and the user adds workspaces by hand.
                    eprintln!("[db] legacy workspace import failed: {error}");
                }

                if let Err(error) = settings::import_legacy_groups_once(&db) {
                    // Same non-fatal rule: groups stay unassigned and the user can
                    // redo them in Settings → 工作区.
                    eprintln!("[settings] legacy group import failed: {error}");
                }

                if let Err(error) = agents::import_legacy_agents_once(&db) {
                    // Same non-fatal rule: the `#` picker simply starts empty.
                    eprintln!("[agents] legacy agent import failed: {error}");
                }
                if let Err(error) = prompts::import_legacy_prompts_once(&db) {
                    // Same non-fatal rule: the `!` picker simply starts empty.
                    eprintln!("[prompts] legacy prompt import failed: {error}");
                }
            }
            // files.rs commands inject State<'_, Arc<db::Db>> for workspace
            // confinement, so the Arc itself must be managed alongside.
            app.manage(Arc::clone(&db));
            let emitters = event_sink::BroadcastEmit::new(Arc::new(app.handle().clone()));
            let state = AppState {
                db,
                sink: event_sink::EventSink::new(emitters.clone()),
                terminal_sink: event_sink::EventSink::with_name(
                    emitters.clone(),
                    terminal::TERMINAL_OUTPUT_EVENT,
                ),
                plugin_sink: event_sink::EventSink::with_name(
                    emitters.clone(),
                    event_sink::PLUGIN_AGENT_EVENT_NAME,
                ),
                mission_sink: event_sink::EventSink::with_name(
                    emitters.clone(),
                    event_sink::MISSION_AGENT_EVENT_NAME,
                ),
                emitters,
                terminals: terminal::TerminalRegistry::default(),
                processes: Arc::new(engine::ProcessRegistry::default()),
                web: web::WebAccessState::default(),
                relay: relay::RelayState::default(),
                dsh_host: std::sync::Arc::new(dsh_host::DshHostState::default()),
                opencode_server: std::sync::Arc::new(
                    engine::opencode_server::OpencodeServerState::default(),
                ),
                worktree_creations: git_worktree::CreationRegistry::default(),
            };
            // Clone what the initial scan needs before state moves into manage.
            let scan_db = Arc::clone(&state.db);
            let scan_sink = Arc::clone(&state.sink);
            auto_title::init(Arc::clone(&state.db), Arc::clone(&state.sink));
            app.manage(state);
            // Provider commands inject State<'_, ConfigStore> directly (not
            // via AppState), so the store must be managed as its own type —
            // otherwise every provider mutation panics with "state() called
            // before manage()".
            app.manage(config::ConfigStore::default());
            assistant_notices::init(app.handle());
            app.manage(Arc::clone(&claude_quota::STATE));
            claude_quota::install_events(Arc::clone(&app.state::<AppState>().emitters));
            app.manage(Arc::clone(&codex_quota::STATE));
            codex_quota::install_events(app.handle());
            app.manage(Arc::clone(&agy_quota::STATE));
            agy_quota::install_events(app.handle());
            // Virtual cursor overlay + its loopback control channel: the
            // --computer-use-mcp child posts action targets here so the
            // blue pointer can follow the agent.
            development_profile::run_automatic(|| {
            if let Err(error) = cu_overlay::init(app.handle()) {
                eprintln!("[cu-overlay] init failed (overlay disabled): {error}");
            }
            if let Err(error) = leader::init(app.handle()) {
                eprintln!("[leader] init failed (task tools unavailable): {error}");
            }
            });
            let restored = tauri::async_runtime::block_on(handoff::restore_services(app.handle(), &running_workers))
                .map_err(std::io::Error::other)?;
            #[cfg(feature = "test-harness")]
            if test_harness::runtime_fixture_enabled() { leader::init(app.handle()).map_err(std::io::Error::other)?; }
            if !restored {
                development_profile::run_automatic(|| {
                    if let Err(error) = host_chat::init(app.handle()) { eprintln!("[host-chat] init failed (chat tools unavailable): {error}"); }
                });
                #[cfg(feature = "test-harness")]
                if test_harness::runtime_fixture_enabled() { host_chat::init(app.handle()).map_err(std::io::Error::other)?; }
            }
            tauri::async_runtime::block_on(worker_host::initialize(app.handle(), running_workers))
                .map_err(std::io::Error::other)?;
            if restored { worker_host::set_paused(true); }
            tauri::async_runtime::block_on(handoff::restore_sources()).map_err(std::io::Error::other)?;
            app.manage(metrics::MetricsState::load().map_err(std::io::Error::other)?);
            // Keep the pairing key from lingering: while the switch is on, a
            // fresh code is minted every ten minutes and broadcast.
            development_profile::run_automatic(|| {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(std::time::Duration::from_secs(600));
                    loop {
                        interval.tick().await;
                        let _ = crate::settings::rotate_web_auth_key(&handle);
                    }
                });
            });
            // Initial history scan, non-blocking.
            development_profile::run_automatic(|| history::scanner::spawn_scan(scan_db, scan_sink));
            // 内置「插件开发」skill：同步进已存在引擎的 skills 根（幂等，失败
            // 只记日志）——skill 只有落在 CLI 自己的根里才会被引擎加载，
            // 见 creator_skill.rs 模块注释。
            development_profile::run_automatic(|| creator_skill::install_at_startup(app.handle()));
            // DSH host autostart: adopt-or-spawn in the background when
            // enabled; failures are logged, never fatal to startup.
            development_profile::run_automatic(|| {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let settings = settings::read_settings().unwrap_or_default();
                    if settings.dsh_auto_start == Some(false) {
                        return;
                    }
                    let state = handle.state::<AppState>();
                    if let Err(error) = dsh_host::ensure_host(&state.dsh_host, &settings).await {
                        eprintln!("[dsh] autostart failed: {error}");
                    }
                });
            });
            // Relay autostart: the outbound tunnel is what keeps the machine
            // reachable with nobody at the desk, so it comes back on launch
            // when the switch was left on. Failures are logged, never fatal;
            // the running task retries the dial by itself from there.
            development_profile::run_automatic(|| {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let settings = settings::read_settings().unwrap_or_default();
                    let Some((url, key)) = relay::autostart_target(&settings) else {
                        return;
                    };
                    if let Err(error) = relay::web_relay_start(handle, url, key).await {
                        eprintln!("[relay] autostart failed: {error}");
                    }
                });
            });
            // Dev convenience: `CCGUI_WEB_AUTOSTART=1 pnpm dev` starts the LAN
            // bridge at launch and prints the URL, so the web build can be
            // exercised without clicking the settings toggle.
            #[cfg(debug_assertions)]
            if development_profile::automatic_integrations_allowed() && std::env::var_os("CCGUI_WEB_AUTOSTART").is_some() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match web::web_access_start(handle).await {
                        Ok(info) => println!("[web] dev autostart: {}", info.url),
                        Err(error) => eprintln!("[web] autostart failed: {error}"),
                    }
                });
            }
            // 窗口在 setup 末尾创建（tauri.conf.json 不再声明 windows），这样能按持久化
            // 设置决定装饰：Windows 可选仿 mac 自绘标题栏（decorations=false + shadow，
            // 保留 DWM 阴影与四边缩放），macOS 保持 Overlay + 系统原生红绿灯（与原配置
            // 一致）。放在 manage(state) 之后：窗口一开始加载前端就会 invoke 命令，
            // 状态必须已经就位。设置改动需重启应用。
            #[cfg(target_os = "windows")]
            let settings = settings::read_settings().unwrap_or_default();
            let mut window_builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("CC GUI")
            .inner_size(1400.0, 900.0)
            .min_inner_size(900.0, 600.0);
            #[cfg(feature = "test-harness")]
            if test_harness::runtime_fixture_enabled() { window_builder = window_builder.visible(false); }
            if let Some(directory) = development_profile::webview_dir() {
                #[cfg(not(target_os = "macos"))]
                {
                    window_builder = window_builder.data_directory(directory);
                }
                #[cfg(target_os = "macos")]
                {
                    use sha2::{Digest, Sha256};
                    let digest = Sha256::digest(directory.to_string_lossy().as_bytes());
                    window_builder = window_builder.data_store_identifier(digest[..16].try_into().unwrap());
                }
            }
            #[cfg(target_os = "macos")]
            {
                // 原 tauri.conf.json: titleBarStyle "Overlay" + hiddenTitle true。
                window_builder = window_builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }
            #[cfg(target_os = "windows")]
            {
                let mac_like = settings.titlebar == "mac";
                window_builder = window_builder.decorations(!mac_like);
                if mac_like {
                    // 无装饰窗口默认没有 DWM 阴影；打开它保住阴影（也让四边缩放走原生路径）。
                    window_builder = window_builder.shadow(true);
                }
            }
            let _main_window = window_builder
                .build()
                .expect("failed to create main window");
            #[cfg(feature = "test-harness")]
            test_harness::install_runtime_fixture_bridge(app.handle(), &_main_window)
                .map_err(std::io::Error::other)?;
            #[cfg(windows)]
            {
                let publication = _main_window
                    .hwnd()
                    .map_err(|error| format!("single-instance main-window handle unavailable: {error}"))
                    .and_then(|window| window_marker.attach_window(window));
                if let Err(error) = publication {
                    startup::show_single_instance_error(&error);
                    return Err(error.into());
                }
                app.manage(window_marker.clone());
            }
            // Cmd+Q / AppleScript `quit` bypass both the window X's
            // CloseRequested and Tauri's ExitRequested on macOS; without
            // this hook one stray quit kills every live engine run with no
            // dialog (see quit_guard.rs).
            quit_guard::install(app.handle());
            // The pet is a separate transparent native window. It is created
            // only when the persisted setting is enabled; the default is off.
            development_profile::run_automatic(|| pet_overlay::init(app.handle()));
            #[cfg(windows)]
            development_profile::run_automatic(windows_shortcuts::spawn_startup_repair);
            development_profile::run_automatic(|| app_cache::spawn_startup_cache_maintenance());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // The pet is a secondary window.  It must not run the main
                // window's process/terminal teardown, and the main window
                // must destroy it before the app can exit.
                if window.label() != "main" {
                    return;
                }
                // A secondary reminder window must not keep the process alive
                // after the main window is gone. stop() never waits on presentation.
                if let Some(notices) = window.try_state::<Arc<assistant_notices::Service>>() {
                    notices.stop();
                }
                tauri::async_runtime::block_on(worker_host::shutdown(handoff::preserving_workers()));
                #[cfg(windows)]
                if let Err(error) = startup::withdraw_instance_marker(window.app_handle()) {
                    eprintln!("[single-instance] window retirement failed: {error}");
                }
                host_chat::shutdown();
                leader::shutdown();
                if let Some(pet) = window.app_handle().get_webview_window("pet-overlay") {
                    let _ = pet.destroy();
                }
                if let Some(state) = window.try_state::<AppState>() {
                    state.processes.kill_all();
                    state.dsh_host.kill_spawned();
                    state.opencode_server.kill_spawned();
                    plugin_caps::kill_all_tracked_children();
                    tauri::async_runtime::block_on(terminal::kill_all(&state.terminals));
                    computer_use::disarm_esc(&window.app_handle());
                    cu_overlay::shutdown();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            handoff::live_update_status,
            handoff::live_update_request,
            handoff::live_update_stage,
            handoff::live_update_begin,
            handoff::live_update_activate,
            handoff::live_update_abort,
            handoff::live_update_bootstrap,
            handoff::live_update_frontend_ready,
            handoff::live_update_confirm,
            handoff::runtime_observer_respond,
            worker_host::runtime_worker_sources,
            worker_host::runtime_worker_events,
            worker_host::runtime_worker_control,
            worker_host::runtime_worker_start,
            development_profile::development_profile_active,
            interactive_answer_state::interactive_answer_read,
            interactive_answer_state::interactive_answer_write,
            interactive_answer_state::interactive_answer_reset,
            assistant_notices::assistant_notices_status,
            assistant_notices::assistant_notices_configure,
            assistant_notices::assistant_notices_displays,
            assistant_notices::assistant_notices_attach,
            assistant_notices::assistant_notices_sync,
            assistant_notices::assistant_notices_list,
            assistant_notices::assistant_notices_history,
            assistant_notices::assistant_notices_read,
            assistant_notices::assistant_notices_pin,
            assistant_notices::assistant_notices_open,
            assistant_notices::assistant_notices_focus_ack,
            assistant_notices::assistant_notices_hold,
            assistant_notices::assistant_notices_drag,
            assistant_notices::assistant_notices_pointer,
            assistant_notices::assistant_notices_size,
            // 窗口
            settings::restart_app,
            // Private desktop chat relay; only the main webview may answer.
            host_chat::host_chat_ready,
            host_chat::host_chat_respond,
            host_chat::host_chat_is_running,
            host_chat::host_chat_ledger_get,
            host_chat::host_chat_ledger_set,
            host_chat::host_chat_ledger_delete,
            leader::task_snapshot,
            leader::task_branch_action,
            leader::task_delete_branch,
            leader::task_group_action,
            // config
            config::get_cli_config,
            claude_quota::claude_quota_read,
            codex_quota::codex_quota_read,
            codex_context_window::codex_context_window_read,
            codex_context_window::codex_context_window_write,
            agy_quota::agy_quota_read,
            agy_vertex_credits::agy_vertex_credits_read,
            cursor_quota::cursor_quota_read,
            throughput_stats::throughput_stats_read,
            config::upsert_provider,
            config::delete_provider,
            config::set_current_provider,
            provider_files::provider_file_paths,
            provider_files::official_config_read,
            provider_files::official_config_write,
            config::reorder_providers,
            config::set_engine_enabled,
            // in-app browser tabs (child webviews)
            browser::browser_create,
            browser::browser_close,
            browser::browser_navigate,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_go_back,
            browser::browser_go_forward,
            browser::browser_reload,
            browser::browser_current_url,
            // cc-switch interop
            cc_switch::check_cc_switch,
            cc_switch::dismiss_cc_switch,
            cc_switch::import_cc_switch,
            cc_switch::import_cc_switch_from_path,
            provider_models::fetch_provider_models,
            // settings
            settings::get_app_settings,
            settings::update_app_settings,
            settings::set_window_theme,
            // uploaded font files (设置 → 外观 字体行)
            fonts::read_font_file,
            // desktop pet
            pets::pet_list,
            pets::pet_import,
            pets::pet_remove,
            pets::pet_get_package,
            pet_overlay::pet_set_visible,
            pet_overlay::pet_set_scale,
            pet_overlay::pet_set_state,
            pet_overlay::pet_save_position,
            // updater
            updater::fetch_latest_release_info,
            // plugins
            plugins::plugin_list,
            plugins::plugin_install_from_path,
            plugins::plugin_uninstall,
            plugins::plugin_set_enabled,
            plugins::plugin_reload,
            plugins::plugin_quarantine,
            plugins::plugin_read_artwork,
            plugins::plugin_read_file,
            plugins::plugin_storage_get,
            plugins::plugin_storage_set,
            plugins::plugin_storage_delete,
            // plugin marketplace (Phase 3, plan §6)
            plugins::market::plugin_fetch_index,
            plugins::market::plugin_fetch_market_readme,
            plugins::market::plugin_install_from_marketplace,
            plugins::market::plugin_check_updates,
            // engine
            engine::send_message,
            engine::send_side_message,
            engine::cleanup_side_session,
            engine::promote_side_session,
            engine::active_run_ids,
            engine::interrupt_session,
            engine::interrupt_turn,
            engine::stop_native_task,
            engine::send_follow_up,
            engine::answer_question,
            engine::respond_plan_review,
            engine::runtime_worker_plan_review,
            engine::list_plan_reviews,
            engine::list_engines,
            engine::models::list_engine_models,
            engine::cursor_picker::cursor_model_catalog,
            engine::pi_family_auth::pi_family_auth_list,
            engine::pi_family_auth::pi_family_auth_set_api_key,
            engine::pi_family_auth::pi_family_auth_delete_credential,
            engine::pi_family_auth::pi_family_models_config_read,
            engine::pi_family_auth::pi_family_models_config_write,
            engine::images::save_pasted_image,
            engine::images::import_attachments,
            // computer use
            computer_use::computer_use_permission_status,
            computer_use::computer_use_open_permission_settings,
            computer_use::computer_use_set_active,
            // MCP inventory (设置 → 能力扩展 → MCP), shared with approved Web clients.
            mcp::mcp_inventory,
            mcp::mcp_set_enabled,
            mcp::probe::mcp_probe,
            // skills hub (设置 → 能力扩展 → Skills)
            skills_hub::skills_hub_query,
            skills_hub::skills_hub_mutate,
            // history
            history::reader::list_sessions,
            history::reader::list_archived_sessions,
            history::reader::archive_session,
            history::reader::restore_session,
            usage::usage_record,
            usage::usage_summary,
            usage::usage_clear,
            history::reader::load_session_page,
            history::reader::load_remote_session_page,
            history::search::search_messages,
            history::reader::delete_session,
            history::reader::delete_remote_session,
            history::reader::pin_session,
            history::reader::rename_session,
            auto_title::suggest_session_title,
            auto_title::auto_title_models,
            composer_prediction::predict_next_prompt,
            app_cache::summarize_session_handoff,
            app_cache::inspect_app_cache,
            app_cache::prune_app_cache,
            history::reader::remember_session_model,
            history::reader::remember_session_effort,
            history::reader::remember_claude_ultracode,
            history::reader::remember_session_provider,
            history::reader::rescan_sessions,
            history::reader::list_workspaces,
            history::reader::add_workspace,
            history::reader::reorder_workspaces,
            history::reader::remove_workspace,
            history::reader::set_workspace_group,
            // files
            files::list_dir,
            files::read_file,
            files::write_file,
            files::create_dir,
            files::rename_item,
            files::trash_item,
            files::duplicate_item,
            files::paste_item,
            files::create_file,
            files::search_text,
            files::list_file_index,
            // composer `/` slash-command picker
            slash_commands::list_slash_commands,
            // bundled plugin-development skill (created via the plugin hub's
            // 创建插件 entry; idempotent per-engine install)
            creator_skill::creator_skill_install,
            // agents & prompts (composer `#`/`!` pickers)
            agents::agent_list,
            agents::agent_add,
            agents::agent_update,
            agents::agent_delete,
            // built-in agent catalog (agency-agents pack)
            agent_catalog::list_built_in_agents,
            agent_catalog::set_built_in_agent_enabled,
            agent_catalog::set_built_in_agent_division_enabled,
            agent_catalog::get_built_in_agent_prompt,
            agent_catalog::resolve_enabled_built_in_agent,
            prompts::prompts_list,
            prompts::prompts_dirs,
            prompts::prompts_create,
            prompts::prompts_update,
            prompts::prompts_delete,
            prompts::prompts_move,
            // On-demand host directory grants, shared with approved Web clients.
            files::grant_scope,
            files::grant_root,
            files::list_granted_roots,
            files::revoke_granted_root,
            // git
            git::git_status,
            git::git_repository_summaries,
            git::git_file_colors,
            git::git_tree_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_branches,
            git::git_checkout,
            git::git_create_branch,
            git_worktree::git_worktree_list,
            git_worktree::git_worktree_create,
            git_worktree::git_worktree_create_cancel,
            git_worktree::git_worktree_creation_snapshot,
            git_worktree::git_worktree_remove,
            git_worktree::git_branch_merged,
            git_worktree::git_resolve_pr,
            // open-app
            open_app::open_workspace_in,
            open_app::open_custom_program,
            open_app::get_program_icon,
            open_app::reveal_in_file_manager,
            // terminal
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            // metrics
            metrics::app_metrics,
            metrics::performance_diagnostics,
            metrics::performance_diagnostics_enabled,
            metrics::performance_diagnostics_set_enabled,
            // plugin capability egress (network:/exec: manifest grants)
            plugin_caps::plugin_http_request,
            plugin_caps::plugin_add_workspace,
            plugin_caps::plugin_exec_run,
            plugin_caps::plugin_exec_spawn,
            plugin_caps::plugin_exec_kill,
            plugin_caps::plugin_agent_start,
            plugin_caps::plugin_agent_interrupt,
            mission::mission_agent_start,
            mission::mission_agent_interrupt,
            // web access
            web::web_access_start,
            web::web_access_stop,
            web::web_access_status,
            // Device rows: the bridge already dispatched these for phones,
            // but the desktop page invokes them over IPC too — without this
            // registration its list silently stayed empty.
            web::web_devices,
            web::web_device_approve,
            web::web_device_rename,
            web::web_device_revoke,
            // Rotating the pairing code does not revoke existing device approvals.
            web::rotate_web_pair_key,
            web::remote_control_active,
            relay::web_relay_start,
            relay::web_relay_stop,
            relay::web_relay_status,
            relay::relay_deploy_pack,
            relay::relay_deploy,
            // dsh host + managed-CLI lifecycle
            dsh_host::dsh_host_status,
            dsh_host::dsh_host_start,
            dsh_host::dsh_host_stop,
            cli_lifecycle::cli_version_status,
            cli_lifecycle::cli_update_plan,
            cli_lifecycle::cli_update_snapshot,
            cli_lifecycle::cli_update,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(host) = app.try_state::<Arc<assistant_notices::Service>>() {
                    host.stop();
                }
                #[cfg(windows)]
                if let Err(error) = startup::withdraw_instance_marker(app) {
                    eprintln!("[single-instance] exit retirement failed: {error}");
                }
                if let Some(metrics) = app.try_state::<metrics::MetricsState>() {
                    metrics.stop();
                }
            }
        });
}
/// Probe the user's login+interactive shell for its PATH and install it into
/// this process. `-l` sources .zprofile (homebrew), `-i` sources .zshrc
/// (nvm/volta/npm-global). No-op on failure: detection simply falls back to
/// the inherited PATH.
///
/// Interactive rc files can block on network fetches or keychain prompts, so
/// the probe is capped at 3s — a hung login shell must never stall startup.
#[cfg(unix)]
fn adopt_login_shell_path() {
    const MARKER: &str = "__OMP_GUI_PATH__";
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let script = format!("echo '{MARKER}'\"$PATH\"");
    let Ok(mut child) = std::process::Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return;
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        return;
    };
    // read_to_string ends at pipe EOF, i.e. exactly when the shell exits
    // (rc files backgrounding nothing sane). A helper thread keeps the read
    // off this startup path so the timeout below stays in charge.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        let _ = tx.send(out);
    });
    let Ok(stdout) = rx.recv_timeout(TIMEOUT) else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };
    if !child.wait().map(|s| s.success()).unwrap_or(false) {
        return;
    }
    // Shell rc files may print noise; only the marked line is authoritative.
    for line in stdout.lines().rev() {
        if let Some(path) = line.trim().strip_prefix(MARKER) {
            if !path.is_empty() {
                std::env::set_var("PATH", path);
            }
            return;
        }
    }
}

#[cfg(not(unix))]
fn adopt_login_shell_path() {}
