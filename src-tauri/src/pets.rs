//! Codex-compatible v2 pet packages.
//!
//! The host deliberately keeps the package contract small: a `pet.json` and
//! the declared spritesheet. Imported packages are copied into the app data
//! directory; the host does not ship a built-in character.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use image::ImageDecoder as _;
use serde::{Deserialize, Serialize};
const PETS_DIR: &str = "pets";
const MANIFEST_FILE: &str = "pet.json";
const ATLAS_WIDTH: u32 = 1536;
const ATLAS_HEIGHT: u32 = 2288;
/// pet.json is a tiny manifest; anything larger is rejected before parsing.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// A 1536x2288 lossless webp atlas is a few MiB at most; cap reads so a
/// hostile package cannot force huge buffered decodes.
const MAX_SPRITESHEET_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetManifest {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    pub sprite_version_number: u32,
    pub spritesheet_path: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSummary {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub sprite_version_number: u32,
    pub built_in: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPackage {
    #[serde(flatten)]
    pub summary: PetSummary,
    pub spritesheet_path: String,
    pub spritesheet_data_url: String,
    /// Number of non-empty cells in each atlas row, trimmed at the last
    /// non-transparent frame. Some valid Codex v2 rows use fewer than eight
    /// cells and must not animate into transparent padding.
    pub frame_counts: Vec<u8>,
}

fn summary(manifest: &PetManifest, built_in: bool) -> PetSummary {
    PetSummary {
        id: manifest.id.clone(),
        display_name: manifest.display_name.clone(),
        description: manifest.description.clone(),
        sprite_version_number: manifest.sprite_version_number,
        built_in,
    }
}

pub(crate) fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else { return false };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && (2..=64).contains(&id.len())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn read_manifest(path: &Path) -> Result<PetManifest, String> {
    let size = fs::metadata(path)
        .map_err(|e| format!("stat {}: {e}", path.display()))?
        .len();
    if size > MAX_MANIFEST_BYTES {
        return Err(format!(
            "pet manifest {} exceeds {} bytes",
            path.display(),
            MAX_MANIFEST_BYTES
        ));
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let manifest: PetManifest = serde_json::from_str(&content)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn validate_manifest(manifest: &PetManifest) -> Result<(), String> {
    if !valid_id(&manifest.id) {
        return Err(format!("invalid pet id: {}", manifest.id));
    }
    if manifest.display_name.trim().is_empty() {
        return Err("pet displayName must not be empty".to_string());
    }
    if manifest.sprite_version_number != 2 {
        return Err(format!(
            "unsupported spriteVersionNumber {}; expected 2",
            manifest.sprite_version_number
        ));
    }
    let path = Path::new(&manifest.spritesheet_path);
    if path.is_absolute()
        || path.components().any(|component| {
            // ParentDir covers ".."; RootDir/Prefix only parse on Windows
            // ("\\foo", "C:foo") and would let join() replace the target
            // path there — reject them explicitly instead of relying on the
            // canonicalize containment check alone.
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(..)
            )
        })
        || path.file_name().is_none()
    {
        return Err("spritesheetPath must be a relative file path inside the package".to_string());
    }
    Ok(())
}

fn imported_root() -> PathBuf {
    crate::paths::app_home().join(PETS_DIR)
}

fn package_dir(id: &str) -> Option<(PathBuf, bool)> {
    if !valid_id(id) {
        return None;
    }
    let imported = imported_root().join(id);
    imported.is_dir().then_some((imported, false))
}

fn package_metadata(root: &Path) -> Result<(PetManifest, PathBuf), String> {
    let manifest = read_manifest(&root.join(MANIFEST_FILE))?;
    let sprite = root.join(&manifest.spritesheet_path);
    let root_canonical = fs::canonicalize(root)
        .map_err(|e| format!("resolve package {}: {e}", root.display()))?;
    let sprite_canonical = fs::canonicalize(&sprite)
        .map_err(|e| format!("resolve spritesheet {}: {e}", sprite.display()))?;
    if !sprite_canonical.starts_with(&root_canonical) {
        return Err("spritesheetPath escapes the pet package".to_string());
    }
    if !sprite_canonical.is_file() {
        return Err(format!("spritesheet {} is not a file", sprite.display()));
    }
    Ok((manifest, sprite_canonical))
}

fn package_files(root: &Path) -> Result<(PetManifest, PathBuf, Vec<u8>), String> {
    let (manifest, sprite_canonical) = package_metadata(root)?;
    let frame_counts = validate_spritesheet(&sprite_canonical)?;
    Ok((manifest, sprite_canonical, frame_counts))
}

fn validate_spritesheet(path: &Path) -> Result<Vec<u8>, String> {
    let size = fs::metadata(path)
        .map_err(|e| format!("stat spritesheet {}: {e}", path.display()))?
        .len();
    if size > MAX_SPRITESHEET_BYTES {
        return Err(format!(
            "spritesheet {} exceeds {} bytes",
            path.display(),
            MAX_SPRITESHEET_BYTES
        ));
    }
    let reader = image::ImageReader::open(path)
        .map_err(|e| format!("open spritesheet {}: {e}", path.display()))?
        .with_guessed_format()
        .map_err(|e| format!("detect spritesheet format: {e}"))?;
    // Check the header dimensions before decoding: a hostile package could
    // otherwise force a multi-hundred-MiB RGBA allocation on the main
    // thread with a legal-but-huge image.
    let decoder = reader
        .into_decoder()
        .map_err(|e| format!("init spritesheet decoder: {e}"))?;
    let (width, height) = decoder.dimensions();
    if width != ATLAS_WIDTH || height != ATLAS_HEIGHT {
        return Err(format!(
            "v2 spritesheet must be {ATLAS_WIDTH}x{ATLAS_HEIGHT}, got {width}x{height}"
        ));
    }
    let image = image::DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("decode spritesheet {}: {e}", path.display()))?;
    if !image.color().has_alpha() {
        return Err("v2 spritesheet must contain an alpha channel".to_string());
    }
    let image = image.to_rgba8();
    let mut frame_counts = Vec::with_capacity(11);
    for row in 0..11u32 {
        let mut last_non_empty = 0u8;
        for column in 0..8u32 {
            let has_pixels = ((row * 208)..((row + 1) * 208)).any(|y| {
                ((column * 192)..((column + 1) * 192))
                    .any(|x| image.get_pixel(x, y).0[3] > 0)
            });
            if has_pixels {
                last_non_empty = (column + 1) as u8;
            }
        }
        frame_counts.push(last_non_empty.max(1));
    }
    Ok(frame_counts)
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "avif" => "image/avif",
        _ => "image/webp",
    }
}

fn list_from_root(root: &Path, built_in: bool) -> Vec<PetSummary> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    let mut rows = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            // Settings opens this list frequently.  Metadata/path checks are
            // enough for the picker; decode and validate the full atlas only
            // when the selected package is actually loaded.
            let (manifest, _) = package_metadata(&entry.path()).ok()?;
            Some(summary(&manifest, built_in))
        })
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    rows
}

#[tauri::command]
pub fn pet_list() -> Vec<PetSummary> {
    list_from_root(&imported_root(), false)
}

#[tauri::command]
pub fn pet_get_package(id: String) -> Result<PetPackage, String> {
    let (root, built_in) = package_dir(&id).ok_or_else(|| format!("pet not found: {id}"))?;
    let (manifest, sprite, frame_counts) = package_files(&root)?;
    let bytes = fs::read(&sprite).map_err(|e| format!("read {}: {e}", sprite.display()))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(PetPackage {
        summary: summary(&manifest, built_in),
        spritesheet_path: manifest.spritesheet_path,
        spritesheet_data_url: format!("data:{};base64,{encoded}", mime_for(&sprite)),
        frame_counts,
    })
}

#[tauri::command]
pub fn pet_import(path: String) -> Result<PetSummary, String> {
    let selected = PathBuf::from(path.trim());
    let source_root = if selected.is_file() {
        if selected.file_name().and_then(|name| name.to_str()) != Some(MANIFEST_FILE) {
            // Stable codes; the settings page maps them to localized text.
            return Err("pet.err.select_dir_or_manifest".to_string());
        }
        selected
            .parent()
            .ok_or_else(|| "pet.err.manifest_no_parent".to_string())?
            .to_path_buf()
    } else if selected.is_dir() {
        selected
    } else {
        return Err("pet.err.path_not_found".to_string());
    };
    let source_root = fs::canonicalize(&source_root)
        .map_err(|e| format!("resolve pet directory: {e}"))?;
    let (manifest, sprite, _) = package_files(&source_root)?;
    if package_dir(&manifest.id).is_some() {
        return Err("pet.err.duplicate_id".to_string());
    }
    let destination = imported_root().join(&manifest.id);
    fs::create_dir_all(&destination)
        .map_err(|e| format!("create {}: {e}", destination.display()))?;
    let result = (|| {
        fs::copy(source_root.join(MANIFEST_FILE), destination.join(MANIFEST_FILE))
            .map_err(|e| format!("copy pet.json: {e}"))?;
        let target_sprite = destination.join(&manifest.spritesheet_path);
        if let Some(parent) = target_sprite.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create sprite directory: {e}"))?;
        }
        fs::copy(sprite, target_sprite).map_err(|e| format!("copy spritesheet: {e}"))?;
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&destination);
        return Err(error);
    }
    Ok(summary(&manifest, false))
}

#[tauri::command]
pub fn pet_remove(id: String) -> Result<(), String> {
    let Some((root, _built_in)) = package_dir(&id) else {
        return Err(format!("pet not found: {id}"));
    };
    fs::remove_dir_all(root).map_err(|e| format!("remove pet {id}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_v2_ids_and_paths() {
        assert!(valid_id("codex-pet"));
        assert!(!valid_id("../damiao"));
        assert!(!valid_id("DaMiao"));
        let manifest = PetManifest {
            id: "codex-pet".to_string(),
            display_name: "大喵".to_string(),
            description: String::new(),
            sprite_version_number: 2,
            spritesheet_path: "spritesheet.webp".to_string(),
            extra: BTreeMap::new(),
        };
        assert!(validate_manifest(&manifest).is_ok());
        assert!(validate_manifest(&PetManifest {
            spritesheet_path: "../outside.webp".to_string(),
            ..manifest.clone()
        })
        .is_err());
        assert!(validate_manifest(&PetManifest {
            spritesheet_path: "/abs/outside.webp".to_string(),
            ..manifest
        })
        .is_err());
    }

    /// Windows-only component classes: "C:foo" parses with a Prefix and
    /// "\\foo" with a RootDir, and neither is caught by ParentDir.
    #[cfg(windows)]
    #[test]
    fn rejects_windows_prefix_and_root_components() {
        let manifest = PetManifest {
            id: "codex-pet".to_string(),
            display_name: "大喵".to_string(),
            description: String::new(),
            sprite_version_number: 2,
            spritesheet_path: "spritesheet.webp".to_string(),
            extra: BTreeMap::new(),
        };
        assert!(validate_manifest(&PetManifest {
            spritesheet_path: "C:evil.webp".to_string(),
            ..manifest.clone()
        })
        .is_err());
        assert!(validate_manifest(&PetManifest {
            spritesheet_path: "\\evil.webp".to_string(),
            ..manifest
        })
        .is_err());
    }

    #[test]
    fn package_list_has_no_built_in_source() {
        let rows = list_from_root(Path::new("this-directory-does-not-exist"), false);
        assert!(rows.is_empty());
    }
}
