//! "Save as" for the image preview. The native save dialog runs here rather
//! than in the webview, so the written path is always the user's explicit
//! choice and the frontend never gains an arbitrary-path binary write.
use base64::Engine as _;

/// Previews come from `read_file` (5MB) or engine attachments; the cap only
/// bounds a malformed payload.
const MAX_EXPORT_IMAGE_BYTES: usize = 32 * 1024 * 1024;

/// Raster data URL → (file extension, bytes). Same formats the preview accepts.
fn decode_image_data_url(data_url: &str) -> Result<(&'static str, Vec<u8>), String> {
    let rest = data_url.strip_prefix("data:image/").ok_or("not an image data URL")?;
    let (mime, payload) = rest.split_once(";base64,").ok_or("not a base64 image data URL")?;
    let ext = match mime.to_ascii_lowercase().as_str() {
        "png" => "png",
        "jpeg" | "jpg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        "bmp" => "bmp",
        "avif" => "avif",
        "x-icon" => "ico",
        other => return Err(format!("unsupported image type: {other}")),
    };
    if payload.len() > MAX_EXPORT_IMAGE_BYTES / 3 * 4 + 8 {
        return Err("image exceeds 32MB export limit".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.as_bytes())
        .map_err(|_| "invalid base64 payload".to_string())?;
    if bytes.is_empty() {
        return Err("empty image payload".to_string());
    }
    Ok((ext, bytes))
}

/// Suggested file name: the preview's display name without directories or
/// characters Windows rejects, keeping an image extension that matches.
fn suggested_file_name(name: &str, ext: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .collect();
    let clean = clean.trim().trim_end_matches('.');
    let stem = match clean.rsplit_once('.') {
        Some((_, current)) if current.eq_ignore_ascii_case(ext)
            || (ext == "jpg" && current.eq_ignore_ascii_case("jpeg")) => return clean.to_string(),
        Some((stem, current)) if ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico"]
            .iter().any(|known| current.eq_ignore_ascii_case(known)) => stem,
        _ => clean,
    };
    let stem = if stem.is_empty() { "image" } else { stem };
    format!("{stem}.{ext}")
}

fn mime_extension(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/avif" => "avif",
        "image/x-icon" => "ico",
        _ => "png",
    }
}

/// Asks where to save, then writes the bytes. `Ok(None)` = dialog cancelled.
/// A file-backed image is saved from `source_path` (same confinement as
/// previews, no payload round trip); otherwise from its data URL.
#[tauri::command]
pub async fn save_image_as(
    app: tauri::AppHandle,
    db: tauri::State<'_, std::sync::Arc<crate::db::Db>>,
    file_name: String,
    data_url: Option<String>,
    source_path: Option<String>,
) -> Result<Option<String>, String> {
    let (ext, bytes) = match (source_path, data_url) {
        (Some(path), _) => {
            let db = std::sync::Arc::clone(db.inner());
            let bytes = tauri::async_runtime::spawn_blocking(move || {
                crate::image_preview::read_blocking(&db, &path)
            })
            .await
            .map_err(|e| e.to_string())??;
            (mime_extension(crate::files::raster_mime(&bytes).unwrap_or("image/png")), bytes)
        }
        (None, Some(data_url)) => decode_image_data_url(&data_url)?,
        (None, None) => return Err("no image to save".to_string()),
    };
    let suggested = suggested_file_name(&file_name, ext);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .file()
            .set_file_name(suggested)
            .add_filter("Image", &[ext])
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("save dialog failed: {e}"))?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| format!("invalid save path: {e}"))?;
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&target, bytes))
        .await
        .map_err(|e| format!("write image: {e}"))?
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &str = "data:image/png;base64,iVBORw0KGgo=";

    #[test]
    fn decodes_raster_data_urls_and_rejects_others() {
        let (ext, bytes) = decode_image_data_url(PNG).unwrap();
        assert_eq!(ext, "png");
        assert_eq!(&bytes[..4], b"\x89PNG");
        assert_eq!(decode_image_data_url("data:image/jpeg;base64,/9j/").unwrap().0, "jpg");
        assert!(decode_image_data_url("data:image/svg+xml;base64,PHN2Zz4=").is_err());
        assert!(decode_image_data_url("data:text/plain;base64,aGk=").is_err());
        assert!(decode_image_data_url("data:image/png;base64,").is_err());
        assert!(decode_image_data_url("data:image/png;base64,***").is_err());
        assert!(decode_image_data_url("C:/work/a.png").is_err());
    }

    #[test]
    fn suggested_names_strip_directories_and_match_the_format() {
        assert_eq!(suggested_file_name("C:\\work\\design.png", "png"), "design.png");
        assert_eq!(suggested_file_name("photo.JPEG", "jpg"), "photo.JPEG");
        assert_eq!(suggested_file_name("art.png", "webp"), "art.webp");
        assert_eq!(suggested_file_name("工作台 总览", "png"), "工作台 总览.png");
        assert_eq!(suggested_file_name("a:b?.png", "png"), "ab.png");
        assert_eq!(suggested_file_name("../", "gif"), "image.gif");
        assert_eq!(suggested_file_name("v1.2 draft", "png"), "v1.2 draft.png");
    }
}
