//! Kernel liveness and creation identity for durable process-owned reservations.
//! Unknown access/wait results must never be interpreted as a dead owner.
#![cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

type Handle = *mut std::ffi::c_void;

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn WaitForSingleObject(handle: Handle, millis: u32) -> u32;
    fn GetProcessTimes(
        handle: Handle,
        created: *mut FileTime,
        exited: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
}

/// A birth timestamp identifies a live process incarnation, including PID reuse.
/// Missing/signaled is definitely dead; access failures stay unknown.
pub(crate) fn process_birth(pid: u32) -> Result<Option<u64>, ()> {
    if pid == 0 {
        return Err(());
    }
    let raw = unsafe { OpenProcess(0x0010_0000 | 0x1000, 0, pid) };
    if raw.is_null() {
        return if std::io::Error::last_os_error().raw_os_error() == Some(87) {
            Ok(None)
        } else {
            Err(())
        };
    }
    if raw == -1isize as Handle {
        return Err(());
    }
    let process = unsafe { OwnedHandle::from_raw_handle(raw) };
    match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
        0 => return Ok(None),
        258 => {}
        _ => return Err(()),
    }
    let (mut created, mut exited, mut kernel, mut user) = (
        FileTime::default(),
        FileTime::default(),
        FileTime::default(),
        FileTime::default(),
    );
    if unsafe {
        GetProcessTimes(
            process.as_raw_handle(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(());
    }
    let value = ((created.high as u64) << 32) | created.low as u64;
    if value == 0 {
        Err(())
    } else {
        Ok(Some(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_has_a_stable_birth_and_zero_is_unknown() {
        let birth = process_birth(std::process::id()).unwrap().unwrap();
        assert!(birth > 0);
        assert_eq!(process_birth(std::process::id()), Ok(Some(birth)));
        assert_eq!(process_birth(0), Err(()));
    }

    #[test]
    fn exited_process_is_dead_even_with_still_active_exit_code() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "exit 259"])
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        let status = child.wait().unwrap();
        assert_eq!(status.code(), Some(259));
        // Child retains its kernel handle, preventing PID reuse during this assertion.
        assert_eq!(process_birth(child.id()), Ok(None));
    }
}
