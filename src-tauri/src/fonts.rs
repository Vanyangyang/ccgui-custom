//! Uploaded font files for the 设置 → 外观 font rows (界面字体 / 代码字体).
//!
//! The webview cannot read the file picked through the native dialog, so the
//! frontend asks this command for the bytes and registers them with the
//! FontFace API. Bytes travel base64-encoded because the web bridge speaks
//! JSON (`src-tauri/src/web.rs`).
//!
//! Only real font files pass: the dialog filter is a UX hint, not a
//! guarantee, and a renamed/renamed-extension file must fail here with a
//! stable code instead of surfacing as a CSS face parse error far from the
//! picker.

use std::path::Path;

use base64::Engine as _;

/// Ceiling for one font file. Large CJK families with several weights reach
/// ~30 MB; past this is a mistake (or not a font), and the value crosses IPC
/// twice (read + base64) before the webview even parses it.
const MAX_FONT_BYTES: u64 = 64 * 1024 * 1024;

/// SFNT / TrueType / OpenType collections plus the WOFF containers. The
/// first four bytes are the format tag, so a wrong extension cannot sneak a
/// non-font through.
const FONT_MAGICS: [&[u8; 4]; 7] = [
    b"\x00\x01\x00\x00", // TrueType outlines (also variable fonts)
    b"\x00\x00\x01\x00", // Apple's legacy TrueType tag
    b"OTTO",             // CFF-based OpenType
    b"ttcf",             // TrueType / OpenType collection
    b"true",             // legacy Apple TrueType
    b"wOFF",             // WOFF
    b"wOF2",             // WOFF2
];

/// Read one uploaded font file, base64-encoded (read_font_file →
/// `ipc.readFontFile`). Errors are stable codes localized by the settings
/// page (`FONT_ERROR_KEYS` in src/features/settings/font.ts).
#[tauri::command]
pub fn read_font_file(path: String) -> Result<String, String> {
    let file = Path::new(&path);
    let meta = std::fs::metadata(file).map_err(|_| "font.err.read_failed".to_string())?;
    if !meta.is_file() {
        return Err("font.err.read_failed".to_string());
    }
    if meta.len() > MAX_FONT_BYTES {
        return Err("font.err.too_large".to_string());
    }
    let bytes = std::fs::read(file).map_err(|_| "font.err.read_failed".to_string())?;
    if !looks_like_font(&bytes) {
        return Err("font.err.unsupported".to_string());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn looks_like_font(bytes: &[u8]) -> bool {
    FONT_MAGICS.iter().any(|magic| bytes.starts_with(&magic[..]))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    /// Unique scratch file in the OS temp dir; removed on drop unless the
    /// test wants to inspect it first.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ccgui-font-test-{}-{}",
                std::process::id(),
                name
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir.join("font.bin"))
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            if let Some(parent) = self.0.parent() {
                let _ = std::fs::remove_dir_all(parent);
            }
        }
    }

    #[test]
    fn reads_a_real_font_header_as_base64() {
        let scratch = Scratch::new("read");
        let mut file = std::fs::File::create(&scratch.0).unwrap();
        file.write_all(b"\x00\x01\x00\x00").unwrap();
        file.write_all(&[0u8; 32]).unwrap();
        drop(file);
        let encoded = read_font_file(scratch.path()).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(decoded.len(), 36);
        assert_eq!(&decoded[..4], b"\x00\x01\x00\x00");
    }

    #[test]
    fn rejects_a_file_that_is_not_a_font() {
        let scratch = Scratch::new("text");
        std::fs::write(&scratch.0, b"plain text, not a font").unwrap();
        assert_eq!(
            read_font_file(scratch.path()).unwrap_err(),
            "font.err.unsupported"
        );
    }

    #[test]
    fn rejects_missing_files_with_a_stable_code() {
        let scratch = Scratch::new("missing");
        assert_eq!(
            read_font_file(scratch.path()).unwrap_err(),
            "font.err.read_failed"
        );
    }

    #[test]
    fn rejects_files_over_the_size_cap_before_reading() {
        let scratch = Scratch::new("large");
        // Sparse file: only the length is material, no bytes on disk.
        let file = std::fs::File::create(&scratch.0).unwrap();
        file.set_len(MAX_FONT_BYTES + 1).unwrap();
        drop(file);
        assert_eq!(
            read_font_file(scratch.path()).unwrap_err(),
            "font.err.too_large"
        );
    }

    #[test]
    fn woff_and_collection_magics_pass() {
        assert!(looks_like_font(b"wOF2rest"));
        assert!(looks_like_font(b"wOFFrest"));
        assert!(looks_like_font(b"ttcfrest"));
        assert!(looks_like_font(b"OTTOrest"));
        assert!(!looks_like_font(b"OT"));
    }
}
