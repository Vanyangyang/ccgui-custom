//! Windows GUI ownership, scoped to the resolved application data directory.
//!
//! The guard must remain on the acquiring thread until the GUI event loop exits:
//! Win32 mutex ownership belongs to a thread, not to a process or a HANDLE.

use sha2::{Digest, Sha256};
use std::{
    marker::PhantomData,
    path::Path,
    rc::Rc,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use windows::{
    core::{BOOL, PCWSTR},
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS, ERROR_SUCCESS, HANDLE,
            HWND, LPARAM, WAIT_ABANDONED, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
        System::Threading::{CreateMutexW, GetCurrentProcessId, ReleaseMutex, WaitForSingleObject},
        UI::WindowsAndMessaging::{
            EnumWindows, FlashWindowEx, GetForegroundWindow, GetPropW, GetWindowThreadProcessId,
            IsIconic, IsWindow, IsWindowVisible, RemovePropW, SetForegroundWindow, SetPropW,
            ShowWindowAsync, FLASHWINFO, FLASHW_TRAY, SW_RESTORE, SW_SHOW,
        },
    },
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_INTERVAL: Duration = Duration::from_millis(50);
const RESTORE_TIMEOUT: Duration = Duration::from_secs(2);

pub struct Gate;

pub enum Outcome {
    Primary(Guard),
    Secondary,
}

pub struct Guard {
    handle: HANDLE,
    owned: bool,
    marker: WindowMarker,
    // Rc is neither Send nor Sync; releasing a mutex on another thread is invalid.
    _thread_bound: PhantomData<Rc<()>>,
}

/// May be captured by Tauri's Send setup closure; it never owns or releases the mutex.
#[derive(Clone)]
pub struct WindowMarker {
    property: Vec<u16>,
    pid: u32,
    state: Arc<Mutex<WindowState>>,
}

struct WindowState {
    active: bool,
    window: Option<isize>,
}

impl Gate {
    pub fn acquire(app_home: &Path) -> Result<Outcome, String> {
        let key = profile_key(app_home)?;
        let mut guard = open_gate(&key)?;
        if guard.owned || wait_for_owner(&mut guard, STARTUP_TIMEOUT, activate_window)? {
            Ok(Outcome::Primary(guard))
        } else {
            Ok(Outcome::Secondary)
        }
    }
}

impl Guard {
    pub fn window_marker(&self) -> WindowMarker {
        self.marker.clone()
    }
}

impl WindowMarker {
    /// Publish only the main GUI window, after its construction has succeeded.
    pub fn attach_window(&self, window: HWND) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "single-instance window publication state is poisoned".to_owned())?;
        if !state.active {
            return Err(
                "single-instance window publication requires a live ownership guard".into(),
            );
        }
        if state.window.is_some() {
            return Err("single-instance main window is already published".into());
        }
        unsafe {
            if !IsWindow(Some(window)).as_bool() {
                return Err("single-instance main window is no longer valid".into());
            }
            let mut pid = 0;
            if GetWindowThreadProcessId(window, Some(&mut pid)) == 0 || pid != self.pid {
                return Err("single-instance main window does not belong to this process".into());
            }
            SetPropW(
                window,
                PCWSTR(self.property.as_ptr()),
                Some(process_marker()),
            )
            .map_err(|error| format!("single-instance SetPropW failed: {error}"))?;
        }
        state.window = Some(window.0 as isize);
        Ok(())
    }

    /// Retire this window before exit/restart while keeping the ownership mutex held.
    /// A failed removal keeps its HWND so both a retry and Guard::drop can retry cleanup.
    pub fn withdraw(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "single-instance window withdrawal state is poisoned".to_owned())?;
        self.withdraw_locked(&mut state)
    }

    fn withdraw_locked(&self, state: &mut WindowState) -> Result<(), String> {
        state.active = false;
        if let Some(raw_window) = state.window {
            let window = HWND(raw_window as *mut std::ffi::c_void);
            if matches_window(window, &self.property, self.pid) {
                unsafe { RemovePropW(window, PCWSTR(self.property.as_ptr())) }
                    .map_err(|error| format!("single-instance RemovePropW failed: {error}"))?;
            }
            // A destroyed/reused HWND or a missing/foreign property needs no removal.
            state.window = None;
        }
        Ok(())
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        {
            let mut state = self
                .marker
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Err(error) = self.marker.withdraw_locked(&mut state) {
                eprintln!("{error}");
            }
        }
        unsafe {
            if self.owned {
                if let Err(error) = ReleaseMutex(self.handle) {
                    eprintln!("single-instance ReleaseMutex failed: {error}");
                }
            }
            if let Err(error) = CloseHandle(self.handle) {
                eprintln!("single-instance CloseHandle failed: {error}");
            }
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn profile_key(app_home: &Path) -> Result<String, String> {
    // Creating the directory does not initialize configuration or touch shared data.
    std::fs::create_dir_all(app_home)
        .map_err(|error| format!("single-instance data-directory creation failed: {error}"))?;
    let resolved = dunce::canonicalize(app_home)
        .map_err(|error| format!("single-instance data-directory resolution failed: {error}"))?;
    let text = resolved
        .to_str()
        .ok_or_else(|| "single-instance data-directory path is not valid Unicode".to_owned())?;
    let mut hash = Sha256::new();
    for unit in text.to_lowercase().encode_utf16() {
        hash.update(unit.to_le_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn open_gate(key: &str) -> Result<Guard, String> {
    let name = wide(&format!("Global\\ccgui-profile-{key}"));
    // Read last-error immediately: CreateMutexW succeeds for both new and existing mutexes.
    let (handle, existed) = unsafe {
        SetLastError(ERROR_SUCCESS);
        let handle = CreateMutexW(None, true, PCWSTR(name.as_ptr()))
            .map_err(|error| format!("single-instance CreateMutexW failed: {error}"))?;
        (handle, GetLastError() == ERROR_ALREADY_EXISTS)
    };
    let mut guard = Guard {
        handle,
        owned: !existed,
        marker: WindowMarker {
            property: wide(&format!("ccgui-main-window-{key}")),
            pid: unsafe { GetCurrentProcessId() },
            state: Arc::new(Mutex::new(WindowState {
                active: true,
                window: None,
            })),
        },
        _thread_bound: PhantomData,
    };
    if existed {
        try_ownership(&mut guard)?;
    }
    Ok(guard)
}

fn try_ownership(guard: &mut Guard) -> Result<bool, String> {
    if guard.owned {
        return Ok(true);
    }
    match unsafe { WaitForSingleObject(guard.handle, 0) } {
        WAIT_OBJECT_0 | WAIT_ABANDONED => {
            guard.owned = true;
            Ok(true)
        }
        WAIT_TIMEOUT => Ok(false),
        WAIT_FAILED => Err(format!(
            "single-instance WaitForSingleObject failed: {}",
            windows::core::Error::from_win32()
        )),
        result => Err(format!(
            "single-instance WaitForSingleObject returned unexpected status {}",
            result.0
        )),
    }
}

/// Returns true on ownership transfer, false only after locating and activating the owner.
fn wait_for_owner(
    guard: &mut Guard,
    timeout: Duration,
    mut activate: impl FnMut(HWND, &[u16], u32, Duration) -> Result<(), String>,
) -> Result<bool, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if try_ownership(guard)? {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Err(
                "single-instance startup timed out after waiting for the existing main window"
                    .into(),
            );
        }
        if let Some(window) = find_window(&guard.marker.property)? {
            // The previous owner may have exited while EnumWindows was running.
            if try_ownership(guard)? {
                return Ok(true);
            }
            if let Some(pid) = published_window_pid(window, &guard.marker.property) {
                match activate(
                    window,
                    &guard.marker.property,
                    pid,
                    deadline.saturating_duration_since(Instant::now()),
                ) {
                    Ok(()) => {
                        if try_ownership(guard)? {
                            return Ok(true);
                        }
                        if matches_window(window, &guard.marker.property, pid) {
                            return Ok(false);
                        }
                        // The activated owner retired its window while preparing to exit.
                    }
                    Err(error) => {
                        if try_ownership(guard)? {
                            return Ok(true);
                        }
                        if matches_window(window, &guard.marker.property, pid) {
                            return Err(error);
                        }
                        // Withdrawn/destroyed windows are startup handoff, not focus errors.
                    }
                }
            }
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(
                "single-instance startup timed out after waiting for the existing main window"
                    .into(),
            );
        }
        thread::sleep(RETRY_INTERVAL.min(deadline - now));
    }
}

struct WindowSearch<'a> {
    property: &'a [u16],
    found: Option<HWND>,
}

unsafe extern "system" fn inspect_window(window: HWND, parameter: LPARAM) -> BOOL {
    let search = &mut *(parameter.0 as *mut WindowSearch<'_>);
    let marker = GetPropW(window, PCWSTR(search.property.as_ptr()));
    if !marker.is_invalid() {
        let mut pid = 0;
        if GetWindowThreadProcessId(window, Some(&mut pid)) != 0
            && marker.0 as usize == pid as usize
        {
            search.found = Some(window);
            return BOOL(0);
        }
    }
    BOOL(1)
}

fn find_window(property: &[u16]) -> Result<Option<HWND>, String> {
    let mut search = WindowSearch {
        property,
        found: None,
    };
    let result = unsafe {
        EnumWindows(
            Some(inspect_window),
            LPARAM(&mut search as *mut WindowSearch<'_> as isize),
        )
    };
    // Stopping enumeration because the callback found our marker is intentional.
    if search.found.is_none() {
        result.map_err(|error| format!("single-instance EnumWindows failed: {error}"))?;
    }
    Ok(search.found)
}

fn process_marker() -> HANDLE {
    HANDLE(unsafe { GetCurrentProcessId() } as usize as *mut std::ffi::c_void)
}

fn published_window_pid(window: HWND, property: &[u16]) -> Option<u32> {
    unsafe {
        let mut pid = 0;
        if IsWindow(Some(window)).as_bool()
            && GetWindowThreadProcessId(window, Some(&mut pid)) != 0
            && GetPropW(window, PCWSTR(property.as_ptr())).0 as usize == pid as usize
        {
            Some(pid)
        } else {
            None
        }
    }
}

fn matches_window(window: HWND, property: &[u16], pid: u32) -> bool {
    published_window_pid(window, property) == Some(pid)
}

fn activate_window(
    window: HWND,
    property: &[u16],
    pid: u32,
    remaining: Duration,
) -> Result<(), String> {
    activate_window_with_focus(
        window,
        property,
        pid,
        remaining,
        request_foreground,
        flash_attention,
    )
    .map(|_| ())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FocusOutcome {
    Focused,
    AttentionRequested,
}

fn request_foreground(window: HWND) -> bool {
    unsafe {
        let _ = SetForegroundWindow(window);
        let focused = GetForegroundWindow() == window;
        if !focused {
            eprintln!("single-instance foreground focus unavailable; requesting taskbar attention");
        }
        focused
    }
}

fn flash_attention(window: HWND) {
    let info = FLASHWINFO {
        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
        hwnd: window,
        dwFlags: FLASHW_TRAY,
        uCount: 3,
        dwTimeout: 0,
    };
    // The BOOL reports the previous active state, not whether this request succeeded.
    unsafe {
        let _ = FlashWindowEx(&info);
    }
}

fn focus_or_attention(
    window: HWND,
    request: impl FnOnce(HWND) -> bool,
    attention: impl FnOnce(HWND),
    still_published: impl FnOnce(HWND) -> bool,
) -> Result<FocusOutcome, String> {
    if request(window) {
        Ok(FocusOutcome::Focused)
    } else {
        if !still_published(window) {
            return Err(
                "single-instance main window was withdrawn before taskbar attention".into(),
            );
        }
        attention(window);
        Ok(FocusOutcome::AttentionRequested)
    }
}

fn activate_window_with_focus(
    window: HWND,
    property: &[u16],
    pid: u32,
    remaining: Duration,
    request: impl FnOnce(HWND) -> bool,
    attention: impl FnOnce(HWND),
) -> Result<FocusOutcome, String> {
    let restore_deadline = Instant::now() + remaining.min(RESTORE_TIMEOUT);
    unsafe {
        if !matches_window(window, property, pid) {
            return Err("single-instance main window was withdrawn before activation".into());
        }
        // SW_SHOW preserves maximized state; SW_RESTORE is only for minimized windows.
        let command = if IsIconic(window).as_bool() {
            SW_RESTORE
        } else {
            SW_SHOW
        };
        SetLastError(ERROR_SUCCESS);
        if !ShowWindowAsync(window, command).as_bool() {
            return Err(format!(
                "single-instance ShowWindowAsync failed (Win32 error {})",
                GetLastError().0
            ));
        }
        loop {
            if !matches_window(window, property, pid) {
                return Err("single-instance main window was withdrawn during restoration".into());
            }
            if IsWindowVisible(window).as_bool() && !IsIconic(window).as_bool() {
                break;
            }
            let now = Instant::now();
            if now >= restore_deadline {
                return Err("single-instance main window restoration timed out".into());
            }
            thread::sleep(Duration::from_millis(10).min(restore_deadline - now));
        }
        if !matches_window(window, property, pid) {
            return Err(
                "single-instance main window was withdrawn before foreground activation".into(),
            );
        }
        let outcome = focus_or_attention(window, request, attention, |window| {
            matches_window(window, property, pid)
        })?;
        if !matches_window(window, property, pid) {
            return Err(
                "single-instance main window was withdrawn after foreground activation".into(),
            );
        }
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        process::{Child, Command},
        time::{SystemTime, UNIX_EPOCH},
    };
    use windows::{
        core::w,
        Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, IsZoomed, PeekMessageW, ShowWindow,
            TranslateMessage, MSG, PM_REMOVE, SW_SHOWMAXIMIZED, SW_SHOWMINIMIZED, WINDOW_EX_STYLE,
            WS_OVERLAPPEDWINDOW,
        },
    };

    struct Profile(PathBuf);

    impl Profile {
        fn new() -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "ccgui-instance-test-{}-{suffix}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Profile {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct Fixture(Child);

    impl Fixture {
        fn start(profile: &Profile, mode: &str) -> Self {
            let child = Command::new(std::env::current_exe().unwrap())
                // The owner and contender intentionally have different working directories.
                .current_dir(std::env::temp_dir())
                .args([
                    "--ignored",
                    "--exact",
                    "single_instance::tests::process_fixture",
                    "--nocapture",
                ])
                .env("CCGUI_INSTANCE_TEST_HOME", &profile.0)
                .env("CCGUI_INSTANCE_TEST_MODE", mode)
                .spawn()
                .unwrap();
            let mut fixture = Self(child);
            let deadline = Instant::now() + Duration::from_secs(5);
            while !profile.0.join("owned").exists() {
                assert!(
                    fixture.0.try_wait().unwrap().is_none(),
                    "fixture exited before taking ownership"
                );
                assert!(Instant::now() < deadline, "fixture ownership timed out");
                thread::sleep(Duration::from_millis(10));
            }
            fixture
        }

        fn finish(&mut self, profile: &Profile) {
            fs::write(profile.0.join("release"), b"").unwrap();
            assert!(self.0.wait().unwrap().success());
        }

        fn wait_for_file(&mut self, profile: &Profile, name: &str) {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !profile.0.join(name).exists() {
                assert!(
                    self.0.try_wait().unwrap().is_none(),
                    "fixture exited before {name}"
                );
                assert!(Instant::now() < deadline, "fixture signal {name} timed out");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // This process was spawned exclusively by this test, never the user's GUI.
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }

    #[test]
    fn canonical_profile_aliases_share_a_key_and_distinct_profiles_do_not() {
        let a = Profile::new();
        let b = Profile::new();
        assert_eq!(
            profile_key(&a.0).unwrap(),
            profile_key(&a.0.join(".")).unwrap()
        );
        assert_eq!(
            profile_key(&a.0).unwrap(),
            profile_key(&PathBuf::from(a.0.to_str().unwrap().to_uppercase())).unwrap()
        );
        assert_ne!(profile_key(&a.0).unwrap(), profile_key(&b.0).unwrap());
    }

    #[cfg(feature = "test-harness")]
    #[test]
    fn development_profile_roots_have_shared_alias_locks_and_independent_root_locks() {
        let fixture = crate::test_harness::TestHarness::new().unwrap();
        let a = fixture.root().join("development-a");
        let b = fixture.root().join("development-b");
        fixture.use_profile(&a).unwrap();
        let Outcome::Primary(owner) = Gate::acquire(&crate::paths::app_home()).unwrap() else {
            panic!("fresh fixture profile must own its gate");
        };
        fixture.use_profile(&a.join(".")).unwrap();
        let alias_key = profile_key(&crate::paths::app_home()).unwrap();
        fixture.use_profile(&b).unwrap();
        let other_key = profile_key(&crate::paths::app_home()).unwrap();
        // Another thread tests the real mutex without invoking activation,
        // windows, listeners, application startup or any engine process.
        let result = thread::spawn(move || {
            let mut alias = open_gate(&alias_key).unwrap();
            let mut other = open_gate(&other_key).unwrap();
            (try_ownership(&mut alias).unwrap(), try_ownership(&mut other).unwrap())
        }).join().unwrap();
        assert_eq!(result, (false, true));
        drop(owner);
    }

    #[test]
    fn concurrent_owner_blocks_same_profile_but_allows_other_profiles() {
        let a = Profile::new();
        let b = Profile::new();
        let mut child = Fixture::start(&a, "normal");
        let mut contender = open_gate(&profile_key(&a.0).unwrap()).unwrap();
        assert!(!try_ownership(&mut contender).unwrap());
        assert!(matches!(Gate::acquire(&b.0).unwrap(), Outcome::Primary(_)));
        let error = wait_for_owner(&mut contender, Duration::from_millis(80), |_, _, _, _| {
            Ok(())
        })
        .unwrap_err();
        assert!(error.contains("timed out"));
        child.finish(&a);
        assert!(try_ownership(&mut contender).unwrap());
        drop(contender);
        assert!(matches!(Gate::acquire(&a.0).unwrap(), Outcome::Primary(_)));
    }

    #[test]
    fn simultaneous_mutex_creation_has_exactly_one_owner() {
        let profile = Profile::new();
        let key = profile_key(&profile.0).unwrap();
        let start = Arc::new(std::sync::Barrier::new(3));
        let acquired = Arc::new(std::sync::Barrier::new(3));
        let release = Arc::new(std::sync::Barrier::new(3));
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::scope(|scope| {
            for _ in 0..2 {
                let key = key.clone();
                let start = start.clone();
                let acquired = acquired.clone();
                let release = release.clone();
                let sender = sender.clone();
                scope.spawn(move || {
                    start.wait();
                    let guard = open_gate(&key).unwrap();
                    sender.send(guard.owned).unwrap();
                    acquired.wait();
                    release.wait();
                    drop(guard);
                });
            }
            start.wait();
            acquired.wait();
            let owners = receiver.iter().take(2).filter(|owned| *owned).count();
            // Always release the workers even if the assertion below fails.
            release.wait();
            assert_eq!(owners, 1);
        });
        assert!(matches!(
            Gate::acquire(&profile.0).unwrap(),
            Outcome::Primary(_)
        ));
    }

    #[test]
    fn mutex_creation_error_is_returned_without_allowing_a_primary() {
        // Backslash is forbidden within an object name after the Global namespace prefix.
        match open_gate("invalid\\nested") {
            Err(error) => assert!(error.contains("CreateMutexW failed")),
            Ok(_) => panic!("invalid mutex name must fail closed"),
        }
    }

    #[test]
    fn delayed_main_window_publication_is_discovered_without_taking_ownership() {
        let profile = Profile::new();
        let mut child = Fixture::start(&profile, "window");
        let mut contender = open_gate(&profile_key(&profile.0).unwrap()).unwrap();
        let started = Instant::now();
        let publish_path = profile.0.join("publish");
        let publisher = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            fs::write(publish_path, b"").unwrap();
        });
        assert!(
            !wait_for_owner(&mut contender, Duration::from_secs(3), |window, _, _, _| {
                assert!(unsafe { IsWindow(Some(window)).as_bool() });
                Ok(())
            })
            .unwrap()
        );
        publisher.join().unwrap();
        assert!(started.elapsed() >= Duration::from_millis(100));
        assert!(!contender.owned);
        child.finish(&profile);
    }

    #[test]
    fn owner_exit_during_window_wait_transfers_ownership() {
        for mode in ["normal", "crash"] {
            let profile = Profile::new();
            let mut child = Fixture::start(&profile, mode);
            let mut contender = open_gate(&profile_key(&profile.0).unwrap()).unwrap();
            let release_path = profile.0.join("release");
            let releaser = thread::spawn(move || {
                thread::sleep(Duration::from_millis(100));
                fs::write(release_path, b"").unwrap();
            });
            assert!(
                wait_for_owner(&mut contender, Duration::from_secs(3), |_, _, _, _| {
                    panic!("a window was never published")
                })
                .unwrap()
            );
            releaser.join().unwrap();
            assert!(child.0.wait().unwrap().success());
        }
    }

    #[test]
    fn abandoned_mutex_is_acquired_after_process_exits_without_drop() {
        let profile = Profile::new();
        let mut child = Fixture::start(&profile, "crash");
        let mut contender = open_gate(&profile_key(&profile.0).unwrap()).unwrap();
        assert!(!contender.owned);
        child.finish(&profile);
        // Our handle keeps the named mutex alive after the child exits.
        assert_eq!(
            unsafe { WaitForSingleObject(contender.handle, 0) },
            WAIT_ABANDONED
        );
        contender.owned = true;
    }

    #[test]
    fn window_property_is_removed_before_mutex_release() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<WindowMarker>();
        let profile = Profile::new();
        let guard = open_gate(&profile_key(&profile.0).unwrap()).unwrap();
        let property = guard.marker.property.clone();
        let window = test_window();
        let marker = guard.window_marker();
        marker.attach_window(window).unwrap();
        assert_eq!(find_window(&property).unwrap(), Some(window));
        drop(guard);
        assert_eq!(find_window(&property).unwrap(), None);
        assert!(marker
            .attach_window(window)
            .unwrap_err()
            .contains("live ownership guard"));
        unsafe {
            DestroyWindow(window).unwrap();
        }
    }

    #[test]
    fn failed_restoration_does_not_transfer_ownership_or_report_secondary_success() {
        let profile = Profile::new();
        let mut child = Fixture::start(&profile, "window");
        let mut contender = open_gate(&profile_key(&profile.0).unwrap()).unwrap();
        fs::write(profile.0.join("publish"), b"").unwrap();
        let error = wait_for_owner(&mut contender, Duration::from_secs(3), |_, _, _, _| {
            Err("restoration failed by test".to_owned())
        })
        .unwrap_err();
        assert_eq!(error, "restoration failed by test");
        assert!(!contender.owned);
        child.finish(&profile);
    }

    #[test]
    fn denied_focus_requests_attention_once_and_returns_secondary_with_owner_unchanged() {
        let profile = Profile::new();
        let mut child = Fixture::start(&profile, "window");
        let mut contender = open_gate(&profile_key(&profile.0).unwrap()).unwrap();
        fs::write(profile.0.join("publish"), b"").unwrap();
        let focus_requests = std::cell::Cell::new(0);
        let attention_requests = std::cell::Cell::new(0);
        assert!(!wait_for_owner(
            &mut contender,
            Duration::from_secs(3),
            |window, property, pid, remaining| {
                let outcome = activate_window_with_focus(
                    window,
                    property,
                    pid,
                    remaining,
                    |_| {
                        focus_requests.set(focus_requests.get() + 1);
                        false
                    },
                    |_| attention_requests.set(attention_requests.get() + 1),
                )?;
                assert_eq!(outcome, FocusOutcome::AttentionRequested);
                Ok(())
            }
        )
        .unwrap());
        assert_eq!(focus_requests.get(), 1);
        assert_eq!(attention_requests.get(), 1);
        assert!(!try_ownership(&mut contender).unwrap());
        let window = find_window(&contender.marker.property).unwrap().unwrap();
        assert!(unsafe { IsWindowVisible(window).as_bool() && !IsIconic(window).as_bool() });
        child.finish(&profile);
        assert!(try_ownership(&mut contender).unwrap());
    }

    #[test]
    fn owner_exit_inside_successful_activation_transfers_ownership() {
        let profile = Profile::new();
        let mut child = Fixture::start(&profile, "window");
        let mut contender = open_gate(&profile_key(&profile.0).unwrap()).unwrap();
        fs::write(profile.0.join("publish"), b"").unwrap();
        assert!(
            wait_for_owner(&mut contender, Duration::from_secs(3), |_, _, _, _| {
                // Reproduces exit after the pre-activation ownership check but before success.
                child.finish(&profile);
                Ok(())
            })
            .unwrap()
        );
        assert!(contender.owned);
    }

    #[test]
    fn withdrawn_live_window_is_not_activated_and_ownership_remains_until_exit() {
        let profile = Profile::new();
        let mut child = Fixture::start(&profile, "window");
        let mut contender = open_gate(&profile_key(&profile.0).unwrap()).unwrap();
        fs::write(profile.0.join("publish"), b"").unwrap();
        child.wait_for_file(&profile, "window-ready");
        let window = find_window(&contender.marker.property).unwrap().unwrap();
        fs::write(profile.0.join("withdraw"), b"").unwrap();
        child.wait_for_file(&profile, "withdrawn");
        assert!(unsafe { IsWindow(Some(window)).as_bool() });
        assert_eq!(find_window(&contender.marker.property).unwrap(), None);
        assert!(!try_ownership(&mut contender).unwrap());
        let error = wait_for_owner(&mut contender, Duration::from_millis(80), |_, _, _, _| {
            panic!("retired window must never be activated")
        })
        .unwrap_err();
        assert!(error.contains("timed out"));
        child.finish(&profile);
        assert!(
            wait_for_owner(&mut contender, Duration::from_secs(1), |_, _, _, _| {
                panic!("retired window must never be activated")
            })
            .unwrap()
        );
    }

    #[test]
    fn withdrawal_during_activation_waits_for_exit_instead_of_reporting_focus_error() {
        let profile = Profile::new();
        let mut child = Fixture::start(&profile, "window");
        let mut contender = open_gate(&profile_key(&profile.0).unwrap()).unwrap();
        fs::write(profile.0.join("publish"), b"").unwrap();
        let release_path = profile.0.join("release");
        let mut releaser = None;
        assert!(wait_for_owner(
            &mut contender,
            Duration::from_secs(3),
            |window, property, pid, remaining| {
                activate_window_with_focus(
                    window,
                    property,
                    pid,
                    remaining,
                    |_| {
                        fs::write(profile.0.join("withdraw"), b"").unwrap();
                        child.wait_for_file(&profile, "withdrawn");
                        let release_path = release_path.clone();
                        releaser = Some(thread::spawn(move || {
                            thread::sleep(Duration::from_millis(100));
                            fs::write(release_path, b"").unwrap();
                        }));
                        false
                    },
                    |_| panic!("retired window must not receive taskbar attention"),
                )
                .map(|_| ())
            }
        )
        .unwrap());
        releaser.unwrap().join().unwrap();
        assert!(child.0.wait().unwrap().success());
    }

    /// Uses real Win32 windows and a child message pump. Reports foreground focus
    /// or taskbar-attention fallback separately; restoration must succeed in both cases.
    #[test]
    fn real_activation_restores_minimized_and_preserves_maximized_windows() {
        for mode in ["ui-minimized", "ui-maximized"] {
            let profile = Profile::new();
            let mut child = Fixture::start(&profile, mode);
            child.wait_for_file(&profile, "window-ready");
            let mut contender = open_gate(&profile_key(&profile.0).unwrap()).unwrap();
            let window = find_window(&contender.marker.property).unwrap().unwrap();
            if mode == "ui-minimized" {
                assert!(unsafe { IsIconic(window).as_bool() });
            } else {
                assert!(unsafe { IsZoomed(window).as_bool() });
            }
            let mut focus_outcome = None;
            let secondary = wait_for_owner(
                &mut contender,
                Duration::from_secs(3),
                |window, property, pid, remaining| {
                    focus_outcome = Some(activate_window_with_focus(
                        window,
                        property,
                        pid,
                        remaining,
                        request_foreground,
                        flash_attention,
                    )?);
                    Ok(())
                },
            )
            .unwrap();
            assert!(unsafe { IsWindowVisible(window).as_bool() && !IsIconic(window).as_bool() });
            if mode == "ui-maximized" {
                assert!(unsafe { IsZoomed(window).as_bool() });
            }
            assert!(!secondary, "a live owner must keep ownership");
            eprintln!(
                "{mode}: display state verified; focus outcome: {:?}",
                focus_outcome.unwrap()
            );
            assert!(!contender.owned);
            child.finish(&profile);
        }
    }

    fn pump_messages() {
        unsafe {
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    fn test_window() -> HWND {
        unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("CCGUI isolated instance test"),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                100,
                100,
                None,
                None,
                None,
                None,
            )
            .unwrap()
        }
    }

    /// Spawned by the tests above. It only accesses their temporary profile directory.
    #[test]
    #[ignore]
    fn process_fixture() {
        let Some(home) = std::env::var_os("CCGUI_INSTANCE_TEST_HOME") else {
            return;
        };
        let home = PathBuf::from(home);
        let mode = std::env::var("CCGUI_INSTANCE_TEST_MODE").unwrap();
        let Outcome::Primary(guard) = Gate::acquire(&home).unwrap() else {
            panic!("fixture must be the first owner");
        };
        fs::write(home.join("owned"), b"").unwrap();
        let window = if mode == "window" || mode.starts_with("ui-") {
            if mode == "window" {
                let deadline = Instant::now() + Duration::from_secs(5);
                while !home.join("publish").exists() {
                    assert!(Instant::now() < deadline, "fixture publication timed out");
                    thread::sleep(Duration::from_millis(10));
                }
            }
            let window = test_window();
            guard.window_marker().attach_window(window).unwrap();
            if mode.starts_with("ui-") {
                unsafe {
                    let _ = ShowWindow(
                        window,
                        if mode == "ui-minimized" {
                            SW_SHOWMINIMIZED
                        } else {
                            SW_SHOWMAXIMIZED
                        },
                    );
                }
                pump_messages();
                fs::write(home.join("initial-window-state"), unsafe {
                    format!(
                        "visible={} iconic={} maximized={}",
                        IsWindowVisible(window).as_bool(),
                        IsIconic(window).as_bool(),
                        IsZoomed(window).as_bool()
                    )
                })
                .unwrap();
            }
            fs::write(home.join("window-ready"), b"").unwrap();
            Some(window)
        } else {
            None
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while !home.join("release").exists() {
            assert!(Instant::now() < deadline, "fixture release timed out");
            pump_messages();
            if home.join("withdraw").exists() && !home.join("withdrawn").exists() {
                let marker = guard.window_marker();
                marker.withdraw().unwrap();
                marker.withdraw().unwrap(); // Withdrawal must be idempotent.
                fs::write(home.join("withdrawn"), b"").unwrap();
            }
            thread::sleep(Duration::from_millis(10));
        }
        if mode == "crash" {
            std::process::exit(0); // Deliberately skips Guard::drop, producing WAIT_ABANDONED.
        }
        drop(guard);
        if let Some(window) = window {
            unsafe {
                DestroyWindow(window).unwrap();
            }
        }
    }
}
