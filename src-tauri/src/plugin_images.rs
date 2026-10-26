use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, WebviewWindow};

pub const MAX_PLUGIN_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PLUGIN_IMAGE_BASE64_BYTES: usize = ((MAX_PLUGIN_IMAGE_BYTES + 2) / 3) * 4;
const MAX_PLUGIN_IMAGE_META_BYTES: usize = 16 * 1024;
pub const MAX_PLUGIN_IMAGE_BATCH: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginImageAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginImagePreview {
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredImageMeta {
    plugin_id: String,
    id: String,
    name: String,
    mime_type: String,
    file_name: String,
    size: usize,
}

fn is_valid_plugin_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (2..=64).contains(&bytes.len())
        && bytes[0] != b'-'
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn is_valid_image_id(id: &str) -> bool {
    id.len() == 36
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && uuid::Uuid::parse_str(id).is_ok()
}

fn check_not_symlink_or_reparse(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("plugin_image_stat_failed: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err("plugin_image_symlink_forbidden".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Err("plugin_image_symlink_forbidden".into());
        }
    }
    Ok(())
}

fn ensure_safe_directory(path: &Path) -> Result<(), String> {
    if path.exists() {
        check_not_symlink_or_reparse(path)?;
        let meta = fs::symlink_metadata(path).map_err(|e| format!("plugin_image_dir: {e}"))?;
        if !meta.is_dir() {
            return Err("plugin_image_invalid_storage_dir".into());
        }
        return Ok(());
    }
    fs::create_dir_all(path).map_err(|e| format!("plugin_image_mkdir_failed: {e}"))?;
    check_not_symlink_or_reparse(path)
}

fn require_image_plugin_in(app_home: &Path, plugin_id: &str) -> Result<(), String> {
    if !is_valid_plugin_id(plugin_id) {
        return Err("plugin_image_invalid_plugin_id".into());
    }
    crate::plugins::require_supported_plugin(plugin_id)?;
    let state_bytes = fs::read(app_home.join("plugins.json"))
        .map_err(|e| format!("plugin_image_state_unavailable: {e}"))?;
    let state: crate::plugins::PluginsState = serde_json::from_slice(&state_bytes)
        .map_err(|e| format!("plugin_image_state_invalid: {e}"))?;
    let record = state
        .plugins
        .get(plugin_id)
        .ok_or_else(|| "plugin_image_plugin_not_installed".to_owned())?;
    if !record.enabled || record.quarantined {
        return Err("plugin_image_plugin_disabled".into());
    }
    let plugin_dir = app_home.join("plugins").join(plugin_id);
    check_not_symlink_or_reparse(&plugin_dir)?;
    let manifest_path = plugin_dir.join("manifest.json");
    check_not_symlink_or_reparse(&manifest_path)?;
    let manifest_raw = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("plugin_image_manifest_unavailable: {e}"))?;
    let manifest: Value = serde_json::from_str(&manifest_raw)
        .map_err(|_| "plugin_image_invalid_manifest".to_owned())?;
    if manifest.get("id").and_then(Value::as_str) != Some(plugin_id) {
        return Err("plugin_image_manifest_mismatch".into());
    }
    let manifest_perms = manifest
        .get("permissions")
        .and_then(Value::as_array)
        .ok_or_else(|| "plugin_image_permission_denied".to_owned())?;
    let allowed = ["host:chat", "host:tasks"].into_iter().any(|perm| {
        record.permissions.iter().any(|p| p == perm)
            && manifest_perms.iter().any(|v| v.as_str() == Some(perm))
    });
    if !allowed {
        return Err("plugin_image_permission_denied".into());
    }
    Ok(())
}

fn sniff_allowed_raster(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(("image/jpeg", "jpg"))
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "gif"))
    } else {
        None
    }
}

fn ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn normalize_requested_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/webp" => Some("image/webp"),
        "image/gif" => Some("image/gif"),
        _ => None,
    }
}

fn sanitize_image_name(name: Option<&str>, ext: &str) -> String {
    let fallback = format!("pasted-image.{ext}");
    let Some(raw) = name else {
        return fallback;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return fallback;
    }
    let base = trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(trimmed)
        .trim();
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\' && *c != ':')
        .take(128)
        .collect();
    let cleaned = cleaned.trim().trim_matches('.');
    if cleaned.is_empty() {
        fallback
    } else {
        cleaned.to_owned()
    }
}

fn decode_image_base64(data_base64: &str) -> Result<Vec<u8>, String> {
    let trimmed = data_base64.trim();
    let payload = match trimmed.split_once(";base64,") {
        Some((prefix, rest)) if prefix.starts_with("data:") => rest.trim(),
        _ => trimmed,
    };
    if payload.is_empty() {
        return Err("plugin_image_empty_payload".into());
    }
    if payload.len() > MAX_PLUGIN_IMAGE_BASE64_BYTES {
        return Err("plugin_image_too_large".into());
    }
    let cleaned: String = payload
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if cleaned.is_empty() {
        return Err("plugin_image_empty_payload".into());
    }
    if cleaned.len() > MAX_PLUGIN_IMAGE_BASE64_BYTES {
        return Err("plugin_image_too_large".into());
    }
    let bytes = STANDARD
        .decode(cleaned.as_bytes())
        .map_err(|_| "plugin_image_invalid_base64".to_owned())?;
    if bytes.is_empty() {
        return Err("plugin_image_empty_payload".into());
    }
    if bytes.len() > MAX_PLUGIN_IMAGE_BYTES {
        return Err("plugin_image_too_large".into());
    }
    Ok(bytes)
}

fn write_atomic_file(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "plugin_image_invalid_path".to_owned())?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "plugin_image_invalid_path".to_owned())?;
    let temp = parent.join(format!(".{file_name}.tmp.{nonce}"));
    let write_res = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("plugin_image_temp_open: {e}"))?;
        file.write_all(bytes)
            .map_err(|e| format!("plugin_image_temp_write: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("plugin_image_temp_sync: {e}"))?;
        drop(file);
        fs::rename(&temp, target).map_err(|e| format!("plugin_image_rename: {e}"))?;
        Ok(())
    })();
    if write_res.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_res
}

fn plugin_storage_dir(attachments_root: &Path, plugin_id: &str) -> Result<PathBuf, String> {
    if let Some(parent) = attachments_root.parent() {
        ensure_safe_directory(parent)?;
    }
    ensure_safe_directory(attachments_root)?;
    let dir = attachments_root.join(plugin_id);
    ensure_safe_directory(&dir)?;
    Ok(dir)
}

fn normalize_canonical_path(path: PathBuf) -> String {
    let raw = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        return stripped.to_owned();
    }
    raw
}

fn read_bounded_regular_file(
    path: &Path,
    max_bytes: usize,
    not_found_err: &str,
    too_large_err: &str,
    read_err: &str,
) -> Result<Vec<u8>, String> {
    let symlink_meta = match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(not_found_err.to_owned()),
        Err(_) => return Err(read_err.to_owned()),
        Ok(meta) => meta,
    };
    check_not_symlink_or_reparse(path)?;
    if !symlink_meta.file_type().is_file() {
        return Err("plugin_image_not_regular_file".into());
    }
    if symlink_meta.len() == 0 {
        return Err("plugin_image_empty_payload".into());
    }
    if symlink_meta.len() > max_bytes as u64 {
        return Err(too_large_err.to_owned());
    }

    let file = fs::File::open(path).map_err(|_| read_err.to_owned())?;
    let open_meta = file.metadata().map_err(|_| read_err.to_owned())?;
    if !open_meta.is_file() {
        return Err("plugin_image_not_regular_file".into());
    }
    if open_meta.len() == 0 {
        return Err("plugin_image_empty_payload".into());
    }
    if open_meta.len() > max_bytes as u64 {
        return Err(too_large_err.to_owned());
    }
    let initial_cap = usize::try_from(open_meta.len()).unwrap_or(max_bytes).min(max_bytes);
    let mut bytes = Vec::with_capacity(initial_cap);
    file.take((max_bytes as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| read_err.to_owned())?;
    if bytes.is_empty() {
        return Err("plugin_image_empty_payload".into());
    }
    if bytes.len() > max_bytes {
        return Err(too_large_err.to_owned());
    }
    Ok(bytes)
}

fn load_verified_record(
    attachments_root: &Path,
    plugin_id: &str,
    image_id: &str,
) -> Result<(StoredImageMeta, PathBuf, Vec<u8>), String> {
    if !is_valid_image_id(image_id) {
        return Err("plugin_image_invalid_id".into());
    }
    let plugin_dir = plugin_storage_dir(attachments_root, plugin_id)?;
    let canonical_plugin_dir =
        fs::canonicalize(&plugin_dir).map_err(|e| format!("plugin_image_dir_resolve: {e}"))?;

    let meta_path = plugin_dir.join(format!("{image_id}.json"));
    match fs::symlink_metadata(&meta_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("plugin_image_not_found".into())
        }
        Err(e) => return Err(format!("plugin_image_stat_failed: {e}")),
        Ok(_) => check_not_symlink_or_reparse(&meta_path)?,
    }
    let canonical_meta =
        fs::canonicalize(&meta_path).map_err(|_| "plugin_image_not_found".to_owned())?;
    if !canonical_meta.starts_with(&canonical_plugin_dir) {
        return Err("plugin_image_path_escaped".into());
    }

    let meta_raw = read_bounded_regular_file(
        &canonical_meta,
        MAX_PLUGIN_IMAGE_META_BYTES,
        "plugin_image_not_found",
        "plugin_image_metadata_too_large",
        "plugin_image_not_found",
    )?;
    let meta: StoredImageMeta = serde_json::from_slice(&meta_raw)
        .map_err(|_| "plugin_image_corrupt_metadata".to_owned())?;

    if meta.plugin_id != plugin_id || meta.id != image_id {
        return Err("plugin_image_owner_mismatch".into());
    }
    let expected_ext =
        ext_for_mime(&meta.mime_type).ok_or_else(|| "plugin_image_invalid_mime".to_owned())?;
    let expected_file_name = format!("{image_id}.{expected_ext}");
    if meta.file_name != expected_file_name {
        return Err("plugin_image_corrupt_metadata".into());
    }
    if meta.size == 0 || meta.size > MAX_PLUGIN_IMAGE_BYTES {
        return Err("plugin_image_invalid_size".into());
    }

    let payload_path = plugin_dir.join(&meta.file_name);
    match fs::symlink_metadata(&payload_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("plugin_image_not_found".into())
        }
        Err(e) => return Err(format!("plugin_image_stat_failed: {e}")),
        Ok(_) => check_not_symlink_or_reparse(&payload_path)?,
    }
    let canonical_payload =
        fs::canonicalize(&payload_path).map_err(|_| "plugin_image_not_found".to_owned())?;
    if !canonical_payload.starts_with(&canonical_plugin_dir) {
        return Err("plugin_image_path_escaped".into());
    }

    let bytes = read_bounded_regular_file(
        &canonical_payload,
        MAX_PLUGIN_IMAGE_BYTES,
        "plugin_image_not_found",
        "plugin_image_too_large",
        "plugin_image_read_failed",
    )?;
    if bytes.len() != meta.size || bytes.len() > MAX_PLUGIN_IMAGE_BYTES {
        return Err("plugin_image_size_mismatch".into());
    }
    let Some((sniffed_mime, _)) = sniff_allowed_raster(&bytes) else {
        return Err("plugin_image_invalid_raster".into());
    };
    if sniffed_mime != meta.mime_type {
        return Err("plugin_image_mime_mismatch".into());
    }

    Ok((meta, canonical_payload, bytes))
}

pub(crate) fn import_image_in(
    app_home: &Path,
    attachments_root: &Path,
    plugin_id: &str,
    data_base64: &str,
    mime_type: &str,
    name: Option<&str>,
) -> Result<PluginImageAttachment, String> {
    require_image_plugin_in(app_home, plugin_id)?;
    let requested_mime =
        normalize_requested_mime(mime_type).ok_or_else(|| "plugin_image_invalid_mime".to_owned())?;
    let bytes = decode_image_base64(data_base64)?;
    let Some((sniffed_mime, ext)) = sniff_allowed_raster(&bytes) else {
        return Err("plugin_image_invalid_raster".into());
    };
    if sniffed_mime != requested_mime {
        return Err("plugin_image_mime_mismatch".into());
    }

    let plugin_dir = plugin_storage_dir(attachments_root, plugin_id)?;
    let id = uuid::Uuid::new_v4().to_string();
    let safe_name = sanitize_image_name(name, ext);
    let file_name = format!("{id}.{ext}");
    let payload_path = plugin_dir.join(&file_name);
    let meta_path = plugin_dir.join(format!("{id}.json"));

    let meta = StoredImageMeta {
        plugin_id: plugin_id.to_owned(),
        id: id.clone(),
        name: safe_name.clone(),
        mime_type: sniffed_mime.to_owned(),
        file_name,
        size: bytes.len(),
    };
    let meta_bytes =
        serde_json::to_vec(&meta).map_err(|e| format!("plugin_image_meta_serialize: {e}"))?;

    write_atomic_file(&payload_path, &bytes)?;
    if let Err(err) = write_atomic_file(&meta_path, &meta_bytes) {
        let _ = fs::remove_file(&payload_path);
        return Err(err);
    }

    Ok(PluginImageAttachment {
        id,
        name: safe_name,
        mime_type: sniffed_mime.to_owned(),
        size: bytes.len(),
    })
}

pub(crate) fn preview_image_in(
    app_home: &Path,
    attachments_root: &Path,
    plugin_id: &str,
    image_id: &str,
) -> Result<PluginImagePreview, String> {
    require_image_plugin_in(app_home, plugin_id)?;
    let (meta, _, bytes) = load_verified_record(attachments_root, plugin_id, image_id)?;
    Ok(PluginImagePreview {
        data_url: format!("data:{};base64,{}", meta.mime_type, STANDARD.encode(&bytes)),
    })
}

pub(crate) fn resolve_images_in(
    app_home: &Path,
    attachments_root: &Path,
    plugin_id: &str,
    image_ids: &[String],
) -> Result<Vec<String>, String> {
    require_image_plugin_in(app_home, plugin_id)?;
    if image_ids.len() > MAX_PLUGIN_IMAGE_BATCH {
        return Err("plugin_image_too_many_attachments".into());
    }
    let mut resolved = Vec::with_capacity(image_ids.len());
    for image_id in image_ids {
        let (_, canonical_payload, _) =
            load_verified_record(attachments_root, plugin_id, image_id)?;
        resolved.push(normalize_canonical_path(canonical_payload));
    }
    Ok(resolved)
}

#[tauri::command]
pub fn plugin_image_import(
    window: WebviewWindow,
    app: AppHandle,
    plugin_id: String,
    data_base64: String,
    mime_type: String,
    name: Option<String>,
) -> Result<PluginImageAttachment, String> {
    let verified_plugin_id =
        crate::plugin_windows::authorize_plugin_window_caller(&window, &app, &plugin_id, true)?;
    let app_home = crate::paths::app_home();
    let attachments_root = crate::engine::images::plugin_attachments_dir();
    import_image_in(
        &app_home,
        &attachments_root,
        &verified_plugin_id,
        &data_base64,
        &mime_type,
        name.as_deref(),
    )
}

#[tauri::command]
pub fn plugin_image_preview(
    window: WebviewWindow,
    app: AppHandle,
    plugin_id: String,
    image_id: String,
) -> Result<PluginImagePreview, String> {
    let verified_plugin_id =
        crate::plugin_windows::authorize_plugin_window_caller(&window, &app, &plugin_id, true)?;
    let app_home = crate::paths::app_home();
    let attachments_root = crate::engine::images::plugin_attachments_dir();
    preview_image_in(&app_home, &attachments_root, &verified_plugin_id, &image_id)
}

#[tauri::command]
pub fn plugin_image_resolve(
    window: WebviewWindow,
    app: AppHandle,
    plugin_id: String,
    image_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    let verified_plugin_id =
        crate::plugin_windows::authorize_plugin_window_caller(&window, &app, &plugin_id, false)?;
    let app_home = crate::paths::app_home();
    let attachments_root = crate::engine::images::plugin_attachments_dir();
    resolve_images_in(
        &app_home,
        &attachments_root,
        &verified_plugin_id,
        &image_ids,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TestTempDir(PathBuf);

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn setup_fixture() -> (TestTempDir, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ccgui-plugin-images-{}", uuid::Uuid::new_v4()));
        let app_home = dir.join("app-home");
        let attachments_root = app_home.join("pasted-images").join("plugin-attachments");
        fs::create_dir_all(&attachments_root).unwrap();
        (TestTempDir(dir), app_home, attachments_root)
    }

    fn install_test_plugin(
        app_home: &Path,
        plugin_id: &str,
        enabled: bool,
        quarantined: bool,
        permissions: &[&str],
    ) {
        let plugins_dir = app_home.join("plugins").join(plugin_id);
        fs::create_dir_all(&plugins_dir).unwrap();
        let manifest = json!({
            "id": plugin_id,
            "name": plugin_id,
            "version": "0.1.0",
            "sdkVersion": "^0.3.23",
            "permissions": permissions,
        });
        fs::write(
            plugins_dir.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let state_path = app_home.join("plugins.json");
        let mut state: Value = if state_path.exists() {
            serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap()
        } else {
            json!({ "version": 1, "plugins": {} })
        };
        state["plugins"][plugin_id] = json!({
            "version": "0.1.0",
            "enabled": enabled,
            "source": "local",
            "permissions": permissions,
            "quarantined": quarantined,
            "lastError": null,
            "installedAt": 1700000000,
        });
        fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    }

    fn sample_png() -> Vec<u8> {
        vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]
    }

    fn sample_jpeg() -> Vec<u8> {
        vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, b'J', b'F', b'I', b'F']
    }

    fn sample_webp() -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        v.extend_from_slice(&[0x10, 0x00, 0x00, 0x00]);
        v.extend_from_slice(b"WEBP");
        v.extend_from_slice(&[1, 2, 3, 4]);
        v
    }

    fn sample_gif() -> Vec<u8> {
        b"GIF89a\x01\x00\x01\x00".to_vec()
    }

    #[test]
    fn imports_previews_and_resolves_supported_raster_formats() {
        let (_temp, app_home, root) = setup_fixture();
        install_test_plugin(&app_home, "example-dashboard", true, false, &["host:chat"]);
        install_test_plugin(&app_home, "tasks-only-plugin", true, false, &["host:tasks"]);

        for (bytes, mime, name) in [
            (sample_png(), "image/png", Some("hero.png")),
            (sample_jpeg(), "image/jpeg", Some("scene.jpg")),
            (sample_webp(), "image/webp", Some("ui.webp")),
            (sample_gif(), "image/gif", Some("anim.gif")),
        ] {
            let b64 = STANDARD.encode(&bytes);
            let attachment = import_image_in(
                &app_home,
                &root,
                "example-dashboard",
                &b64,
                mime,
                name,
            )
            .unwrap();
            assert_eq!(attachment.mime_type, mime);
            assert_eq!(attachment.size, bytes.len());
            assert_eq!(attachment.name, name.unwrap());

            let preview =
                preview_image_in(&app_home, &root, "example-dashboard", &attachment.id).unwrap();
            assert_eq!(preview.data_url, format!("data:{mime};base64,{b64}"));

            let resolved = resolve_images_in(
                &app_home,
                &root,
                "example-dashboard",
                &[attachment.id.clone()],
            )
            .unwrap();
            assert_eq!(resolved.len(), 1);
            assert!(!resolved[0].starts_with(r"\\?\"));
            assert_eq!(fs::read(&resolved[0]).unwrap(), bytes);
        }

        // host:tasks permission alone is also sufficient
        let b64 = STANDARD.encode(sample_png());
        let att = import_image_in(
            &app_home,
            &root,
            "tasks-only-plugin",
            &b64,
            "image/png",
            None,
        )
        .unwrap();
        assert_eq!(att.name, "pasted-image.png");
    }

    #[test]
    fn enforces_plugin_isolation_and_rejects_traversal_and_unknown_ids() {
        let (_temp, app_home, root) = setup_fixture();
        install_test_plugin(&app_home, "plugin-alpha", true, false, &["host:chat"]);
        install_test_plugin(&app_home, "plugin-beta", true, false, &["host:chat"]);

        let b64 = STANDARD.encode(sample_png());
        let alpha_img =
            import_image_in(&app_home, &root, "plugin-alpha", &b64, "image/png", None).unwrap();

        // Cross-plugin access must fail
        assert_eq!(
            preview_image_in(&app_home, &root, "plugin-beta", &alpha_img.id).unwrap_err(),
            "plugin_image_not_found"
        );
        assert_eq!(
            resolve_images_in(
                &app_home,
                &root,
                "plugin-beta",
                &[alpha_img.id.clone()]
            )
            .unwrap_err(),
            "plugin_image_not_found"
        );

        // Even if metadata file is copied into plugin-beta's folder, owner mismatch rejects it
        let beta_dir = root.join("plugin-beta");
        fs::create_dir_all(&beta_dir).unwrap();
        fs::copy(
            root.join("plugin-alpha")
                .join(format!("{}.json", alpha_img.id)),
            beta_dir.join(format!("{}.json", alpha_img.id)),
        )
        .unwrap();
        fs::copy(
            root.join("plugin-alpha")
                .join(format!("{}.png", alpha_img.id)),
            beta_dir.join(format!("{}.png", alpha_img.id)),
        )
        .unwrap();
        assert_eq!(
            preview_image_in(&app_home, &root, "plugin-beta", &alpha_img.id).unwrap_err(),
            "plugin_image_owner_mismatch"
        );

        // Traversal and invalid IDs rejected
        for bad_id in [
            "../plugin-alpha/secret",
            "..\\plugin-alpha\\secret",
            "not-a-uuid",
            "00000000-0000-0000-0000-000000000000/../../etc",
        ] {
            assert_eq!(
                preview_image_in(&app_home, &root, "plugin-alpha", bad_id).unwrap_err(),
                "plugin_image_invalid_id"
            );
            assert_eq!(
                resolve_images_in(
                    &app_home,
                    &root,
                    "plugin-alpha",
                    &[bad_id.to_owned()]
                )
                .unwrap_err(),
                "plugin_image_invalid_id"
            );
        }

        // Unknown valid UUID rejected
        let unknown_uuid = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            resolve_images_in(&app_home, &root, "plugin-alpha", &[unknown_uuid]).unwrap_err(),
            "plugin_image_not_found"
        );
    }

    #[test]
    fn rejects_svg_html_mime_mismatch_oversize_and_excess_batch() {
        let (_temp, app_home, root) = setup_fixture();
        install_test_plugin(&app_home, "plugin-alpha", true, false, &["host:chat"]);

        // SVG and HTML rejected even if disguised with image/png mime
        let svg_b64 = STANDARD.encode(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>");
        assert_eq!(
            import_image_in(
                &app_home,
                &root,
                "plugin-alpha",
                &svg_b64,
                "image/svg+xml",
                Some("icon.svg")
            )
            .unwrap_err(),
            "plugin_image_invalid_mime"
        );
        assert_eq!(
            import_image_in(
                &app_home,
                &root,
                "plugin-alpha",
                &svg_b64,
                "image/png",
                Some("icon.png")
            )
            .unwrap_err(),
            "plugin_image_invalid_raster"
        );
        let html_b64 = STANDARD.encode(b"<!doctype html><script>alert(1)</script>");
        assert_eq!(
            import_image_in(
                &app_home,
                &root,
                "plugin-alpha",
                &html_b64,
                "image/png",
                None
            )
            .unwrap_err(),
            "plugin_image_invalid_raster"
        );

        // PNG bytes declared as JPEG must fail
        let png_b64 = STANDARD.encode(sample_png());
        assert_eq!(
            import_image_in(
                &app_home,
                &root,
                "plugin-alpha",
                &png_b64,
                "image/jpeg",
                None
            )
            .unwrap_err(),
            "plugin_image_mime_mismatch"
        );

        // > 8 MiB rejected
        let mut huge = sample_png();
        huge.resize(MAX_PLUGIN_IMAGE_BYTES + 1, 0);
        let huge_b64 = STANDARD.encode(&huge);
        assert_eq!(
            import_image_in(
                &app_home,
                &root,
                "plugin-alpha",
                &huge_b64,
                "image/png",
                None
            )
            .unwrap_err(),
            "plugin_image_too_large"
        );

        // > 8 IDs in resolve rejected
        let img =
            import_image_in(&app_home, &root, "plugin-alpha", &png_b64, "image/png", None).unwrap();
        let nine = vec![img.id; MAX_PLUGIN_IMAGE_BATCH + 1];
        assert_eq!(
            resolve_images_in(&app_home, &root, "plugin-alpha", &nine).unwrap_err(),
            "plugin_image_too_many_attachments"
        );
    }

    #[test]
    fn enforces_enabled_plugin_and_host_permissions() {
        let (_temp, app_home, root) = setup_fixture();
        install_test_plugin(&app_home, "disabled-plugin", false, false, &["host:chat"]);
        install_test_plugin(&app_home, "quarantined-plugin", true, true, &["host:chat"]);
        install_test_plugin(&app_home, "no-perm-plugin", true, false, &["storage"]);

        let png_b64 = STANDARD.encode(sample_png());
        assert_eq!(
            import_image_in(
                &app_home,
                &root,
                "disabled-plugin",
                &png_b64,
                "image/png",
                None
            )
            .unwrap_err(),
            "plugin_image_plugin_disabled"
        );
        assert_eq!(
            import_image_in(
                &app_home,
                &root,
                "quarantined-plugin",
                &png_b64,
                "image/png",
                None
            )
            .unwrap_err(),
            "plugin_image_plugin_disabled"
        );
        assert_eq!(
            import_image_in(
                &app_home,
                &root,
                "no-perm-plugin",
                &png_b64,
                "image/png",
                None
            )
            .unwrap_err(),
            "plugin_image_permission_denied"
        );
    }

    #[test]
    fn rejects_oversize_stored_files_and_real_symlink_or_reparse_escapes() {
        let (temp, app_home, root) = setup_fixture();
        install_test_plugin(&app_home, "plugin-alpha", true, false, &["host:chat"]);
        install_test_plugin(&app_home, "plugin-junction", true, false, &["host:chat"]);

        let png_b64 = STANDARD.encode(sample_png());
        let img =
            import_image_in(&app_home, &root, "plugin-alpha", &png_b64, "image/png", None).unwrap();
        let alpha_dir = root.join("plugin-alpha");
        let meta_path = alpha_dir.join(format!("{}.json", img.id));
        let payload_path = alpha_dir.join(format!("{}.png", img.id));
        let orig_meta = fs::read(&meta_path).unwrap();

        // 1. Oversize stored payload on disk (> 8 MiB) must be rejected before reading full file
        {
            let f = fs::OpenOptions::new().write(true).open(&payload_path).unwrap();
            f.set_len((MAX_PLUGIN_IMAGE_BYTES + 1024) as u64).unwrap();
        }
        assert_eq!(
            preview_image_in(&app_home, &root, "plugin-alpha", &img.id).unwrap_err(),
            "plugin_image_too_large"
        );
        assert_eq!(
            resolve_images_in(&app_home, &root, "plugin-alpha", &[img.id.clone()]).unwrap_err(),
            "plugin_image_too_large"
        );

        // Restore valid payload, then test oversize stored metadata (> 16 KiB)
        fs::write(&payload_path, sample_png()).unwrap();
        fs::write(&meta_path, vec![b' '; MAX_PLUGIN_IMAGE_META_BYTES + 128]).unwrap();
        assert_eq!(
            preview_image_in(&app_home, &root, "plugin-alpha", &img.id).unwrap_err(),
            "plugin_image_metadata_too_large"
        );
        fs::write(&meta_path, &orig_meta).unwrap();
        assert!(preview_image_in(&app_home, &root, "plugin-alpha", &img.id).is_ok());

        // 2. Real symlink / Windows reparse point escape tests
        let outside_dir = temp.0.join("outside-secret");
        fs::create_dir_all(&outside_dir).unwrap();
        let outside_png = outside_dir.join("secret.png");
        fs::write(&outside_png, sample_png()).unwrap();

        #[cfg(windows)]
        {
            // Directory junction (NTFS reparse point) as plugin storage directory
            let junction_dir = root.join("plugin-junction");
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&junction_dir)
                .arg(&outside_dir)
                .output()
                .expect("mklink /J should execute");
            assert!(status.status.success(), "mklink /J failed: {:?}", status);

            assert_eq!(
                import_image_in(
                    &app_home,
                    &root,
                    "plugin-junction",
                    &png_b64,
                    "image/png",
                    None
                )
                .unwrap_err(),
                "plugin_image_symlink_forbidden"
            );

            // Replace payload file with a symlink if OS permits file symlinks, or a directory reparse point at payload path
            fs::remove_file(&payload_path).unwrap();
            let file_link_created = std::os::windows::fs::symlink_file(&outside_png, &payload_path).is_ok();
            if !file_link_created {
                let st = std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(&payload_path)
                    .arg(&outside_dir)
                    .output()
                    .unwrap();
                assert!(st.status.success());
            }
            assert_eq!(
                preview_image_in(&app_home, &root, "plugin-alpha", &img.id).unwrap_err(),
                "plugin_image_symlink_forbidden"
            );
            assert_eq!(
                resolve_images_in(&app_home, &root, "plugin-alpha", &[img.id.clone()]).unwrap_err(),
                "plugin_image_symlink_forbidden"
            );
        }
        #[cfg(unix)]
        {
            fs::remove_file(&payload_path).unwrap();
            std::os::unix::fs::symlink(&outside_png, &payload_path).unwrap();
            assert_eq!(
                preview_image_in(&app_home, &root, "plugin-alpha", &img.id).unwrap_err(),
                "plugin_image_symlink_forbidden"
            );
        }
    }
}
