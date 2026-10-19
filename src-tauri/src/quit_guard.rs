//! Quit guard for macOS.
//!
//! Cmd+Q, Dock → Quit, and `osascript -e 'tell application "CC GUI" to quit'`
//! all go through Cocoa's `-[NSApplication terminate:]`, which never reaches
//! Tauri's `RunEvent::ExitRequested` on this runtime: tao's app delegate does
//! not implement `applicationShouldTerminate:`, and the runtime only emits
//! that event for the last window's `Destroyed` or a programmatic exit.
//!
//! That matters because quitting is not free: the window `Destroyed` handler
//! sweeps the engine process registry, so every live run dies with the app.
//! A mispressed shortcut — or a coding CLI agent running `osascript … quit`
//! as part of its own dev loop — used to take the whole app down mid-turn
//! with no dialog, which reads exactly like a crash.
//!
//! [`install`] adds `applicationShouldTerminate:` to the live app delegate.
//! With at least one engine run in the registry it answers
//! `NSTerminateCancel` and emits [`EXIT_REQUESTED_EVENT`]; the frontend then
//! raises the same close-confirm dialog the window X uses, and only an
//! explicit confirm destroys the window (running the normal `Destroyed`
//! cleanup and letting the runtime exit). Quitting an idle app proceeds
//! untouched — no new ceremony.

/// Event the frontend listens on to raise the close-confirm dialog for a
/// cancelled system quit. Keep in lockstep with the literal in
/// `src/lib/close-confirm.ts` (pinned by `close-confirm.test.ts`).
#[cfg(target_os = "macos")]
pub const EXIT_REQUESTED_EVENT: &str = "app://exit-requested";

/// Install the guard on the running app. Idempotent; call once from `setup`
/// after the main window exists. No-op on non-macOS targets, where the only
/// quit path is the (already intercepted) window close.
#[cfg(target_os = "macos")]
pub fn install(app: &tauri::AppHandle) {
    macos::install(app);
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle) {}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_void};
    use std::sync::OnceLock;

    use tauri::{Emitter, Manager};

    use super::EXIT_REQUESTED_EVENT;
    use crate::AppState;

    /// `NSApplicationTerminateReply`.
    pub(super) const NS_TERMINATE_CANCEL: isize = 0;
    pub(super) const NS_TERMINATE_NOW: isize = 1;

    /// The one handle the delegate callback needs. `AppHandle` is Send + Sync
    /// and the callback always runs on the main thread.
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn object_getClass(object: *mut c_void) -> *mut c_void;
        fn class_replaceMethod(
            cls: *mut c_void,
            name: *mut c_void,
            imp: *const c_void,
            types: *const c_char,
        ) -> *mut c_void;
        /// Declared untyped so each call site can cast it to the selector's
        /// real signature before use.
        fn objc_msgSend();
    }

    /// `objc_msgSend` for two-argument (receiver + selector) methods that
    /// return an object: `+[NSApplication sharedApplication]` and
    /// `-[NSApplication delegate]`. Casting `objc_msgSend` per ABI signature
    /// is the documented way to call it from Rust (no variadic shim needed).
    type MsgSendObject0 = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;

    /// The decision behind the delegate method, split out so the branch is
    /// testable without an NSApplication.
    pub(super) fn should_terminate_reply(active_runs: usize) -> isize {
        if active_runs == 0 {
            NS_TERMINATE_NOW
        } else {
            NS_TERMINATE_CANCEL
        }
    }

    /// `applicationShouldTerminate:` added to tao's app delegate: cancel the
    /// quit while engine runs are live and ask the UI to confirm first.
    extern "C" fn application_should_terminate(
        _this: *mut c_void,
        _cmd: *mut c_void,
        _sender: *mut c_void,
    ) -> isize {
        let Some(app) = APP.get() else {
            return NS_TERMINATE_NOW;
        };
        let active = app
            .try_state::<AppState>()
            .map(|state| state.processes.active_run_count())
            .unwrap_or(0);
        let reply = should_terminate_reply(active);
        if reply == NS_TERMINATE_CANCEL {
            // An emit failure would leave a cancelled quit with no dialog:
            // still the better outcome — the alternative is silently killing
            // every live run. The frontend's close-confirm store is the only
            // listener.
            let _ = app.emit(EXIT_REQUESTED_EVENT, ());
        }
        reply
    }

    pub(super) fn install(app: &tauri::AppHandle) {
        // One delegate swap per process; a second call is a no-op.
        if APP.set(app.clone()).is_err() {
            return;
        }
        // SAFETY: plain ObjC runtime lookups on the main thread (tauri's
        // setup hook) plus one method install. The delegate's class is
        // tao's live `TaoAppDelegate`; `class_replaceMethod` copies its
        // arguments and returns an IMP we ignore. `types` is the encoding of
        // `-applicationShouldTerminate:` — q = NSInteger reply, @ = self,
        // : = _cmd, @ = sender. The IMP never unwinds (no panicking calls)
        // and stays valid for the process lifetime.
        unsafe {
            let class_name = c"NSApplication";
            let ns_application = objc_getClass(class_name.as_ptr());
            if ns_application.is_null() {
                eprintln!("[quit-guard] NSApplication class missing; system quits stay unguarded");
                return;
            }
            let msg_send: MsgSendObject0 = std::mem::transmute(objc_msgSend as *const ());
            let shared = msg_send(
                ns_application,
                sel_registerName(c"sharedApplication".as_ptr()),
            );
            if shared.is_null() {
                eprintln!(
                    "[quit-guard] sharedApplication unavailable; system quits stay unguarded"
                );
                return;
            }
            let delegate = msg_send(shared, sel_registerName(c"delegate".as_ptr()));
            if delegate.is_null() {
                eprintln!("[quit-guard] app delegate missing; system quits stay unguarded");
                return;
            }
            class_replaceMethod(
                object_getClass(delegate),
                sel_registerName(c"applicationShouldTerminate:".as_ptr()),
                application_should_terminate as *const () as *const c_void,
                c"q@:@".as_ptr(),
            );
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Idle quits stay untouched; any live run cancels the quit so the
        /// frontend can ask. (Regression: the guard must never let the
        /// window-close cleanup silently kill a running turn.)
        #[test]
        fn busy_quit_is_cancelled_idle_quit_allowed() {
            assert_eq!(should_terminate_reply(0), NS_TERMINATE_NOW);
            assert_eq!(should_terminate_reply(1), NS_TERMINATE_CANCEL);
            assert_eq!(should_terminate_reply(7), NS_TERMINATE_CANCEL);
        }
    }
}
