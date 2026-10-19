//! Two profile-wide naming leases. Closing a process releases its lease even
//! after a crash; there is no persistent counter to strand capacity.
use std::fs::{File, OpenOptions};
use std::path::Path;
use std::time::Duration;

pub(super) async fn acquire(profile: &Path) -> std::io::Result<File> {
    let root = profile.join("runtime");
    std::fs::create_dir_all(&root)?;
    let canonical = dunce::canonicalize(&root)?;
    if canonical.parent() != Some(dunce::canonicalize(profile)?.as_path()) {
        return Err(std::io::Error::other(
            "Naming lease directory leaves its profile",
        ));
    }
    loop {
        for index in 0..2 {
            if let Some(file) = try_acquire(&canonical.join(format!("naming-{index}.lock")))? {
                return Ok(file);
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn try_acquire(path: &Path) -> std::io::Result<Option<File>> {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(std::io::Error::other("Naming lease is a reparse point"));
            }
        }
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err(std::io::Error::other("Naming lease is not a regular file"));
        }
    }
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
        match options.open(path) {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.raw_os_error() == Some(32) => Ok(None),
            Err(error) => Err(error),
        }
    }
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let file = options.open(path)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(file));
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            Ok(None)
        } else {
            Err(error)
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        Err(std::io::Error::other(
            "Cross-process naming leases are unsupported",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn separate_handles_exclude_until_the_owner_closes() {
        let root = std::env::temp_dir().join(format!("ccgui-naming-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("lease");
        let first = try_acquire(&path).unwrap().unwrap();
        assert!(try_acquire(&path).unwrap().is_none());
        drop(first);
        assert!(try_acquire(&path).unwrap().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }
}
