//! Crash recovery for owned observer profiles. No history registration or PID killing.
use std::{fs::{File, OpenOptions}, io::{Read, Write}, path::Path};
use super::{PrivateStaging, SideCallError};

const PREFIX: &str = "ccgui-observer-agy-";
const MARKER: &str = ".ccgui-observer-lease";
const MAGIC: &str = "ccgui-observer-agy-v1\n";
const CHILD: &str = ".ccgui-observer-child";

#[derive(serde::Serialize, serde::Deserialize)]
struct ChildIdentity { pid: u32, started: u64 }

pub(super) fn acquire(root: &Path) -> Result<File, SideCallError> {
    let mut lease = OpenOptions::new().read(true).write(true).create_new(true)
        .open(root.join(MARKER)).map_err(|_| SideCallError::Unavailable)?;
    lease.try_lock().map_err(|_| SideCallError::Unavailable)?;
    lease.write_all(MAGIC.as_bytes()).map_err(|_| SideCallError::Unavailable)?;
    // A crash before spawning any CLI is immediately recoverable.
    std::fs::write(root.join(CHILD), b"none").map_err(|_| SideCallError::Unavailable)?;
    Ok(lease)
}

pub(in crate::engine::side_call) fn before_spawn(home: &Path) -> Result<(), SideCallError> {
    std::fs::write(home.parent().ok_or(SideCallError::Unavailable)?.join(CHILD), b"pending")
        .map_err(|_| SideCallError::Unavailable)
}

pub(in crate::engine::side_call) fn spawned(home: &Path, pid: Option<u32>) -> Result<(), SideCallError> {
    // A surviving CLI must retain its files even after the host lease is released.
    let pid = pid.ok_or(SideCallError::Unavailable)?;
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    let native_pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&[native_pid]), true, ProcessRefreshKind::nothing());
    let started = system.process(native_pid).map_or(0, |process| process.start_time());
    let identity = serde_json::to_vec(&ChildIdentity { pid, started }).map_err(|_| SideCallError::Unavailable)?;
    std::fs::write(home.parent().ok_or(SideCallError::Unavailable)?.join(CHILD), identity)
        .map_err(|_| SideCallError::Unavailable)
}

fn plain(path: &Path, directory: bool) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return false; };
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return false; } // reparse points, including junctions
    }
    !meta.file_type().is_symlink() && if directory { meta.is_dir() } else { meta.is_file() }
}

fn child_alive(root: &Path) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let file = root.join(CHILD);
    if !plain(&file, false) { return true; }
    let Ok(meta) = std::fs::metadata(&file) else { return true; };
    if meta.len() > 128 { return true; }
    let Ok(state) = std::fs::read_to_string(&file) else { return true; };
    if state == "none" { return false; }
    // Incomplete spawn records cannot prove that a child is gone. Preserve
    // rather than deleting a potentially live Unix CLI after host SIGKILL.
    let Ok(identity) = serde_json::from_str::<ChildIdentity>(&state) else { return true; };
    if identity.pid == 0 { return true; }
    let pid = Pid::from_u32(identity.pid);
    #[cfg(unix)]
    let Ok(unix_pid) = i32::try_from(identity.pid) else { return true; };
    #[cfg(unix)] {
        // A wrapper may have exited while its descendants retain the process
        // group. EPERM/unknown errors also mean we cannot safely reclaim it.
        let result = unsafe { libc::kill(-unix_pid, 0) };
        if result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) { return true; }
    }
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing());
    if let Some(process) = system.process(pid) {
        return identity.started == 0 || process.start_time() == 0 || process.start_time() == identity.started;
    }
    #[cfg(windows)] {
        use windows::Win32::{Foundation::{CloseHandle, ERROR_INVALID_PARAMETER}, System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION}};
        return match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, identity.pid) } {
            Ok(handle) => { unsafe { let _ = CloseHandle(handle); } true },
            Err(error) => error.code() != ERROR_INVALID_PARAMETER.to_hresult(),
        };
    }
    #[cfg(unix)] {
        let result = unsafe { libc::kill(unix_pid, 0) };
        return result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
    }
    #[cfg(not(any(unix, windows)))] true
}

pub(super) fn remove_payload_then_markers(root: &Path) -> bool {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) => return error.kind() == std::io::ErrorKind::NotFound,
    };
    for entry in entries {
        let Ok(entry) = entry else { return false; };
        if entry.file_name() == MARKER || entry.file_name() == CHILD { continue; }
        // remove_dir_all does not follow directory links. Retain ownership
        // metadata until every payload file was successfully removed.
        let result = if entry.path().is_dir() { std::fs::remove_dir_all(entry.path()) } else { std::fs::remove_file(entry.path()) };
        if result.is_err() { return false; }
    }
    for marker in [CHILD, MARKER] {
        if let Err(error) = std::fs::remove_file(root.join(marker)) {
            if error.kind() != std::io::ErrorKind::NotFound { return false; }
        }
    }
    std::fs::remove_dir(root).is_ok()
}

pub(super) fn sweep_in(temp: &Path) {
    let Ok(entries) = std::fs::read_dir(temp) else { return; };
    let started = std::time::Instant::now();
    for entry in entries.flatten() {
        // No recurring timer: bound enumeration work on startup/each call.
        if started.elapsed() > std::time::Duration::from_secs(1) { break; }
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|name| name.strip_prefix(PREFIX)) else { continue; };
        if uuid::Uuid::parse_str(id).is_err() { continue; }
        let root = entry.path();
        if !plain(&root, true) || !plain(&root.join(MARKER), false) { continue; }
        let Ok(mut lease) = OpenOptions::new().read(true).write(true).open(root.join(MARKER)) else { continue; };
        if lease.try_lock().is_err() { continue; }
        let mut contents = String::new();
        if (&mut lease).take(64).read_to_string(&mut contents).is_err() || contents != MAGIC || child_alive(&root) { continue; }
        // Keep the OS lock held while removing; concurrent sweepers cannot race.
        // Failed Windows handle cleanup is retried on a future startup/call.
        super::remove_staging(&root);
    }
}

pub(crate) fn cleanup_orphans() { sweep_in(&std::env::temp_dir()); }

pub(super) fn create(root: &Path) -> Result<PrivateStaging, SideCallError> {
    std::fs::create_dir(root).map_err(|_| SideCallError::Unavailable)?;
    let mut staging = PrivateStaging { root: root.to_path_buf(), lease: None };
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).map_err(|_| SideCallError::Unavailable)?;
    }
    staging.lease = Some(acquire(root)?);
    Ok(staging)
}

#[cfg(test)]
mod tests;
