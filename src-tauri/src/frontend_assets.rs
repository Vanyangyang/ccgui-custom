//! Immutable, verified frontend assets for a retained self-update release.
//!
//! The profile's content-addressed release directory supplies the expected
//! manifest digest. This is local integrity, not a publisher signature. There
//! is deliberately no environment/path override or embedded fallback.

use crate::live_update::{self, Limits, ReleaseFile, ReleaseManifest};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{borrow::Cow, collections::BTreeMap, path::Path};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};

const SIDECAR: &str = "frontend-manifest.json";
const MAX_FRONTEND_BYTES: u64 = 128 * 1024 * 1024;
const MAX_FRONTEND_FILES: usize = 4096;
const MAX_SIDECAR_BYTES: u64 = 4096;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrontendManifest {
    format_version: u32,
    native_fingerprint: String,
}

/// Compile-time information only: the worker probe must not inspect a profile.
pub(crate) fn compiled_fingerprint() -> Option<&'static str> {
    option_env!("CCGUI_FRONTEND_FINGERPRINT")
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

#[derive(Debug)]
struct Snapshot {
    version: String,
    files: BTreeMap<String, Vec<u8>>,
}

impl<R: tauri::Runtime> tauri::Assets<R> for Snapshot {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        self.files
            .get(key.as_ref())
            .map(|bytes| Cow::Borrowed(bytes.as_slice()))
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(
            self.files
                .iter()
                .map(|(key, bytes)| (Cow::Borrowed(key.as_str()), Cow::Borrowed(bytes.as_slice()))),
        )
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

fn read_verified(root: &Path, file: &ReleaseFile, limit: u64) -> Result<Vec<u8>, String> {
    if file.bytes > limit {
        return Err("frontend file exceeds limit".into());
    }
    let path = root.join(&file.path);
    let parent = path.parent().ok_or("frontend file parent missing")?;
    live_update::checked_directory(parent)?;
    let bytes = live_update::bounded_read(&path, file.bytes)?;
    // Recheck directory/link metadata after the read; digest verification is
    // against the same bytes retained in memory, never a previous disk read.
    live_update::checked_directory(parent)?;
    let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("frontend reparse points are forbidden".into());
        }
    }
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != file.bytes
        || bytes.len() as u64 != file.bytes
        || format!("{:x}", Sha256::digest(&bytes)) != file.sha256
    {
        return Err("frontend file changed or failed SHA256 verification".into());
    }
    Ok(bytes)
}

fn frontend_manifest(
    root: &Path,
    manifest: &ReleaseManifest,
) -> Result<Option<FrontendManifest>, String> {
    let sidecar = manifest.files.iter().find(|file| file.path == SIDECAR);
    let entries: Vec<_> = manifest
        .files
        .iter()
        .filter(|file| file.path.starts_with("frontend/"))
        .collect();
    let Some(sidecar) = sidecar else {
        if !entries.is_empty() {
            return Err("frontend assets require a frontend manifest".into());
        }
        return Ok(None);
    };
    if entries.is_empty()
        || entries.len() > MAX_FRONTEND_FILES
        || !entries
            .iter()
            .any(|file| file.path == "frontend/index.html")
        || !entries
            .iter()
            .any(|file| file.path == "frontend/cursor.html")
    {
        return Err("frontend entry points missing or file count exceeds limit".into());
    }
    let total = entries
        .iter()
        .try_fold(0u64, |sum, file| sum.checked_add(file.bytes))
        .ok_or("frontend size overflow")?;
    if total > MAX_FRONTEND_BYTES {
        return Err("frontend total bytes exceeds limit".into());
    }
    let bytes = read_verified(root, sidecar, MAX_SIDECAR_BYTES)?;
    let sidecar: FrontendManifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid frontend manifest: {e}"))?;
    if sidecar.format_version != 1 || !valid_hash(&sidecar.native_fingerprint) {
        return Err("unsupported frontend manifest metadata".into());
    }
    Ok(Some(sidecar))
}

pub(crate) fn validate_candidate(
    root: &Path,
    hash: &str,
    probe: &serde_json::Value,
) -> Result<(), String> {
    let manifest = live_update::verify_manifest(root, hash, Limits::default())?;
    let sidecar = frontend_manifest(root, &manifest)?;
    let capabilities = &probe["capabilities"];
    match sidecar {
        Some(sidecar) => {
            if capabilities["frontendAssets"] != 1
                || capabilities["frontendFingerprint"].as_str()
                    != Some(sidecar.native_fingerprint.as_str())
            {
                return Err("Candidate frontend assets differ from its native fingerprint".into());
            }
        }
        None if !capabilities["frontendFingerprint"].is_null() => {
            return Err("Candidate native binary requires missing frontend assets".into());
        }
        None => (), // Legacy embedded binaries have no frontend capability.
    }
    Ok(())
}

fn load_snapshot(root: &Path, hash: &str, fingerprint: &str) -> Result<Snapshot, String> {
    if !valid_hash(fingerprint) {
        return Err("invalid compiled frontend fingerprint".into());
    }
    let manifest = live_update::verify_manifest(root, hash, Limits::default())?;
    let sidecar =
        frontend_manifest(root, &manifest)?.ok_or("required frontend manifest missing")?;
    if sidecar.native_fingerprint != fingerprint {
        return Err("frontend/native fingerprint mismatch".into());
    }
    let mut files = BTreeMap::new();
    for file in &manifest.files {
        if let Some(key) = file.path.strip_prefix("frontend/") {
            files.insert(
                format!("/{key}"),
                read_verified(root, file, MAX_FRONTEND_BYTES)?,
            );
        }
    }
    Ok(Snapshot {
        version: manifest.version,
        files,
    })
}

fn release_location(
    profile: &Path,
    executable: &Path,
) -> Result<(std::path::PathBuf, String), String> {
    let directory = executable
        .parent()
        .ok_or("frontend executable directory missing")?;
    live_update::checked_directory(directory)?;
    let hash = directory
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|hash| valid_hash(hash))
        .ok_or("external frontend requires a staged release directory")?;
    let expected = profile
        .join("runtime-updates/releases")
        .join(hash)
        .join("ccgui-next.exe");
    live_update::checked_directory(expected.parent().unwrap())?;
    let actual = std::fs::canonicalize(executable)
        .map_err(|e| format!("resolve frontend executable: {e}"))?;
    let expected =
        std::fs::canonicalize(expected).map_err(|e| format!("resolve staged executable: {e}"))?;
    if actual != expected
        || executable.file_name().and_then(|name| name.to_str()) != Some("ccgui-next.exe")
    {
        return Err(
            "external frontend executable is outside this profile's staged releases".into(),
        );
    }
    Ok((directory.to_path_buf(), hash.to_owned()))
}

fn install<R: tauri::Runtime>(
    context: &mut tauri::Context<R>,
    snapshot: Snapshot,
) -> Result<(), String> {
    let version = snapshot
        .version
        .parse()
        .map_err(|_| "frontend release version is not semver")?;
    context.config_mut().version = Some(snapshot.version.clone());
    context.package_info_mut().version = version;
    // Even a development native build must never bypass verification via devUrl.
    context.config_mut().build.dev_url = None;
    // FrontendDist::Url takes precedence over App URLs even with custom assets.
    // The verified snapshot is the sole page source, including when a Windows
    // absolute build path was parsed as file:// by an older build script.
    context.config_mut().build.frontend_dist = None;
    context.set_assets(Box::new(snapshot));
    Ok(())
}

pub(crate) fn configure<R: tauri::Runtime>(context: &mut tauri::Context<R>) -> Result<(), String> {
    let Some(fingerprint) = compiled_fingerprint() else {
        return Ok(());
    };
    let executable =
        std::env::current_exe().map_err(|e| format!("resolve frontend executable: {e}"))?;
    let (root, hash) = release_location(&crate::paths::app_home(), &executable)?;
    install(context, load_snapshot(&root, &hash, fingerprint)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, path::PathBuf};
    use tauri::Assets;

    const FINGERPRINT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct Fixture {
        profile: PathBuf,
        root: PathBuf,
        hash: String,
        manifest: ReleaseManifest,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.profile);
        }
    }
    impl Fixture {
        fn new(external: bool) -> Self {
            let profile =
                std::env::temp_dir().join(format!("ccgui-frontend-{}", uuid::Uuid::new_v4()));
            let root = profile.join("package");
            fs::create_dir_all(&root).unwrap();
            let mut contents = vec![("ccgui-next.exe", b"native fixture".to_vec())];
            if external {
                contents.extend([
                    (
                        SIDECAR,
                        serde_json::to_vec(
                            &json!({"formatVersion":1,"nativeFingerprint":FINGERPRINT}),
                        )
                        .unwrap(),
                    ),
                    ("frontend/index.html", b"<html>new frontend</html>".to_vec()),
                    ("frontend/cursor.html", b"<html>cursor</html>".to_vec()),
                    ("frontend/assets/main.js", b"new javascript".to_vec()),
                ]);
            }
            let files = contents
                .into_iter()
                .map(|(path, bytes)| {
                    fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
                    fs::write(root.join(path), &bytes).unwrap();
                    ReleaseFile {
                        path: path.into(),
                        bytes: bytes.len() as u64,
                        sha256: format!("{:x}", Sha256::digest(&bytes)),
                    }
                })
                .collect();
            let manifest = ReleaseManifest {
                manifest_version: 1,
                channel: "protected-custom".into(),
                release_id: "frontend-test".into(),
                version: "1.1.1+protected.33".into(),
                worker_protocol: 1,
                checkpoint_schema: 1,
                schema_hash: "b".repeat(64),
                executable: "ccgui-next.exe".into(),
                files,
            };
            let mut fixture = Self {
                profile,
                root,
                hash: String::new(),
                manifest,
            };
            fixture.write_manifest();
            fixture
        }
        fn write_manifest(&mut self) {
            let bytes = serde_json::to_vec(&self.manifest).unwrap();
            self.hash = format!("{:x}", Sha256::digest(&bytes));
            fs::write(self.root.join("manifest.json"), bytes).unwrap();
        }
        fn replace(&mut self, path: &str, bytes: &[u8]) {
            fs::write(self.root.join(path), bytes).unwrap();
            let file = self
                .manifest
                .files
                .iter_mut()
                .find(|file| file.path == path)
                .unwrap();
            file.bytes = bytes.len() as u64;
            file.sha256 = format!("{:x}", Sha256::digest(bytes));
            self.write_manifest();
        }
        fn snapshot(&self) -> Result<Snapshot, String> {
            load_snapshot(&self.root, &self.hash, FINGERPRINT)
        }
    }

    #[test]
    fn embedded_candidate_compatibility_and_required_external_assets() {
        let fixture = Fixture::new(false);
        assert!(
            validate_candidate(&fixture.root, &fixture.hash, &json!({"capabilities":{}})).is_ok()
        );
        assert!(validate_candidate(
            &fixture.root,
            &fixture.hash,
            &json!({"capabilities":{"frontendAssets":1,"frontendFingerprint":null}})
        )
        .is_ok());
        assert!(validate_candidate(
            &fixture.root,
            &fixture.hash,
            &json!({"capabilities":{"frontendFingerprint":FINGERPRINT}})
        )
        .is_err());
        assert!(fixture.snapshot().unwrap_err().contains("manifest missing"));
        if compiled_fingerprint().is_none() {
            let mut context = tauri::test::mock_context::<tauri::test::MockRuntime, _>(
                tauri::test::noop_assets(),
            );
            let previous = context.package_info().version.clone();
            configure(&mut context).unwrap();
            assert_eq!(context.package_info().version, previous);
            assert_eq!(context.assets().iter().count(), 0);
        }
    }

    #[test]
    fn snapshot_is_immutable_and_shared_by_tauri_and_web_asset_resolver() {
        let fixture = Fixture::new(true);
        let snapshot = fixture.snapshot().unwrap();
        fs::write(
            fixture.root.join("frontend/index.html"),
            b"mutated after validation",
        )
        .unwrap();
        assert_eq!(
            <Snapshot as Assets<tauri::test::MockRuntime>>::get(
                &snapshot,
                &AssetKey::from("index.html")
            )
            .unwrap()
            .as_ref(),
            b"<html>new frontend</html>"
        );
        assert!(<Snapshot as Assets<tauri::test::MockRuntime>>::get(
            &snapshot,
            &AssetKey::from("missing.html")
        )
        .is_none());
        let mut context =
            tauri::test::mock_context::<tauri::test::MockRuntime, _>(tauri::test::noop_assets());
        context.config_mut().build.dev_url = Some("http://localhost:1420".parse().unwrap());
        context.config_mut().build.frontend_dist = Some(tauri::utils::config::FrontendDist::Url("file:///C:/fixture/shell/".parse().unwrap()));
        let security = serde_json::to_value(&context.config().app.security).unwrap();
        install(&mut context, snapshot).unwrap();
        assert_eq!(
            context.package_info().version.to_string(),
            fixture.manifest.version
        );
        assert_eq!(
            context.config().version.as_deref(),
            Some(fixture.manifest.version.as_str())
        );
        assert!(context.config().build.dev_url.is_none());
        assert!(context.config().build.frontend_dist.is_none());
        assert_eq!(
            serde_json::to_value(&context.config().app.security).unwrap(),
            security
        );
        assert_eq!(context.assets().iter().count(), 3);
        assert_eq!(
            context
                .assets()
                .csp_hashes(&AssetKey::from("index.html"))
                .count(),
            0
        );
        let app = tauri::test::mock_builder().build(context).unwrap();
        assert_eq!(
            app.package_info().version.to_string(),
            fixture.manifest.version
        );
        let web_asset = app.asset_resolver().get("index.html".into()).unwrap();
        assert!(String::from_utf8_lossy(&web_asset.bytes).contains("new frontend"));
        assert_eq!(
            app.asset_resolver()
                .get("assets/main.js".into())
                .unwrap()
                .bytes,
            b"new javascript"
        );
    }

    #[test]
    fn independent_manifest_hash_native_fingerprint_and_probe_must_match() {
        let fixture = Fixture::new(true);
        assert!(load_snapshot(&fixture.root, &"0".repeat(64), FINGERPRINT)
            .unwrap_err()
            .contains("SHA256"));
        assert!(load_snapshot(&fixture.root, &fixture.hash, &"b".repeat(64))
            .unwrap_err()
            .contains("fingerprint mismatch"));
        assert!(load_snapshot(&fixture.root, &fixture.hash, "INVALID").is_err());
        let valid = json!({"capabilities":{"frontendAssets":1,"frontendFingerprint":FINGERPRINT}});
        validate_candidate(&fixture.root, &fixture.hash, &valid).unwrap();
        for invalid in [
            json!({}),
            json!({"frontendAssets":true,"frontendFingerprint":FINGERPRINT}),
            json!({"frontendAssets":1,"frontendFingerprint":"b".repeat(64)}),
            json!({"frontendAssets":1,"frontendFingerprint":null}),
        ] {
            assert!(validate_candidate(
                &fixture.root,
                &fixture.hash,
                &json!({"capabilities":invalid})
            )
            .is_err());
        }
    }

    #[test]
    fn missing_corrupt_undeclared_and_traversing_assets_are_rejected() {
        let mut fixture = Fixture::new(true);
        fs::remove_file(fixture.root.join("frontend/cursor.html")).unwrap();
        assert!(fixture.snapshot().is_err());
        fs::write(
            fixture.root.join("frontend/cursor.html"),
            b"<html>cursor</html>",
        )
        .unwrap();
        fs::write(
            fixture.root.join("frontend/assets/main.js"),
            b"bad javascript",
        )
        .unwrap();
        assert!(fixture.snapshot().is_err());
        fixture.replace("frontend/assets/main.js", b"new javascript");
        fs::write(fixture.root.join("frontend/undeclared.js"), b"extra").unwrap();
        assert!(fixture.snapshot().is_err());
        fs::remove_file(fixture.root.join("frontend/undeclared.js")).unwrap();
        fixture.manifest.files.last_mut().unwrap().path = "frontend/../outside.js".into();
        fixture.write_manifest();
        assert!(fixture.snapshot().unwrap_err().contains("path"));
    }

    #[test]
    fn sidecar_is_strict_and_frontend_entries_are_mandatory() {
        let mut fixture = Fixture::new(true);
        for value in [
            json!({"formatVersion":2,"nativeFingerprint":FINGERPRINT}),
            json!({"formatVersion":1,"nativeFingerprint":FINGERPRINT,"unknown":true}),
            json!({"formatVersion":1,"nativeFingerprint":"A".repeat(64)}),
        ] {
            fixture.replace(SIDECAR, &serde_json::to_vec(&value).unwrap());
            assert!(fixture.snapshot().is_err());
        }
        fixture.replace(
            SIDECAR,
            &serde_json::to_vec(&json!({"formatVersion":1,"nativeFingerprint":FINGERPRINT}))
                .unwrap(),
        );
        fixture
            .manifest
            .files
            .retain(|file| file.path != "frontend/cursor.html");
        fs::remove_file(fixture.root.join("frontend/cursor.html")).unwrap();
        fixture.write_manifest();
        assert!(fixture.snapshot().unwrap_err().contains("entry points"));
        fixture.manifest.files.retain(|file| file.path != SIDECAR);
        fs::remove_file(fixture.root.join(SIDECAR)).unwrap();
        fixture.write_manifest();
        assert!(fixture
            .snapshot()
            .unwrap_err()
            .contains("require a frontend manifest"));
    }

    #[test]
    fn snapshot_memory_and_file_limits_are_checked_before_allocation() {
        let fixture = Fixture::new(true);
        let mut manifest = fixture.manifest.clone();
        manifest
            .files
            .iter_mut()
            .find(|file| file.path == "frontend/index.html")
            .unwrap()
            .bytes = MAX_FRONTEND_BYTES;
        assert!(frontend_manifest(&fixture.root, &manifest)
            .unwrap_err()
            .contains("total bytes"));
        let mut manifest = fixture.manifest.clone();
        for i in 0..MAX_FRONTEND_FILES {
            manifest.files.push(ReleaseFile {
                path: format!("frontend/{i}.js"),
                bytes: 0,
                sha256: FINGERPRINT.into(),
            });
        }
        assert!(frontend_manifest(&fixture.root, &manifest)
            .unwrap_err()
            .contains("file count"));
        let mut manifest = fixture.manifest.clone();
        manifest
            .files
            .iter_mut()
            .find(|file| file.path == SIDECAR)
            .unwrap()
            .bytes = MAX_SIDECAR_BYTES + 1;
        assert!(frontend_manifest(&fixture.root, &manifest)
            .unwrap_err()
            .contains("limit"));
    }

    #[test]
    fn only_current_profiles_content_addressed_release_is_accepted() {
        let mut fixture = Fixture::new(true);
        assert!(release_location(&fixture.profile, &fixture.root.join("ccgui-next.exe")).is_err());
        let staged = fixture
            .profile
            .join("runtime-updates/releases")
            .join(&fixture.hash);
        fs::create_dir_all(staged.parent().unwrap()).unwrap();
        fs::rename(&fixture.root, &staged).unwrap();
        fixture.root = staged;
        assert_eq!(
            release_location(&fixture.profile, &fixture.root.join("ccgui-next.exe"))
                .unwrap()
                .1,
            fixture.hash
        );
        assert!(release_location(
            &fixture.profile.join("other-profile"),
            &fixture.root.join("ccgui-next.exe")
        )
        .is_err());
        fs::rename(
            fixture.root.join("ccgui-next.exe"),
            fixture.root.join("other.exe"),
        )
        .unwrap();
        assert!(release_location(&fixture.profile, &fixture.root.join("other.exe")).is_err());
    }

    #[test]
    fn linked_frontend_directories_are_rejected() {
        let fixture = Fixture::new(true);
        let actual = fixture.profile.join("outside-assets");
        fs::rename(fixture.root.join("frontend"), &actual).unwrap();
        #[cfg(windows)]
        {
            // Junction creation exercises real reparse metadata without the
            // administrator/developer-mode privilege required by symlink_dir.
            let output = std::process::Command::new("cmd")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(fixture.root.join("frontend"))
                .arg(&actual)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "junction fixture failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&actual, fixture.root.join("frontend")).unwrap();
        assert!(fixture.snapshot().is_err());
    }
}
