//! Read-only image grants never participate in workspace/file or engine permissions.
use crate::event_sink::Emit;
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

const LIMIT: u64 = 64 * 1024 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ImagePreviewGrant {
    pub path: String,
    pub scope: String,
}

mod storage;
pub(crate) use storage::migrate_legacy;

fn canonical(path: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(path.trim()).map_err(|e| format!("resolve image: {e}"))
}

// Validate the opened object, not just a path checked before opening it. This
// closes the parent/symlink replacement window between canonicalize and open.
#[cfg(windows)]
fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED},
    };
    let mut buffer = vec![0u16; 32768];
    let len = unsafe {
        GetFinalPathNameByHandleW(
            HANDLE(file.as_raw_handle()),
            &mut buffer,
            FILE_NAME_NORMALIZED,
        )
    } as usize;
    if len == 0 || len >= buffer.len() {
        return Err("cannot resolve opened image".into());
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len])))
}
#[cfg(target_os = "linux")]
fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(|e| e.to_string())
}
#[cfg(target_os = "macos")]
fn opened_path(file: &File) -> Result<PathBuf, String> {
    use std::os::{fd::AsRawFd, unix::ffi::OsStringExt};
    let mut buffer = vec![0u8; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    buffer.truncate(buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len()));
    Ok(PathBuf::from(std::ffi::OsString::from_vec(buffer)))
}
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn opened_path(_: &File) -> Result<PathBuf, String> {
    Err("secure image preview unsupported on this platform".into())
}

fn open_image(path: &Path) -> Result<File, String> {
    let file = File::open(path).map_err(|e| format!("open image: {e}"))?;
    if opened_path(&file)? != path {
        return Err("image path changed; retry".into());
    }
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not an image file".into());
    }
    if meta.len() > LIMIT {
        return Err("image exceeds 64MB preview limit".into());
    }
    Ok(file)
}
fn bytes(file: File) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read image: {e}"))?;
    if bytes.len() as u64 > LIMIT {
        return Err("image exceeds 64MB preview limit".into());
    }
    if crate::files::raster_mime(&bytes).is_none() {
        return Err("not a raster image".into());
    }
    Ok(bytes)
}
fn scopes(path: &str) -> Result<Vec<ImagePreviewGrant>, String> {
    let file = canonical(path)?;
    // Scope discovery is passive: inspect only the signature, with the same
    // opened-handle confinement as reads. No grant is recorded here.
    let mut handle = open_image(&file)?;
    let mut header = [0u8; 32];
    let count = handle.read(&mut header).map_err(|e| e.to_string())?;
    if crate::files::raster_mime(&header[..count]).is_none() {
        return Err("not a raster image".into());
    }
    let parent = file.parent().ok_or("image has no parent directory")?;
    Ok(vec![
        ImagePreviewGrant {
            path: file.to_string_lossy().into(),
            scope: "file".into(),
        },
        ImagePreviewGrant {
            path: parent.to_string_lossy().into(),
            scope: "directory".into(),
        },
    ])
}
#[tauri::command]
pub fn image_preview_scope(path: String) -> Result<Vec<ImagePreviewGrant>, String> {
    scopes(&path)
}

fn list(conn: &rusqlite::Connection) -> Result<Vec<ImagePreviewGrant>, String> {
    let mut grants = storage::read(conn).map_err(|e| e.to_string())?;
    grants.sort_by(|a, b| (&a.path, &a.scope).cmp(&(&b.path, &b.scope)));
    Ok(grants)
}
#[tauri::command]
pub fn list_image_preview_grants(
    db: tauri::State<'_, Arc<crate::db::Db>>,
) -> Result<Vec<ImagePreviewGrant>, String> {
    list(&db.inner().0.lock())
}

fn grant(
    db: &crate::db::Db,
    path: &str,
    scope: &str,
    expected_path: &str,
) -> Result<ImagePreviewGrant, String> {
    let entry = scopes(path)?
        .into_iter()
        .find(|g| g.scope == scope)
        .ok_or("invalid image preview scope")?;
    // Compare to the exact canonical scope shown to the user. Do not resolve
    // expected_path again: a replaced link could otherwise move both sides.
    if entry.path != expected_path {
        return Err("image preview scope changed; inspect the scope and approve again".into());
    }
    let mut conn = db.0.lock();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut grants = storage::read(&tx).map_err(|e| e.to_string())?;
    if !grants
        .iter()
        .any(|g| g.path == entry.path && g.scope == entry.scope)
    {
        grants.push(entry.clone());
    }
    storage::write(&tx, &grants).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(entry)
}
#[tauri::command]
pub fn grant_image_preview(
    state: tauri::State<'_, crate::AppState>,
    path: String,
    scope: String,
    expected_path: String,
) -> Result<ImagePreviewGrant, String> {
    let entry = grant(&state.db, &path, &scope, &expected_path)?;
    state
        .emitters
        .emit_json("image-preview-grants://changed", "null");
    Ok(entry)
}
fn revoke(db: &crate::db::Db, path: &str, scope: &str) -> Result<(), String> {
    // Use the stored key: missing/replaced files must remain revocable.
    let mut conn = db.0.lock();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut grants = storage::read(&tx).map_err(|e| e.to_string())?;
    grants.retain(|g| g.path != path || g.scope != scope);
    // Keep an empty state as the durable import marker: old development-table
    // grants must never reappear after revocation or a later restart.
    storage::write(&tx, &grants).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn revoke_image_preview_grant(
    state: tauri::State<'_, crate::AppState>,
    path: String,
    scope: String,
) -> Result<(), String> {
    revoke(&state.db, &path, &scope)?;
    state
        .emitters
        .emit_json("image-preview-grants://changed", "null");
    Ok(())
}
pub(crate) fn read_blocking(db: &crate::db::Db, path: &str) -> Result<Vec<u8>, String> {
    // The legacy guard tolerates catalogue read failures. Preview must not
    // mistake a broken catalogue for an invitation to grant more access.
    db.workspace_paths()?;
    db.granted_roots()?;
    let existing = crate::files::ensure_allowed(path, db).ok();
    let resolved = crate::files::canonicalize_lenient(Path::new(path.trim()))?;
    let conn = db.0.lock();
    if existing.as_ref() != Some(&resolved)
        && !list(&conn)?.iter().any(|g| match g.scope.as_str() {
            "file" => resolved == Path::new(&g.path),
            "directory" => resolved.starts_with(Path::new(&g.path)),
            _ => false,
        })
    {
        return Err(format!("path is outside the registered workspaces: {path}"));
    }
    bytes(open_image(&resolved)?)
}
#[tauri::command]
pub async fn read_preview_image_bytes(
    db: tauri::State<'_, Arc<crate::db::Db>>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let db = Arc::clone(db.inner());
    let bytes = tauri::async_runtime::spawn_blocking(move || read_blocking(&db, &path))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}
#[tauri::command]
pub async fn read_preview_image(
    db: tauri::State<'_, Arc<crate::db::Db>>,
    path: String,
) -> Result<String, String> {
    use base64::Engine;
    let db = Arc::clone(db.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = read_blocking(&db, &path)?;
        Ok(format!(
            "data:{};base64,{}",
            crate::files::raster_mime(&bytes).ok_or("not a raster image")?,
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests;
