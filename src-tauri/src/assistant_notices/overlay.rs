//! CCGUI-owned presentation window. Only explicit notice actions focus the main window.
use super::config::DisplayTarget;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, OnceLock,
};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

pub const LABEL: &str = "assistant-notices";
const WIDTH: f64 = 360.0;
const MAX_HEIGHT: f64 = 680.0;
#[derive(Clone, Copy, Serialize, Deserialize)]
struct Position {
    x: i32,
    y: i32,
}
struct State {
    stopped: AtomicBool,
    visible: AtomicBool,
    dragging: AtomicBool,
    captured: AtomicBool,
    window_epoch: AtomicU64,
    tracker_queued: AtomicBool,
    position_dirty: AtomicBool,
    pending_height: Mutex<Option<f64>>,
    position: Mutex<Option<Position>>,
    display_target: Mutex<DisplayTarget>,
    selected_monitor: Mutex<Option<String>>,
    tracker: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    gate: Mutex<()>,
}
static STATE: OnceLock<Arc<State>> = OnceLock::new();
fn state() -> &'static Arc<State> {
    STATE.get_or_init(|| {
        Arc::new(State {
            stopped: AtomicBool::new(false),
            visible: AtomicBool::new(false),
            dragging: AtomicBool::new(false),
            captured: AtomicBool::new(false),
            window_epoch: AtomicU64::new(0),
            tracker_queued: AtomicBool::new(false),
            position_dirty: AtomicBool::new(false),
            pending_height: Mutex::new(None),
            position: Mutex::new(None),
            display_target: Mutex::new(DisplayTarget::Active),
            selected_monitor: Mutex::new(None),
            tracker: Mutex::new(None),
            gate: Mutex::new(()),
        })
    })
}
fn position_path() -> std::path::PathBuf {
    crate::paths::app_home().join("assistant-notices-window.json")
}
fn load_position() -> Option<Position> {
    let bytes = std::fs::read(position_path()).ok()?;
    if bytes.len() > 256 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}
fn save_position(position: Position) {
    if let Ok(value) = serde_json::to_string(&position) {
        let _ = crate::settings::atomic_write(&position_path(), &value);
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisplayInfo {
    pub id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}
fn monitor_id(monitor: &tauri::Monitor) -> String {
    monitor
        .name()
        .cloned()
        .unwrap_or_else(|| format!("display:{},{}", monitor.position().x, monitor.position().y))
}
fn monitor_geometry(monitor: &tauri::Monitor) -> String {
    format!(
        "{}:{},{}:{}x{}:{}",
        monitor_id(monitor),
        monitor.position().x,
        monitor.position().y,
        monitor.size().width,
        monitor.size().height,
        monitor.scale_factor()
    )
}
pub(super) fn monitors(app: &AppHandle) -> Result<Vec<DisplayInfo>, String> {
    let primary = app
        .primary_monitor()
        .map_err(|_| "window_unavailable")?
        .map(|m| monitor_id(&m));
    Ok(app
        .available_monitors()
        .map_err(|_| "window_unavailable")?
        .iter()
        .map(|monitor| {
            let id = monitor_id(monitor);
            DisplayInfo {
                primary: primary.as_ref() == Some(&id),
                label: id.clone(),
                id,
                width: monitor.size().width,
                height: monitor.size().height,
            }
        })
        .collect())
}
pub(super) fn configure(app: &AppHandle, target: &DisplayTarget) -> Result<(), String> {
    *state().display_target.lock() = match target {
        DisplayTarget::Active => DisplayTarget::Active,
        DisplayTarget::Fixed { id, label } => DisplayTarget::Fixed {
            id: id.clone(),
            label: label.clone(),
        },
    };
    // Configuration must never create a window or change focus/visibility.
    if !state().stopped.load(Ordering::SeqCst) && !state().dragging.load(Ordering::SeqCst) {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _gate = state().gate.lock();
            let preferred = *state().position.lock();
            fit_position(app, &window, preferred)?;
        }
    }
    Ok(())
}
#[cfg(windows)]
fn foreground_monitor_origin() -> Option<(i32, i32)> {
    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    struct Info {
        size: u32,
        monitor: Rect,
        work: Rect,
        flags: u32,
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetForegroundWindow() -> *mut std::ffi::c_void;
        fn MonitorFromWindow(window: *mut std::ffi::c_void, flags: u32) -> *mut std::ffi::c_void;
        fn GetMonitorInfoW(monitor: *mut std::ffi::c_void, info: *mut Info) -> i32;
    }
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        let monitor = MonitorFromWindow(window, 2);
        let mut info = Info {
            size: std::mem::size_of::<Info>() as u32,
            monitor: Rect::default(),
            work: Rect::default(),
            flags: 0,
        };
        if monitor.is_null() || GetMonitorInfoW(monitor, &mut info) == 0 {
            None
        } else {
            Some((info.monitor.left, info.monitor.top))
        }
    }
}
#[cfg(not(windows))]
fn foreground_monitor_origin() -> Option<(i32, i32)> {
    None
}

fn choose_monitor(
    ids: &[String],
    fixed: Option<&str>,
    active: Option<usize>,
    primary: Option<usize>,
) -> Option<usize> {
    fixed
        .and_then(|id| ids.iter().position(|candidate| candidate == id))
        .or(active.filter(|index| *index < ids.len()))
        .or(primary.filter(|index| *index < ids.len()))
        .or_else(|| (!ids.is_empty()).then_some(0))
}
fn monitor(app: &AppHandle, _window: Option<&WebviewWindow>) -> Option<tauri::Monitor> {
    let monitors = app.available_monitors().ok()?;
    let ids = monitors.iter().map(monitor_id).collect::<Vec<_>>();
    let origin = foreground_monitor_origin().or_else(|| {
        app.get_webview_window("main")
            .and_then(|window| window.current_monitor().ok().flatten())
            .map(|m| (m.position().x, m.position().y))
    });
    let active = origin.and_then(|(x, y)| {
        monitors
            .iter()
            .position(|m| m.position().x == x && m.position().y == y)
    });
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|m| ids.iter().position(|id| *id == monitor_id(&m)));
    let target = state().display_target.lock();
    let fixed = match &*target {
        DisplayTarget::Active => None,
        DisplayTarget::Fixed { id, .. } => Some(id.as_str()),
    };
    choose_monitor(&ids, fixed, active, primary).map(|index| monitors[index].clone())
}
fn clamp_axis(value: f64, origin: f64, extent: f64, size: f64, margin: f64) -> f64 {
    let low = origin + margin;
    let high = (origin + extent - size - margin).max(low);
    value.clamp(low, high)
}
fn fit_position(
    app: &AppHandle,
    window: &WebviewWindow,
    preferred: Option<Position>,
) -> Result<(), String> {
    // Cached drag coordinates never choose the display. They are preserved on
    // the selected display and clamped when its bounds change.
    let chosen = monitor(app, Some(window)).ok_or("window_unavailable")?;
    let dpi = chosen.scale_factor();
    let origin = chosen.position();
    let available = chosen.size();
    let size = window.outer_size().map_err(|_| "window_unavailable")?;
    let margin = 16.0 * dpi;
    // Reserve space for the desktop taskbar without covering its controls.
    let bottom = 56.0 * dpi;
    let preferred = preferred.unwrap_or(Position {
        x: (origin.x as f64 + available.width as f64 - size.width as f64 - margin) as i32,
        y: (origin.y as f64 + available.height as f64 - size.height as f64 - bottom) as i32,
    });
    let x = clamp_axis(
        preferred.x as f64,
        origin.x as f64,
        available.width as f64,
        size.width as f64,
        margin,
    );
    let y = clamp_axis(
        preferred.y as f64,
        origin.y as f64,
        (available.height as f64 - bottom).max(1.0),
        size.height as f64,
        margin,
    );
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|_| "window_unavailable")?;
    *state().selected_monitor.lock() = Some(monitor_geometry(&chosen));
    Ok(())
}
fn create(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    let epoch = state().window_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    state().visible.store(false, Ordering::SeqCst);
    state().captured.store(false, Ordering::SeqCst);
    state().dragging.store(false, Ordering::SeqCst);
    *state().pending_height.lock() = None;
    // Snapshot before calling native getters: those may wait on the UI thread,
    // whose window-event callbacks also need the position lock.
    let cached_position = *state().position.lock();
    let preferred = cached_position.or_else(load_position);
    *state().position.lock() = preferred;
    let builder =
        tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("index.html".into()));
    #[cfg(feature = "test-harness")]
    let builder = if let Some(paths) = app.try_state::<super::native_fixture::FixturePaths>() {
        builder.data_directory(paths.overlay_data.clone())
    } else {
        builder
    };
    let window = builder
        .initialization_script("window.location.hash = '#/assistant-notices';")
        .title("CC GUI")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .inner_size(WIDTH, 320.0)
        .build()
        .map_err(|_| "window_unavailable")?;
    if state().stopped.load(Ordering::SeqCst) {
        let _ = window.destroy();
        return Err("window_unavailable".into());
    }
    if window.set_ignore_cursor_events(true).is_err()
        || fit_position(app, &window, preferred).is_err()
    {
        let _ = window.destroy();
        return Err("window_unavailable".into());
    }
    let position_window = window.clone();
    window.on_window_event(move |event| {
        if state().window_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        if matches!(event, tauri::WindowEvent::Destroyed) {
            state().visible.store(false, Ordering::SeqCst);
            state().captured.store(false, Ordering::SeqCst);
            state().dragging.store(false, Ordering::SeqCst);
            return;
        }
        if let tauri::WindowEvent::Moved(position) = event {
            if state().dragging.load(Ordering::SeqCst) {
                *state().position.lock() = Some(Position {
                    x: position.x,
                    y: position.y,
                });
            }
        }
        if let tauri::WindowEvent::ScaleFactorChanged { .. } = event {
            if !state().dragging.load(Ordering::SeqCst) {
                let preferred = *state().position.lock();
                let _ = fit_position(position_window.app_handle(), &position_window, preferred);
            }
        }
    });
    start_tracker(app);
    Ok(window)
}

fn show_without_focus(window: &WebviewWindow) -> Result<(), String> {
    let epoch = state().window_epoch.load(Ordering::SeqCst);
    let owned = window.clone();
    // Serialize the final presentation with main-window shutdown on the UI
    // thread. Shutdown must never wait for our gate while creation waits on UI.
    window
        .run_on_main_thread(move || {
            if state().window_epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            if state().stopped.load(Ordering::SeqCst) {
                let _ = owned.destroy();
                return;
            }
            if !state().visible.load(Ordering::SeqCst) {
                return;
            }
            // Keep Tao's visibility flags in sync. Calling Win32 ShowWindow
            // directly leaves VISIBLE false, so the next cursor/style update
            // hides the window again. The builder's focused(false) makes Tao's
            // Windows show path use SW_SHOWNOACTIVATE.
            if owned.show().is_err() {
                state().visible.store(false, Ordering::SeqCst);
            }
        })
        .map_err(|_| "window_unavailable".into())
}

pub fn show(app: &AppHandle, visible: bool) -> Result<(), String> {
    let _gate = state().gate.lock();
    if state().stopped.load(Ordering::SeqCst) {
        return Err("window_unavailable".into());
    }
    if !visible {
        state().visible.store(false, Ordering::SeqCst);
        state().captured.store(false, Ordering::SeqCst);
        if let Some(window) = app.get_webview_window(LABEL) {
            window
                .set_ignore_cursor_events(true)
                .map_err(|_| "window_unavailable")?;
            window.hide().map_err(|_| "window_unavailable")?;
        }
        return Ok(());
    }
    let window = create(app)?;
    if state().stopped.load(Ordering::SeqCst) {
        let _ = window.destroy();
        return Err("window_unavailable".into());
    }
    if !state().visible.swap(true, Ordering::SeqCst) {
        if let Err(error) = show_without_focus(&window) {
            state().visible.store(false, Ordering::SeqCst);
            return Err(error);
        }
    }
    Ok(())
}
pub fn resize(app: &AppHandle, height: f64) -> Result<(), String> {
    if !height.is_finite() || !(1.0..=8192.0).contains(&height) {
        return Err("invalid_size".into());
    }
    if state().dragging.load(Ordering::SeqCst) {
        *state().pending_height.lock() = Some(height);
        return Ok(());
    }
    let _gate = state().gate.lock();
    let window = app.get_webview_window(LABEL).ok_or("window_unavailable")?;
    let monitor = monitor(app, Some(&window)).ok_or("window_unavailable")?;
    let available = monitor.size();
    let dpi = monitor.scale_factor();
    let desired = LogicalSize::new(
        WIDTH.min((available.width as f64 / dpi - 32.0).max(200.0)),
        height.clamp(
            40.0,
            MAX_HEIGHT.min((available.height as f64 / dpi - 96.0).max(40.0)),
        ),
    );
    let current = window
        .inner_size()
        .map_err(|_| "window_unavailable")?
        .to_logical::<f64>(window.scale_factor().map_err(|_| "window_unavailable")?);
    if (current.width - desired.width).abs() < 1.0 && (current.height - desired.height).abs() < 1.0
    {
        return Ok(());
    }
    window.set_size(desired).map_err(|_| "window_unavailable")?;
    if !state().dragging.load(Ordering::SeqCst) {
        let preferred = *state().position.lock();
        fit_position(app, &window, preferred)?;
    }
    Ok(())
}
pub fn interactive(app: &AppHandle, interactive: bool) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("window_unavailable")?;
    // The native tracker can discover mouse entry while the webview is still
    // click-through; frontend exit is only a hint and cannot steal focus.
    if !interactive {
        window
            .set_ignore_cursor_events(true)
            .map_err(|_| "window_unavailable")?;
        state().captured.store(false, Ordering::SeqCst);
    }
    Ok(())
}
pub fn drag(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("window_unavailable")?;
    state().dragging.store(true, Ordering::SeqCst);
    let result = window
        .start_dragging()
        .map_err(|_| "window_unavailable".into());
    if result.is_err() {
        state().dragging.store(false, Ordering::SeqCst);
    }
    #[cfg(not(windows))]
    state().dragging.store(false, Ordering::SeqCst);
    result
}
pub fn dragging() -> bool {
    state().dragging.load(Ordering::SeqCst)
}
pub fn main_focused(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    // WebView2's child HWND receives keyboard focus, so Tao's parent-window
    // is_focused flag can be false while the chat document is foreground.
    // Frontend acknowledgement additionally requires document.hasFocus().
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        window
            .hwnd()
            .is_ok_and(|handle| unsafe { GetForegroundWindow().0 == handle.0 as _ })
    }
    #[cfg(not(windows))]
    window.is_focused().unwrap_or(false)
}
pub fn focus_main(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("window_unavailable")?;
    window.unminimize().map_err(|_| "window_unavailable")?;
    window.show().map_err(|_| "window_unavailable")?;
    window.set_focus().map_err(|_| "window_unavailable")?;
    // Focusing the top-level HWND does not necessarily focus its child webview.
    window
        .as_ref()
        .set_focus()
        .map_err(|_| "window_unavailable".into())
}
pub fn shutdown(app: &AppHandle) {
    state().stopped.store(true, Ordering::SeqCst);
    state().visible.store(false, Ordering::SeqCst);
    state().captured.store(false, Ordering::SeqCst);
    state().dragging.store(false, Ordering::SeqCst);
    if let Some(handle) = state().tracker.lock().take() {
        handle.abort();
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}

#[cfg(windows)]
fn cursor() -> Option<(i32, i32, bool)> {
    use windows::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAsyncKeyState(vkey: i32) -> i16;
    }
    let mut point = POINT::default();
    unsafe {
        GetCursorPos(&mut point).ok()?;
        Some((point.x, point.y, GetAsyncKeyState(1) < 0))
    }
}
#[cfg(not(windows))]
fn cursor() -> Option<(i32, i32, bool)> {
    None
}

fn start_tracker(app: &AppHandle) {
    let mut tracker = state().tracker.lock();
    if tracker.is_some() {
        return;
    }
    let app = app.clone();
    *tracker = Some(tauri::async_runtime::spawn(async move {
        let mut last_display_check = std::time::Instant::now();
        while !state().stopped.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(
                if state().visible.load(Ordering::SeqCst) {
                    32
                } else {
                    500
                },
            ))
            .await;
            // Disk I/O and resize's gate remain off the UI thread. A later drag
            // sets dirty again, so this one writer persists positions in order.
            if state().position_dirty.swap(false, Ordering::SeqCst) {
                let preferred = *state().position.lock();
                if let Some(position) = preferred {
                    save_position(position);
                }
            }
            if !state().dragging.load(Ordering::SeqCst) {
                let pending = state().pending_height.lock().take();
                if let Some(height) = pending {
                    let _ = resize(&app, height);
                }
                if last_display_check.elapsed() >= std::time::Duration::from_millis(500) {
                    last_display_check = std::time::Instant::now();
                    if let Some(window) = app.get_webview_window(LABEL) {
                        if let Some(chosen) = monitor(&app, Some(&window)) {
                            let changed = state().selected_monitor.lock().as_ref()
                                != Some(&monitor_geometry(&chosen));
                            if changed {
                                let _gate = state().gate.lock();
                                let preferred = *state().position.lock();
                                let _ = fit_position(&app, &window, preferred);
                            }
                        }
                    }
                }
            }
            let epoch = state().window_epoch.load(Ordering::SeqCst);
            let Some(window) = app.get_webview_window(LABEL) else {
                continue;
            };
            if state().tracker_queued.swap(true, Ordering::SeqCst) {
                continue;
            }
            // Both the epoch check and native hit-testing execute on UI. An
            // old window's queued setter must not mark its replacement captured.
            if app
                .run_on_main_thread(move || {
                    state().tracker_queued.store(false, Ordering::SeqCst);
                    if state().stopped.load(Ordering::SeqCst)
                        || state().window_epoch.load(Ordering::SeqCst) != epoch
                    {
                        return;
                    }
                    if !state().visible.load(Ordering::SeqCst) {
                        state().captured.store(false, Ordering::SeqCst);
                        return;
                    }
                    let Some((x, y, pressed)) = cursor() else {
                        #[cfg(not(windows))]
                        {
                            let _ = window.set_ignore_cursor_events(false);
                        }
                        return;
                    };
                    if state().dragging.load(Ordering::SeqCst) && !pressed {
                        state().dragging.store(false, Ordering::SeqCst);
                        if let Ok(position) = window.outer_position() {
                            *state().position.lock() = Some(Position {
                                x: position.x,
                                y: position.y,
                            });
                            state().position_dirty.store(true, Ordering::SeqCst);
                        }
                    }
                    let (Ok(position), Ok(size), Ok(dpi)) = (
                        window.outer_position(),
                        window.outer_size(),
                        window.scale_factor(),
                    ) else {
                        return;
                    };
                    let inset = 6.0 * dpi;
                    let inside = state().dragging.load(Ordering::SeqCst)
                        || (x as f64 >= position.x as f64 + inset
                            && y as f64 >= position.y as f64 + inset
                            && (x as f64) < position.x as f64 + size.width as f64 - inset
                            && (y as f64) < position.y as f64 + size.height as f64 - inset);
                    if inside != state().captured.load(Ordering::SeqCst)
                        && window.set_ignore_cursor_events(!inside).is_ok()
                    {
                        state().captured.store(inside, Ordering::SeqCst);
                    }
                })
                .is_err()
            {
                state().tracker_queued.store(false, Ordering::SeqCst);
            }
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn placement_clamps_cross_screen_and_oversized_content() {
        assert_eq!(clamp_axis(-3000.0, -1920.0, 1920.0, 360.0, 16.0), -1904.0);
        assert_eq!(clamp_axis(9999.0, 0.0, 1920.0, 360.0, 16.0), 1544.0);
        assert_eq!(clamp_axis(200.0, 0.0, 100.0, 360.0, 16.0), 16.0);
    }
    #[test]
    fn display_selection_follows_foreground_and_restores_fixed_after_reconnect() {
        let ids = vec!["display-a".into(), "display-b".into()];
        assert_eq!(choose_monitor(&ids, None, Some(1), Some(0)), Some(1));
        assert_eq!(
            choose_monitor(&ids, Some("display-a"), Some(1), Some(0)),
            Some(0)
        );
        let disconnected = vec!["display-b".into()];
        assert_eq!(
            choose_monitor(&disconnected, Some("display-a"), Some(0), Some(0)),
            Some(0)
        );
        assert_eq!(
            choose_monitor(&ids, Some("display-a"), Some(1), Some(1)),
            Some(0)
        );
        assert_eq!(choose_monitor(&ids, None, None, Some(1)), Some(1));
        assert_eq!(choose_monitor(&ids, None, Some(99), None), Some(0));
        assert_eq!(choose_monitor(&[], None, Some(0), Some(0)), None);
        // A dragged position remains unchanged within the target's bounds.
        assert_eq!(clamp_axis(300.0, 0.0, 1920.0, 360.0, 16.0), 300.0);
    }
}
