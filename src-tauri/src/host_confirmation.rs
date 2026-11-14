//! Trusted, transient host confirmation documents. No plugin content executes here.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::LazyLock, time::Duration};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::oneshot;

const PREFIX: &str = "host-confirmation-";
const MAX_CONTENT_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmationField {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmationSection {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub markdown: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmationContent {
    pub title: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub fields: Vec<ConfirmationField>,
    #[serde(default)]
    pub sections: Vec<ConfirmationSection>,
    pub confirm_label: String,
    pub dismiss_label: String,
    #[serde(default)]
    pub dark: bool,
    #[serde(default)]
    pub language: String,
}

impl ConfirmationContent {
    fn validate(&self) -> Result<(), String> {
        let label = |s: &str| !s.trim().is_empty() && s.len() <= 1024;
        if !label(&self.title)
            || !label(&self.confirm_label)
            || !label(&self.dismiss_label)
            || self.language.len() > 64
            || self.fields.len() > 64
            || self.sections.len() > 32
            || self.fields.iter().any(|f| !label(&f.label))
            || self.sections.iter().any(|s| !label(&s.title))
        {
            return Err("host_confirmation_invalid_content".into());
        }
        if serde_json::to_vec(self).map_err(|e| e.to_string())?.len() > MAX_CONTENT_BYTES {
            return Err("host_confirmation_content_too_large".into());
        }
        Ok(())
    }
}

struct Pending {
    parent: String,
    owner: Option<String>,
    content: ConfirmationContent,
    ready: bool,
    sender: oneshot::Sender<Result<bool, String>>,
}

#[derive(Default)]
struct Registry(HashMap<String, Pending>);
impl Registry {
    fn insert(&mut self, label: String, pending: Pending) -> Result<(), String> {
        if self.0.values().any(|p| p.parent == pending.parent) {
            return Err("host_confirmation_already_pending".into());
        }
        self.0.insert(label, pending);
        Ok(())
    }
    fn get(&self, label: &str) -> Result<&Pending, String> {
        self.0
            .get(label)
            .filter(|_| label.starts_with(PREFIX))
            .ok_or_else(|| "host_confirmation_caller_denied".into())
    }
    fn respond(&mut self, label: &str, accepted: bool, parent_exists: bool) -> Result<(), String> {
        let pending = self.get(label)?;
        if accepted && !pending.ready {
            return Err("host_confirmation_not_ready".into());
        }
        let pending = self.0.remove(label).unwrap();
        let _ = pending.sender.send(Ok(accepted && parent_exists));
        Ok(())
    }
    fn fail(&mut self, label: &str, error: &str) -> Result<(), String> {
        self.get(label)?;
        let pending = self.0.remove(label).unwrap();
        let _ = pending.sender.send(Err(error.into()));
        Ok(())
    }
    fn cancel(&mut self, label: &str) {
        if let Some(pending) = self.0.remove(label) {
            let _ = pending.sender.send(Ok(false));
        }
    }
    fn cancel_matching(&mut self, matches: impl Fn(&Pending) -> bool) -> Vec<String> {
        let labels: Vec<_> = self
            .0
            .iter()
            .filter(|(_, p)| matches(p))
            .map(|(label, _)| label.clone())
            .collect();
        for label in &labels {
            self.cancel(label);
        }
        labels
    }
}
static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

fn cancel(app: &AppHandle, label: &str) {
    REGISTRY.lock().cancel(label);
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
}

/// Call at parent CloseRequested/Destroyed and when its owner is retired.
pub fn cancel_parent(app: &AppHandle, parent_label: &str) {
    let labels = REGISTRY
        .lock()
        .cancel_matching(|pending| pending.parent == parent_label);
    for label in labels {
        cancel(app, &label);
    }
}

pub fn cancel_owner(app: &AppHandle, owner: &str) {
    let labels = REGISTRY
        .lock()
        .cancel_matching(|pending| pending.owner.as_deref() == Some(owner));
    for label in labels {
        cancel(app, &label);
    }
}

pub fn cancel_all(app: &AppHandle) {
    let labels = REGISTRY.lock().cancel_matching(|_| true);
    for label in labels {
        cancel(app, &label);
    }
}

struct Cleanup(AppHandle, String);
impl Drop for Cleanup {
    fn drop(&mut self) {
        cancel(&self.0, &self.1);
    }
}

pub async fn show(
    app: &AppHandle,
    parent: &WebviewWindow,
    content: ConfirmationContent,
) -> Result<bool, String> {
    show_inner(app, parent, content, None).await
}

pub async fn show_owned(
    app: &AppHandle,
    parent: &WebviewWindow,
    content: ConfirmationContent,
    owner: &str,
) -> Result<bool, String> {
    show_inner(app, parent, content, Some(owner.to_owned())).await
}

async fn show_inner(
    app: &AppHandle,
    parent: &WebviewWindow,
    content: ConfirmationContent,
    owner: Option<String>,
) -> Result<bool, String> {
    content.validate()?;
    if app.get_webview_window(parent.label()).is_none() {
        return Err("host_confirmation_parent_unavailable".into());
    }
    let label = format!("{PREFIX}{}", uuid::Uuid::new_v4());
    let (sender, mut receiver) = oneshot::channel();
    REGISTRY.lock().insert(
        label.clone(),
        Pending {
            parent: parent.label().into(),
            owner,
            content: content.clone(),
            ready: false,
            sender,
        },
    )?;
    let _cleanup = Cleanup(app.clone(), label.clone());
    let monitor = parent
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(parent.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("host_confirmation_monitor_unavailable")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = 760.0_f64.min((area.size.width as f64 / scale - 32.0).max(1.0));
    let height = 720.0_f64.min((area.size.height as f64 / scale - 64.0).max(1.0));
    let mut builder =
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("index.html".into()))
            .title(&content.title)
            .parent(parent)
            .map_err(|e| e.to_string())?
            .resizable(true)
            .visible(false)
            .focused(false)
            .inner_size(width, height);
    if let Some(directory) = crate::development_profile::webview_dir() {
        #[cfg(not(target_os = "macos"))]
        {
            builder = builder.data_directory(directory);
        }
        #[cfg(target_os = "macos")]
        {
            use sha2::{Digest, Sha256};
            let digest = Sha256::digest(directory.to_string_lossy().as_bytes());
            builder = builder.data_store_identifier(digest[..16].try_into().unwrap());
        }
    }
    let target = builder.build().map_err(|e| e.to_string())?;
    #[cfg(feature = "test-harness")]
    crate::test_harness::install_runtime_fixture_bridge(app, &target)?;
    let event_app = app.clone();
    let event_label = label.clone();
    target.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
        ) {
            // This callback belongs to the transient child, never the persistent parent.
            REGISTRY.lock().cancel(&event_label);
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(window) = event_app.get_webview_window(&event_label) {
                    let _ = window.hide();
                }
            }
        }
    });
    if app.get_webview_window(parent.label()).is_none() {
        return Ok(false);
    }
    let already_settled = REGISTRY.lock().get(&label).is_err();
    if already_settled {
        return receiver.await.unwrap_or(Ok(false));
    }
    let size = target.outer_size().map_err(|e| e.to_string())?;
    let origin = parent.outer_position().map_err(|e| e.to_string())?;
    let parent_size = parent.outer_size().map_err(|e| e.to_string())?;
    let x = (origin.x as i64 + (parent_size.width as i64 - size.width as i64) / 2).clamp(
        area.position.x as i64,
        area.position.x as i64 + area.size.width.saturating_sub(size.width) as i64,
    );
    let y = (origin.y as i64 + (parent_size.height as i64 - size.height as i64) / 2).clamp(
        area.position.y as i64,
        area.position.y as i64 + area.size.height.saturating_sub(size.height) as i64,
    );
    target
        .set_position(tauri::PhysicalPosition::new(x as i32, y as i32))
        .map_err(|e| e.to_string())?;
    // Only rendering has a deadline. A ready dialog may await the user indefinitely.
    tokio::select! {
        result = &mut receiver => result.unwrap_or(Ok(false)),
        _ = tokio::time::sleep(Duration::from_secs(15)) => {
            let expired = {
                let mut registry = REGISTRY.lock();
                if registry.0.get(&label).is_some_and(|pending| !pending.ready) {
                    let _ = registry.fail(&label, "host_confirmation_boot_timeout");
                    true
                } else { false }
            };
            if expired { cancel(app, &label); }
            receiver.await.unwrap_or(Ok(false))
        }
    }
}

#[tauri::command]
pub async fn host_confirmation_open(
    window: WebviewWindow,
    app: AppHandle,
    content: ConfirmationContent,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("host_confirmation_caller_denied".into());
    }
    show(&app, &window, content).await
}

#[tauri::command]
pub fn host_confirmation_read(window: WebviewWindow) -> Result<ConfirmationContent, String> {
    Ok(REGISTRY.lock().get(window.label())?.content.clone())
}

#[tauri::command]
pub fn host_confirmation_ready(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    {
        let mut registry = REGISTRY.lock();
        let parent = registry.get(window.label())?.parent.clone();
        if app.get_webview_window(&parent).is_none() {
            drop(registry);
            cancel(&app, window.label());
            return Err("host_confirmation_parent_unavailable".into());
        }
        registry.0.get_mut(window.label()).unwrap().ready = true;
    }
    if let Err(error) = window.show().and_then(|_| window.set_focus()) {
        let _ = REGISTRY
            .lock()
            .fail(window.label(), "host_confirmation_render_failed");
        cancel(&app, window.label());
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn host_confirmation_respond(
    window: WebviewWindow,
    app: AppHandle,
    accepted: bool,
    failed: Option<bool>,
) -> Result<(), String> {
    {
        let mut registry = REGISTRY.lock();
        let parent_exists = app
            .get_webview_window(&registry.get(window.label())?.parent)
            .is_some();
        if failed.unwrap_or(false) {
            if accepted {
                return Err("host_confirmation_invalid_response".into());
            }
            registry.fail(window.label(), "host_confirmation_render_failed")?;
        } else {
            registry.respond(window.label(), accepted, parent_exists)?;
        }
    }
    let _ = window.destroy();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn content() -> ConfirmationContent {
        serde_json::from_value(serde_json::json!({
            "title": "Review", "confirmLabel": "Confirm", "dismissLabel": "Cancel"
        }))
        .unwrap()
    }
    fn pending(parent: &str) -> (Pending, oneshot::Receiver<Result<bool, String>>) {
        let (sender, receiver) = oneshot::channel();
        (
            Pending {
                parent: parent.into(),
                owner: None,
                content: content(),
                ready: false,
                sender,
            },
            receiver,
        )
    }

    #[test]
    fn identity_readiness_and_single_use() {
        let mut registry = Registry::default();
        let label = format!("{PREFIX}test");
        let (entry, mut receiver) = pending("main");
        registry.insert(label.clone(), entry).unwrap();
        for forged in ["main", "plugin-window-test", "host-confirmation-forged"] {
            assert!(registry.get(forged).is_err());
            assert!(registry.respond(forged, true, true).is_err());
        }
        assert!(registry.respond(&label, true, true).is_err());
        assert!(matches!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        registry.0.get_mut(&label).unwrap().ready = true;
        registry.respond(&label, true, true).unwrap();
        assert_eq!(receiver.try_recv(), Ok(Ok(true)));
        assert!(registry.respond(&label, true, true).is_err());
        assert!(registry.get(&label).is_err());
    }

    #[test]
    fn duplicate_parent_rejected_and_cancellation_releases_slot() {
        let mut registry = Registry::default();
        let label = format!("{PREFIX}first");
        let (entry, mut receiver) = pending("parent");
        registry.insert(label.clone(), entry).unwrap();
        assert!(registry
            .insert(format!("{PREFIX}second"), pending("parent").0)
            .is_err());
        registry.cancel(&label);
        assert_eq!(receiver.try_recv(), Ok(Ok(false)));
        registry.cancel(&label);
        registry
            .insert(format!("{PREFIX}third"), pending("parent").0)
            .unwrap();
    }

    #[test]
    fn parent_and_owner_cancellation_only_consume_matching_requests() {
        let mut registry = Registry::default();
        let (mut a, mut a_rx) = pending("main");
        a.owner = Some("plugin-a".into());
        let (mut b, mut b_rx) = pending("floating-b");
        b.owner = Some("plugin-a".into());
        let (c, mut c_rx) = pending("floating-c");
        registry.insert(format!("{PREFIX}a"), a).unwrap();
        registry.insert(format!("{PREFIX}b"), b).unwrap();
        registry.insert(format!("{PREFIX}c"), c).unwrap();
        assert_eq!(
            registry.cancel_matching(|p| p.parent == "floating-b"),
            vec![format!("{PREFIX}b")]
        );
        assert_eq!(b_rx.try_recv(), Ok(Ok(false)));
        assert!(matches!(
            a_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert_eq!(
            registry.cancel_matching(|p| p.owner.as_deref() == Some("plugin-a")),
            vec![format!("{PREFIX}a")]
        );
        assert_eq!(a_rx.try_recv(), Ok(Ok(false)));
        assert!(matches!(
            c_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        registry.cancel_matching(|_| true);
        assert_eq!(c_rx.try_recv(), Ok(Ok(false)));
    }

    #[test]
    fn close_before_ready_and_missing_parent_never_accept() {
        for (ready, accepted) in [(false, false), (true, true)] {
            let mut registry = Registry::default();
            let (mut entry, mut receiver) = pending("parent");
            entry.ready = ready;
            registry.insert(format!("{PREFIX}test"), entry).unwrap();
            registry
                .respond(&format!("{PREFIX}test"), accepted, false)
                .unwrap();
            assert_eq!(receiver.try_recv(), Ok(Ok(false)));
        }
    }

    #[test]
    fn preparation_failure_is_not_user_dismissal() {
        for error in [
            "host_confirmation_boot_timeout",
            "host_confirmation_render_failed",
        ] {
            let mut registry = Registry::default();
            let (entry, mut receiver) = pending("main");
            let label = format!("{PREFIX}failure");
            registry.insert(label.clone(), entry).unwrap();
            assert!(registry.fail("main", error).is_err());
            registry.fail(&label, error).unwrap();
            assert_eq!(receiver.try_recv(), Ok(Err(error.into())));
            assert!(registry.respond(&label, true, true).is_err());
        }
    }

    #[test]
    fn content_bounds_are_rejected_without_truncation() {
        let mut value = content();
        value.message = "正文🙂".repeat(8_000);
        value.validate().unwrap();
        assert_eq!(value.message, "正文🙂".repeat(8_000));
        value.message = "x".repeat(MAX_CONTENT_BYTES);
        assert!(value.validate().is_err());
        value.message.clear();
        value.fields = vec![
            ConfirmationField {
                label: "Label".into(),
                value: "Value".into()
            };
            65
        ];
        assert!(value.validate().is_err());
        value.fields.clear();
        value.confirm_label = " ".into();
        assert!(value.validate().is_err());
        assert!(
            serde_json::from_value::<ConfirmationContent>(serde_json::json!({
                "title":"Test", "confirmLabel":"Yes", "dismissLabel":"No", "script":"bad"
            }))
            .is_err()
        );
    }
}
