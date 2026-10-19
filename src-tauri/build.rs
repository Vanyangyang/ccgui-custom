fn main() {
    println!("cargo:rerun-if-env-changed=CCGUI_FRONTEND_FINGERPRINT");
    if let Some(fingerprint) = std::env::var_os("CCGUI_FRONTEND_FINGERPRINT") {
        let fingerprint = fingerprint.to_str().expect("frontend fingerprint must be Unicode");
        assert!(
            fingerprint.len() == 64
                && fingerprint
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "CCGUI_FRONTEND_FINGERPRINT must be a lowercase SHA256"
        );
    }
    let manifest_dir = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by Cargo"),
    );
    if let Some(repo_root) = manifest_dir.parent() {
        let repo_str = repo_root.to_string_lossy();
        let is_snapshot =
            repo_str.contains("runtime-updates") || repo_str.contains("ccgui-self-update");
        if !is_snapshot
            && repo_root.join(".git").exists()
            && manifest_dir.join("tauri.conf.json").is_file()
        {
            let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
            if let Some(home) = home {
                let runtime_dir = std::path::PathBuf::from(home)
                    .join(".ccgui-next")
                    .join("runtime-updates");
                let _ = std::fs::create_dir_all(&runtime_dir);
                let _ = std::fs::write(
                    runtime_dir.join("default-source-root.txt"),
                    repo_root.to_string_lossy().as_bytes(),
                );
            }
        }
    }
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = manifest_dir.join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("failed to build Tauri resources");
}
