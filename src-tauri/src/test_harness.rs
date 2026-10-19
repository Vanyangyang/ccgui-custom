//! Opt-in, process-scoped integration fixtures. All tests in a fixture binary
//! must acquire this guard before using application paths or engine commands.
//! No application startup installs a context, and this feature cannot ship.

#[cfg(not(debug_assertions))]
compile_error!(
    "test-harness is for debug integration tests only; never enable it in a release build"
);

use std::any::Any;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

static SERIAL: Mutex<()> = Mutex::new(());
static CONTEXT: Mutex<Option<Context>> = Mutex::new(None);

#[derive(Clone)]
struct Context {
    root: PathBuf,
    profile: Option<PathBuf>,
    binaries: HashMap<String, PathBuf>,
    /// The only Codex Desktop channels a fixture may reach; never discovered.
    desktop_pipes: Vec<String>,
    search_path: OsString,
    #[cfg(windows)]
    wrappers: HashMap<String, PathBuf>,
}

/// Owns a newly created scratch directory, the in-memory resolver context and
/// every environment change. The serial lock is deliberately recovered after
/// a failed test: that test still fails, but cannot poison the remaining cases.
pub struct TestHarness {
    root: PathBuf,
    temp_parent: PathBuf,
    previous_env: Vec<(&'static str, Option<OsString>)>,
    processes: Mutex<Vec<Arc<crate::engine::ProcessRegistry>>>,
    databases: Mutex<Vec<Arc<crate::db::Db>>>,
    keepalives: Mutex<Vec<Box<dyn Any + Send + Sync>>>,
    _serial: MutexGuard<'static, ()>,
}

impl TestHarness {
    pub fn new() -> Result<Self, String> {
        let serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
        let temp_parent = std::fs::canonicalize(std::env::temp_dir())
            .map_err(|error| format!("resolve fixture parent: {error}"))?;
        let root = temp_parent.join(format!("ccgui-send-fixture-{}", uuid::Uuid::new_v4()));
        if root.to_str().is_none() {
            return Err("fixture root must be valid UTF-8 for engine launch paths".into());
        }
        // create_dir rather than create_dir_all proves ownership of this exact root.
        std::fs::create_dir(&root).map_err(|error| format!("create fixture root: {error}"))?;
        let mut guard = Self {
            root,
            temp_parent,
            previous_env: Vec::new(),
            processes: Mutex::new(Vec::new()),
            databases: Mutex::new(Vec::new()),
            keepalives: Mutex::new(Vec::new()),
            _serial: serial,
        };
        for child in [
            "bin",
            "ws",
            ".ccgui-next",
            ".claude",
            ".codex",
            ".omp",
            "appdata",
            "localappdata",
            "tmp",
        ] {
            std::fs::create_dir(guard.root.join(child))
                .map_err(|error| format!("create fixture {child}: {error}"))?;
        }
        // Claude's native quota detector walks workspace ancestors before
        // consulting CLAUDE_CONFIG_DIR. A fixture-local routing override stops
        // that walk here, before it can inspect the real profile's settings.
        let workspace_config = guard.root.join("ws/.claude");
        std::fs::create_dir(&workspace_config)
            .map_err(|error| format!("create fixture workspace config: {error}"))?;
        std::fs::write(
            workspace_config.join("settings.local.json"),
            br#"{"env":{"CLAUDE_CONFIG_DIR":"fixture-only"}}"#,
        )
        .map_err(|error| format!("write fixture workspace config: {error}"))?;
        #[cfg(windows)]
        let mut wrappers = HashMap::new();
        let mut search_dirs = vec![guard.root.join("bin")];
        #[cfg(windows)]
        {
            let system_root =
                std::env::var_os("SystemRoot").ok_or("Windows SystemRoot is unavailable")?;
            let system32 = PathBuf::from(system_root).join("System32");
            for (name, path) in [
                ("cmd", system32.join("cmd.exe")),
                (
                    "powershell",
                    system32.join("WindowsPowerShell/v1.0/powershell.exe"),
                ),
            ] {
                let path = std::fs::canonicalize(path)
                    .map_err(|error| format!("resolve system fixture wrapper {name}: {error}"))?;
                if !path.is_file() || path.to_str().is_none() {
                    return Err(format!(
                        "fixture wrapper {name} must be a file with a UTF-8 path"
                    ));
                }
                search_dirs.push(path.parent().unwrap().to_path_buf());
                wrappers.insert(name.to_string(), path);
            }
        }
        #[cfg(unix)]
        search_dirs.push(PathBuf::from("/bin"));
        let search_path = std::env::join_paths(search_dirs)
            .map_err(|error| format!("join fixture PATH: {error}"))?;
        // Native code also reads USERPROFILE and engine-home env vars directly.
        // Redirect those only inside this owned, serialized integration scope.
        for (key, relative) in [
            ("HOME", ""),
            ("USERPROFILE", ""),
            ("APPDATA", "appdata"),
            ("LOCALAPPDATA", "localappdata"),
            ("CLAUDE_CONFIG_DIR", ".claude"),
            ("CODEX_HOME", ".codex"),
            ("PI_CODING_AGENT_DIR", ".pi"),
            ("OMP_CODING_AGENT_DIR", ".omp"),
            ("KIMI_CODE_HOME", ".kimi-code"),
            ("GROK_HOME", ".grok"),
            ("ANTIGRAVITY_HOME", ".agy"),
        ] {
            let value = guard.root.join(relative).into_os_string();
            guard.set_env(key, Some(value));
        }
        for key in [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            "ANTHROPIC_SMALL_FAST_MODEL",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
            "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
            "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "GROK_CONFIG_PATH",
            "GROK_AUTH_PATH",
        ] {
            guard.set_env(key, None);
        }
        *CONTEXT.lock().unwrap_or_else(|error| error.into_inner()) = Some(Context {
            root: guard.root.clone(),
            profile: None,
            binaries: HashMap::new(),
            desktop_pipes: Vec::new(),
            search_path,
            #[cfg(windows)]
            wrappers,
        });
        Ok(guard)
    }

    fn set_env(&mut self, key: &'static str, value: Option<OsString>) {
        self.previous_env.push((key, std::env::var_os(key)));
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Use the real startup resolver, scoped to this fixture and removed at drop.
    pub fn use_profile(&self, path: &Path) -> Result<(), String> {
        crate::paths::initialize_profile(Some(path))
    }

    /// One-shot integration test of real, non-cfg(test) profile branches.
    /// Registered binaries are checked before suspending the fixture resolver;
    /// HOME remains synthetic, and the actual product environment code runs.
    pub fn with_ordinary_profile<T>(&self, path: &Path, cli: &str, test: impl FnOnce(PathBuf) -> T) -> Result<T, String> {
        let mut context = CONTEXT.lock().unwrap_or_else(|error| error.into_inner());
        let saved = context.take().ok_or("fixture context is inactive")?;
        let binary = registered_binary(&saved, cli);
        struct Restore(Option<Context>);
        impl Drop for Restore {
            fn drop(&mut self) { *CONTEXT.lock().unwrap_or_else(|error| error.into_inner()) = self.0.take(); }
        }
        let restore = Restore(Some(saved));
        drop(context);
        let binary = binary.ok_or("ordinary profile test requires a registered fake CLI")?;
        let canonical = crate::paths::resolve_dev_profile(path, &self.root)?;
        if !canonical.starts_with(dunce::simplified(&self.root)) { return Err("ordinary fixture profile escapes its root".into()); }
        crate::paths::initialize_ordinary_profile(&canonical, &self.root)?;
        let result = test(dunce::simplified(&binary).to_path_buf());
        drop(restore);
        Ok(result)
    }

    pub fn set_fixture_env(&mut self, key: &'static str, value: Option<OsString>) { self.set_env(key, value); }

    /// Teardown also kills fixture children if an assertion unwinds before
    /// the normal terminal-event/process-drain wait completes.
    pub fn track_processes(&self, processes: Arc<crate::engine::ProcessRegistry>) {
        self.processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(processes);
    }

    /// MockRuntime may retain managed state past App::drop. Only a database
    /// inside this owned fixture may be explicitly closed during teardown.
    pub fn track_database(&self, db: Arc<crate::db::Db>) -> Result<(), String> {
        let path =
            db.0.lock()
                .path()
                .map(PathBuf::from)
                .ok_or("fixture database must have an owned on-disk path")?;
        let path = std::fs::canonicalize(path)
            .map_err(|error| format!("resolve fixture database: {error}"))?;
        if !path.starts_with(&self.root) {
            return Err("fixture database must stay inside its owned scratch root".into());
        }
        self.databases
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(db);
        Ok(())
    }

    /// Keep fixture resources alive outside managed Tauri state. They are
    /// released after child teardown and before scratch-directory cleanup.
    pub fn keep_alive<T: Any + Send + Sync>(&self, value: T) {
        self.keepalives
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(Box::new(value));
    }

    /// Registration permits only files this fixture owns. Every lookup checks
    /// again, so deleting/replacing a registered fake cannot enable fallback.
    pub fn register_cli(&self, name: &str, path: &Path) -> Result<(), String> {
        if name.is_empty() || name.contains(['/', '\\']) {
            return Err("fixture CLI name must be a bare name".into());
        }
        let canonical =
            std::fs::canonicalize(path).map_err(|error| format!("resolve fixture CLI: {error}"))?;
        if !canonical.starts_with(self.root.join("bin"))
            || !canonical.is_file()
            || canonical.to_str().is_none()
        {
            return Err("fixture CLI must be a file inside this fixture's bin directory".into());
        }
        let mut context = CONTEXT.lock().unwrap_or_else(|error| error.into_inner());
        let context = context.as_mut().ok_or("fixture context is inactive")?;
        context.binaries.insert(name.to_string(), canonical);
        Ok(())
    }

    /// A fake Codex Desktop channel served by the test itself. Its name can
    /// never match a real Desktop pipe, and discovery is off for fixtures.
    pub fn register_codex_desktop_pipe(&self, path: &str) -> Result<(), String> {
        if !path.starts_with(r"\\.\pipe\ccgui-fixture-") {
            return Err("fixture Codex Desktop pipes must be named ccgui-fixture-*".into());
        }
        let mut context = CONTEXT.lock().unwrap_or_else(|error| error.into_inner());
        let context = context.as_mut().ok_or("fixture context is inactive")?;
        context.desktop_pipes.push(path.to_string());
        Ok(())
    }
}

impl Drop for TestHarness {
    fn drop(&mut self) {
        for processes in self
            .processes
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
        {
            processes.kill_all();
        }
        for db in self
            .databases
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
        {
            // Close the file without invalidating references to managed Db.
            // An empty memory connection keeps those references valid while
            // the mock runtime finishes releasing its own managed objects.
            match rusqlite::Connection::open_in_memory() {
                Ok(empty) => {
                    let mut connection = db.0.lock();
                    let owned = std::mem::replace(&mut *connection, empty);
                    if let Err((owned, error)) = owned.close() {
                        *connection = owned;
                        eprintln!("[test-harness] fixture database close failed: {error}");
                    }
                }
                Err(error) => eprintln!("[test-harness] fixture database teardown failed: {error}"),
            }
        }
        self.keepalives
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        *CONTEXT.lock().unwrap_or_else(|error| error.into_inner()) = None;
        for (key, previous) in self.previous_env.iter().rev() {
            match previous {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        // Never recursively delete an unverified/replaced path or another
        // test's directory. This root was exclusively created by this guard.
        if self.root.parent() == Some(self.temp_parent.as_path())
            && self
                .root
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("ccgui-send-fixture-"))
            && std::fs::canonicalize(&self.root).ok().as_ref() == Some(&self.root)
        {
            if let Err(error) = std::fs::remove_dir_all(&self.root) {
                eprintln!("[test-harness] fixture cleanup failed: {error}");
            }
        }
    }
}

fn context() -> Option<Context> {
    CONTEXT
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    context().map(|context| context.root)
}

pub(crate) fn profile() -> Option<Option<PathBuf>> {
    context().map(|context| context.profile)
}

pub(crate) fn set_profile(path: &Path) -> Option<Result<(), String>> {
    let mut context = CONTEXT.lock().unwrap_or_else(|error| error.into_inner());
    let context = context.as_mut()?;
    if !path.starts_with(dunce::simplified(&context.root)) {
        return Some(Err("fixture profile must stay inside its owned scratch root".into()));
    }
    context.profile = Some(path.to_path_buf());
    Some(Ok(()))
}
/// Outer None means ordinary runtime; inside a fixture only registered fakes.
pub(crate) fn codex_desktop_pipes() -> Option<Vec<String>> {
    context().map(|context| context.desktop_pipes)
}
pub(crate) fn cli_search_path() -> Option<OsString> {
    context().map(|context| context.search_path)
}

fn registered_binary(context: &Context, name: &str) -> Option<PathBuf> {
    let candidate = if Path::new(name).is_absolute() || name.contains(['/', '\\']) {
        let candidate = std::fs::canonicalize(name).ok()?;
        context
            .binaries
            .values()
            .find(|path| **path == candidate)?
            .clone()
    } else {
        context.binaries.get(name)?.clone()
    };
    let canonical = std::fs::canonicalize(&candidate).ok()?;
    (canonical == candidate
        && canonical.starts_with(context.root.join("bin"))
        && canonical.is_file())
    .then_some(candidate)
}

/// Outer None means ordinary runtime; Some(None) is an active fixture refusal.
pub(crate) fn find_cli_binary(name: &str, custom: Option<&str>) -> Option<Option<PathBuf>> {
    context().map(|context| {
        registered_binary(
            &context,
            custom
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(name)
                .trim(),
        )
    })
}

pub(crate) fn launchable_binary(name: &str) -> Option<PathBuf> {
    context().map(|context| {
        registered_binary(&context, name.trim())
            // Missing path is absolute, cannot be searched on PATH or shell-wrapped.
            .unwrap_or_else(|| context.root.join("missing-fake-cli").join("executable"))
    })
}

#[cfg(windows)]
pub(crate) fn wrapper_program(name: &str) -> Option<PathBuf> {
    context().map(|context| {
        context
            .wrappers
            .get(name)
            .cloned()
            .unwrap_or_else(|| context.root.join("missing-fake-cli").join("wrapper"))
    })
}

pub(crate) fn configure_command(command: &mut tokio::process::Command) {
    let Some(context) = context() else {
        return;
    };
    // Fake children never inherit credentials, user CLI paths or login hooks.
    command.env_clear().env("PATH", &context.search_path);
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    for (key, relative) in [
        ("HOME", ""),
        ("USERPROFILE", ""),
        ("APPDATA", "appdata"),
        ("LOCALAPPDATA", "localappdata"),
        ("TEMP", "tmp"),
        ("TMP", "tmp"),
        ("CLAUDE_CONFIG_DIR", ".claude"),
        ("CODEX_HOME", ".codex"),
        ("PI_CODING_AGENT_DIR", ".pi"),
        ("OMP_CODING_AGENT_DIR", ".omp"),
    ] {
        command.env(key, context.root.join(relative));
    }
}

/// Calls the shared ordinary-runtime implementation, without a fake substitute.
pub mod profile_runtime_support {
    use std::path::{Path, PathBuf};
    pub fn command(bin: &str) -> tokio::process::Command { crate::engine::resolve::command_for_binary(bin) }
    pub fn engine_home(key: Option<&str>, suffix: &str) -> PathBuf { crate::engine::engine_home(key, suffix) }
    pub fn codex_home() -> PathBuf { crate::engine::codex_home() }
    pub fn apply_codex_home(settings: &crate::settings::AppSettings) { crate::settings::apply_codex_home(settings); }
    pub fn enforce_homes(command: &mut tokio::process::Command) { crate::development_profile::enforce_homes(command); }
    pub async fn login_environment(command: &mut tokio::process::Command) { crate::engine::codex_provider_env::apply(command).await; }
    pub fn quota_account_stamp() -> Option<String> { crate::claude_quota::account_stamp() }
    pub fn history_roots(workspace: &Path) -> Vec<PathBuf> { crate::history::discovery::opencode_data_roots(workspace) }
    pub fn webview_dir() -> Option<PathBuf> { crate::development_profile::webview_dir() }
    pub fn automatic(action: impl FnOnce()) { crate::development_profile::run_automatic(action); }
    pub fn relay_scope() -> Option<String> { crate::development_profile::relay_scope() }
    pub fn bridge_binding(discover_lan: impl FnOnce() -> Option<String>) -> (std::net::SocketAddr, String) {
        crate::web::bridge_binding(crate::paths::is_dev_profile(), discover_lan)
    }
    pub async fn relay_gate<F, Fut>(development: bool, protocol: Option<&str>, target: &str, probe: F) -> Result<(), String>
    where F: FnOnce() -> Fut, Fut: std::future::Future<Output = Result<serde_json::Value, String>> {
        crate::relay::validate_profile_worker(development, protocol, target, probe).await
    }
}

/// Existing production protocol exposed only by the opt-in debug harness, so
/// process fixtures can exercise the actual --task-worker binary without GUI.
pub mod worker_process_support {
    pub use crate::leader::initialize_worker_fixture_schema as initialize_worker_schema;
    pub use crate::task_worker::{schema_hash, Command, Outcome, Request, Response, StartArgs,
        WorkerClient, WorkerConfig, WorkerManifest, PROTOCOL};
    pub use crate::worker_archive::{open as open_archive, Archive};
}

/// Explicit hermetic GUI fixtures may start profile-local coordinators. This
/// module is absent from release builds and requires an isolated profile.
pub fn runtime_fixture_enabled() -> bool {
    crate::paths::is_dev_profile() && std::env::var("CCGUI_RUNTIME_FIXTURE").as_deref() == Ok("1")
}

mod runtime_fixture_bridge;
pub use runtime_fixture_bridge::install_runtime_fixture_bridge;
