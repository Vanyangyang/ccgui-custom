/// Separate handshake: an older native host would ignore a new Channel argument
/// without owning/dropping it, so the frontend must not allocate one there.
#[tauri::command]
pub fn handoff_progress_supported() -> bool { true }
