//! Repair legacy release-pinned shortcuts without creating or renaming links.
use std::{
    ffi::OsString,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::MetadataExt,
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use windows::{
    core::{Interface, GUID, PCWSTR},
    Win32::{
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
        },
        UI::Shell::{
            FOLDERID_CommonPrograms, FOLDERID_Desktop, FOLDERID_Programs, FOLDERID_PublicDesktop,
            FOLDERID_RoamingAppData, IShellLinkW, SHChangeNotify, SHGetKnownFolderPath, ShellLink,
            KF_FLAG_DEFAULT, SHCNE_UPDATEITEM, SHCNF_PATHW, SLGP_RAWPATH,
        },
    },
};

const MAX_ENTRIES: usize = 4096;
const MAX_DEPTH: usize = 12;
const MAX_SCAN_TIME: Duration = Duration::from_secs(5);
const REPARSE_POINT: u32 = 0x400;

struct Apartment;
impl Apartment {
    fn new() -> windows::core::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

pub(crate) fn spawn_startup_repair() {
    if crate::paths::is_dev_profile() {
        return;
    }
    let Some(installed) = crate::launch_protection::reviewed_gui_executable() else {
        return;
    };
    if !installed.is_file() {
        return;
    }
    let Ok(current) = std::env::current_exe() else {
        return;
    };
    // Shell links expand 8.3 aliases; use the same long path identity as COM.
    let installed = dunce::canonicalize(&installed).unwrap_or(installed);
    let releases = crate::paths::app_home().join("runtime-updates/releases");
    let releases = dunce::canonicalize(&releases).unwrap_or(releases);
    let canonical = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    if crate::launch_protection::launch_gate(
        &crate::startup::Mode::Gui,
        false,
        &canonical(&current),
        &canonical(&installed),
        &canonical(&releases),
    ) != crate::launch_protection::LaunchGate::Enforce
    {
        return;
    }
    if let Err(error) = std::thread::Builder::new()
        .name("shortcut-repair".into())
        .spawn(move || {
            let _apartment = match Apartment::new() {
                Ok(apartment) => apartment,
                Err(error) => {
                    eprintln!("[shortcuts] COM initialization failed: {error}");
                    return;
                }
            };
            let mut stats = ScanStats::default();
            let mut roots = Vec::new();
            for (id, recursive) in [
                (FOLDERID_Desktop, false),
                (FOLDERID_PublicDesktop, false),
                (FOLDERID_Programs, true),
                (FOLDERID_CommonPrograms, true),
            ] {
                match known_folder(&id) {
                    Ok(path) => roots.push((path, recursive)),
                    Err(_) => stats.errors += 1,
                }
            }
            if let Ok(path) = known_folder(&FOLDERID_RoamingAppData) {
                roots.push((
                    path.join("Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar"),
                    false,
                ));
            }
            scan(&roots, &installed, &releases, &mut stats);
            if stats.changed > 0 || stats.errors > 0 || stats.limited {
                eprintln!(
                    "[shortcuts] repaired={}, errors={}, scan_limited={}",
                    stats.changed, stats.errors, stats.limited
                );
            }
        })
    {
        eprintln!("[shortcuts] cannot start repair worker: {error}");
    }
}

fn known_folder(id: &GUID) -> windows::core::Result<PathBuf> {
    unsafe {
        let raw = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None)?;
        let path = PathBuf::from(OsString::from_wide(raw.as_wide()));
        CoTaskMemFree(Some(raw.0.cast()));
        Ok(path)
    }
}

#[derive(Default)]
struct ScanStats {
    changed: usize,
    errors: usize,
    limited: bool,
}

fn scan(roots: &[(PathBuf, bool)], installed: &Path, releases: &Path, stats: &mut ScanStats) {
    let started = Instant::now();
    let mut remaining = MAX_ENTRIES;
    let mut pending: Vec<_> = roots.iter().map(|(p, r)| (p.clone(), *r, 0)).collect();
    while let Some((directory, recursive, depth)) = pending.pop() {
        if remaining == 0 || started.elapsed() >= MAX_SCAN_TIME {
            stats.limited = true;
            break;
        }
        match std::fs::symlink_metadata(&directory) {
            Ok(meta) if meta.file_attributes() & REPARSE_POINT == 0 && meta.is_dir() => (),
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                stats.errors += 1;
                continue;
            }
        }
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                stats.errors += 1;
                continue;
            }
        };
        for entry in entries {
            if remaining == 0 || started.elapsed() >= MAX_SCAN_TIME {
                stats.limited = true;
                return;
            }
            remaining -= 1;
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    stats.errors += 1;
                    continue;
                }
            };
            let path = entry.path();
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(_) => {
                    stats.errors += 1;
                    continue;
                }
            };
            // Includes junctions, directory symlinks and file reparse points.
            if meta.file_attributes() & REPARSE_POINT != 0 {
                continue;
            }
            if meta.is_dir() && recursive {
                if depth < MAX_DEPTH {
                    pending.push((path, true, depth + 1));
                } else {
                    stats.limited = true;
                }
            } else if meta.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
            {
                match repair_link(&path, installed, releases) {
                    Ok(true) => stats.changed += 1,
                    Ok(false) => (),
                    Err(_) => stats.errors += 1,
                }
            }
        }
    }
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn buffer_path(buffer: &[u16]) -> PathBuf {
    PathBuf::from(OsString::from_wide(
        &buffer[..buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len())],
    ))
}
fn normalized(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\").to_lowercase();
    let text = text
        .strip_prefix("\\\\?\\unc\\")
        .map(|rest| format!("\\\\{rest}"))
        .unwrap_or_else(|| text.strip_prefix("\\\\?\\").unwrap_or(&text).to_owned());
    text.trim_end_matches('\\').to_owned()
}
fn release_parent(target: &Path, releases: &Path) -> Option<PathBuf> {
    // Do not canonicalize the target: old releases are commonly already deleted.
    let target_text = normalized(target);
    let prefix = format!("{}\\", normalized(releases));
    let relative = target_text.strip_prefix(&prefix)?;
    let (hash, name) = relative.split_once('\\')?;
    if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) || name != "ccgui-next.exe"
    {
        return None;
    }
    target.parent().map(Path::to_path_buf)
}

fn load_link(path: &Path) -> windows::core::Result<(IShellLinkW, IPersistFile)> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let persist: IPersistFile = link.cast()?;
        persist.Load(PCWSTR(wide(path).as_ptr()), STGM_READ)?;
        Ok((link, persist))
    }
}

/// The caller owns a COM apartment. Never resolves the link or launches its target.
fn repair_link(path: &Path, installed: &Path, releases: &Path) -> windows::core::Result<bool> {
    if !installed.is_file() {
        return Ok(false);
    }
    let (link, persist) = load_link(path)?;
    let mut target = vec![0u16; 32768];
    let mut cwd = vec![0u16; 32768];
    unsafe {
        link.GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)?;
        let target = buffer_path(&target);
        let release = release_parent(&target, releases);
        if release.is_none() && normalized(&target) != normalized(installed) {
            return Ok(false);
        }
        link.GetWorkingDirectory(&mut cwd)?;
        let cwd = buffer_path(&cwd);
        let migrate_cwd = match &release {
            Some(release) => normalized(&cwd) == normalized(release),
            None => release_parent(&cwd.join("ccgui-next.exe"), releases).is_some(),
        };
        let mut icon = vec![0u16; 32768];
        let mut index = 0;
        link.GetIconLocation(&mut icon, &mut index)?;
        let migrate_icon =
            release.is_some() || release_parent(&buffer_path(&icon), releases).is_some();
        if release.is_none() && !migrate_icon && !migrate_cwd {
            return Ok(false);
        }
        let installed_wide = wide(installed);
        if release.is_some() {
            link.SetPath(PCWSTR(installed_wide.as_ptr()))?;
        }
        // A corrected target can still retain a deleted release's icon or cwd.
        if let Some(parent) = installed.parent().filter(|_| migrate_cwd) {
            link.SetWorkingDirectory(PCWSTR(wide(parent).as_ptr()))?;
        } else if release.is_some() {
            // SetPath can reset the working directory as a side effect.
            link.SetWorkingDirectory(PCWSTR(wide(&cwd).as_ptr()))?;
        }
        if migrate_icon {
            link.SetIconLocation(PCWSTR(installed_wide.as_ptr()), 0)?;
        }
        // Mutate the loaded object so arguments, description, hotkey and show mode survive.
        let filename = wide(path);
        persist.Save(PCWSTR(filename.as_ptr()), true)?;
        SHChangeNotify(
            SHCNE_UPDATEITEM,
            SHCNF_PATHW,
            Some(filename.as_ptr().cast()),
            None,
        );
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWMINNOACTIVE;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "ccgui-shortcuts-{}-{}-中文 空格😀",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(dunce::canonicalize(path).unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn create(path: &Path, target: &Path, cwd: &Path) {
        unsafe {
            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            link.SetPath(PCWSTR(wide(target).as_ptr())).unwrap();
            link.SetIconLocation(PCWSTR(wide(target).as_ptr()), 7)
                .unwrap();
            link.SetWorkingDirectory(PCWSTR(wide(cwd).as_ptr()))
                .unwrap();
            link.SetArguments(PCWSTR(
                wide(Path::new("--profile \"中文 😀\" --flag")).as_ptr(),
            ))
            .unwrap();
            link.SetDescription(PCWSTR(wide(Path::new("保留 description 😀")).as_ptr()))
                .unwrap();
            link.SetHotkey(0x0241).unwrap();
            // IShellLink only persists NORMAL, MAXIMIZED and MINNOACTIVE.
            // https://learn.microsoft.com/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishelllinkw-setshowcmd
            link.SetShowCmd(SW_SHOWMINNOACTIVE).unwrap();
            link.cast::<IPersistFile>()
                .unwrap()
                .Save(PCWSTR(wide(path).as_ptr()), true)
                .unwrap();
            assert_eq!(
                load_link(path).unwrap().0.GetShowCmd().unwrap(),
                SW_SHOWMINNOACTIVE
            );
        }
    }
    fn read(link: &IShellLinkW, field: &str) -> PathBuf {
        let mut value = vec![0; 32768];
        unsafe {
            match field {
                "target" => link
                    .GetPath(&mut value, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
                    .unwrap(),
                "cwd" => link.GetWorkingDirectory(&mut value).unwrap(),
                "args" => link.GetArguments(&mut value).unwrap(),
                "description" => link.GetDescription(&mut value).unwrap(),
                _ => panic!("unknown field"),
            }
        }
        buffer_path(&value)
    }

    #[test]
    fn deleted_release_migrates_preserving_properties_and_is_idempotent() {
        let _com = Apartment::new().unwrap();
        let fixture = Fixture::new();
        let installed = fixture.0.join("安装 稳定😀.exe");
        std::fs::write(&installed, b"fixture").unwrap();
        let releases = fixture.0.join("profile/runtime-updates/releases");
        let old = releases.join("a".repeat(64)).join("ccgui-next.exe");
        let path = fixture.0.join("旧快捷方式.lnk");
        create(&path, &old, old.parent().unwrap());
        assert!(!old.exists());
        assert!(repair_link(&path, &installed, &releases).unwrap());
        let (link, _) = load_link(&path).unwrap();
        assert_eq!(normalized(&read(&link, "target")), normalized(&installed));
        assert_eq!(read(&link, "cwd"), fixture.0);
        assert_eq!(
            read(&link, "args"),
            PathBuf::from("--profile \"中文 😀\" --flag")
        );
        assert_eq!(
            read(&link, "description"),
            PathBuf::from("保留 description 😀")
        );
        unsafe {
            assert_eq!(link.GetHotkey().unwrap(), 0x0241);
            assert_eq!(link.GetShowCmd().unwrap(), SW_SHOWMINNOACTIVE);
            let mut icon = vec![0; 32768];
            let mut index = -1;
            link.GetIconLocation(&mut icon, &mut index).unwrap();
            assert_eq!(normalized(&buffer_path(&icon)), normalized(&installed));
            assert_eq!(index, 0);
        }
        drop(link);
        let bytes = std::fs::read(&path).unwrap();
        for hash in ['b', 'a'] {
            // Forward update and rollback cannot repin a repaired shortcut.
            std::fs::create_dir_all(releases.join(hash.to_string().repeat(64))).unwrap();
            assert!(!repair_link(&path, &installed, &releases).unwrap());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn custom_cwd_missing_launcher_and_unrelated_links_are_preserved() {
        let _com = Apartment::new().unwrap();
        let fixture = Fixture::new();
        let installed = fixture.0.join("stable.exe");
        let releases = fixture.0.join("profile/runtime-updates/releases");
        let old = releases.join("b".repeat(64)).join("ccgui-next.exe");
        let path = fixture.0.join("custom.lnk");
        create(&path, &old, &fixture.0);
        let bytes = std::fs::read(&path).unwrap();
        assert!(!repair_link(&path, &installed, &releases).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::write(&installed, b"fixture").unwrap();
        assert!(repair_link(&path, &installed, &releases).unwrap());
        assert_eq!(read(&load_link(&path).unwrap().0, "cwd"), fixture.0);
        for target in [
            fixture.0.join("other.exe"),
            fixture
                .0
                .join("other-profile/runtime-updates/releases")
                .join("a".repeat(64))
                .join("ccgui-next.exe"),
            releases.join("g".repeat(64)).join("ccgui-next.exe"),
            releases.join("a".repeat(63)).join("ccgui-next.exe"),
            releases.join("a".repeat(64)).join("nested/ccgui-next.exe"),
            releases.join("a".repeat(64)).join("other.exe"),
        ] {
            create(&path, &target, &fixture.0);
            let bytes = std::fs::read(&path).unwrap();
            assert!(!repair_link(&path, &installed, &releases).unwrap());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn installed_target_repairs_only_release_icon_and_readonly_unrelated_link_is_readable() {
        let _com = Apartment::new().unwrap();
        let fixture = Fixture::new();
        let installed = fixture.0.join("stable.exe");
        std::fs::write(&installed, b"fixture").unwrap();
        let releases = fixture.0.join("runtime-updates/releases");
        let old = releases.join("d".repeat(64)).join("ccgui-next.exe");
        let path = fixture.0.join("icon.lnk");
        create(&path, &installed, &fixture.0);
        let set_icon = |icon: &Path| {
            let (link, persist) = load_link(&path).unwrap();
            unsafe {
                link.SetIconLocation(PCWSTR(wide(icon).as_ptr()), 7)
                    .unwrap();
                persist.Save(PCWSTR(wide(&path).as_ptr()), true).unwrap();
            }
        };
        set_icon(&old);
        assert!(repair_link(&path, &installed, &releases).unwrap());
        let (link, _) = load_link(&path).unwrap();
        assert_eq!(normalized(&read(&link, "target")), normalized(&installed));
        assert_eq!(read(&link, "cwd"), fixture.0);
        assert_eq!(
            read(&link, "args"),
            PathBuf::from("--profile \"中文 😀\" --flag")
        );
        assert_eq!(
            read(&link, "description"),
            PathBuf::from("保留 description 😀")
        );
        unsafe {
            let mut icon = vec![0; 32768];
            let mut index = -1;
            link.GetIconLocation(&mut icon, &mut index).unwrap();
            assert_eq!(normalized(&buffer_path(&icon)), normalized(&installed));
            assert_eq!(index, 0);
            assert_eq!(link.GetHotkey().unwrap(), 0x0241);
            assert_eq!(link.GetShowCmd().unwrap(), SW_SHOWMINNOACTIVE);
        }
        drop(link);
        assert!(!repair_link(&path, &installed, &releases).unwrap());
        set_icon(&fixture.0.join("custom.ico"));
        let bytes = std::fs::read(&path).unwrap();
        assert!(!repair_link(&path, &installed, &releases).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        create(&path, &fixture.0.join("unrelated.exe"), &fixture.0);
        set_icon(&old);
        let bytes = std::fs::read(&path).unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions.clone()).unwrap();
        let result = repair_link(&path, &installed, &releases);
        permissions.set_readonly(false);
        std::fs::set_permissions(&path, permissions).unwrap();
        assert!(!result.unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn installed_target_repairs_release_cwd_without_replacing_custom_icon() {
        let _com = Apartment::new().unwrap();
        let fixture = Fixture::new();
        let installed = fixture.0.join("stable.exe");
        std::fs::write(&installed, b"fixture").unwrap();
        let releases = fixture.0.join("runtime-updates/releases");
        let old = releases.join("e".repeat(64)).join("ccgui-next.exe");
        let path = fixture.0.join("cwd.lnk");
        create(&path, &installed, old.parent().unwrap());
        let custom_icon = fixture.0.join("custom.ico");
        {
            let (link, persist) = load_link(&path).unwrap();
            unsafe {
                link.SetIconLocation(PCWSTR(wide(&custom_icon).as_ptr()), 3)
                    .unwrap();
                persist.Save(PCWSTR(wide(&path).as_ptr()), true).unwrap();
            }
        }
        assert!(repair_link(&path, &installed, &releases).unwrap());
        let (link, _) = load_link(&path).unwrap();
        assert_eq!(normalized(&read(&link, "target")), normalized(&installed));
        assert_eq!(read(&link, "cwd"), fixture.0);
        unsafe {
            let mut icon = vec![0; 32768];
            let mut index = -1;
            link.GetIconLocation(&mut icon, &mut index).unwrap();
            assert_eq!(buffer_path(&icon), custom_icon);
            assert_eq!(index, 3);
        }
        drop(link);
        assert!(!repair_link(&path, &installed, &releases).unwrap());
    }

    #[test]
    fn scan_respects_recursion_and_continues_after_corrupt_link() {
        let _com = Apartment::new().unwrap();
        let fixture = Fixture::new();
        let installed = fixture.0.join("stable.exe");
        std::fs::write(&installed, b"fixture").unwrap();
        let releases = fixture.0.join("runtime-updates/releases");
        let old = releases.join("c".repeat(64)).join("ccgui-next.exe");
        let desktop = fixture.0.join("desktop");
        let programs = fixture.0.join("programs");
        std::fs::create_dir_all(desktop.join("nested")).unwrap();
        std::fs::create_dir_all(programs.join("nested")).unwrap();
        let desktop_link = desktop.join("valid.lnk");
        let ignored = desktop.join("nested/ignored.lnk");
        let program_link = programs.join("nested/valid.lnk");
        for path in [&desktop_link, &ignored, &program_link] {
            create(path, &old, old.parent().unwrap());
        }
        std::fs::write(desktop.join("broken.lnk"), b"not a shortcut").unwrap();
        let mut stats = ScanStats::default();
        scan(
            &[(desktop, false), (programs, true)],
            &installed,
            &releases,
            &mut stats,
        );
        assert_eq!(stats.changed, 2);
        assert_eq!(stats.errors, 1);
        assert!(!stats.limited);
        assert_eq!(
            normalized(&read(&load_link(&ignored).unwrap().0, "target")),
            normalized(&old)
        );
        for path in [&desktop_link, &program_link] {
            assert_eq!(
                normalized(&read(&load_link(path).unwrap().0, "target")),
                normalized(&installed)
            );
        }
    }
}
