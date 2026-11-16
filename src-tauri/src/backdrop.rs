//! Custom backdrop image reader for 设置 → 通用 → 对话背景.
//!
//! Reads a user-chosen raster image across arbitrary local drives/directories,
//! validates magic bytes and size limits, and returns base64 + canonical MIME
//! type so the frontend can safely render it as a Blob URL. SVG and HTML/script
//! payloads are rejected.

use std::path::Path;

use base64::Engine as _;

const MAX_BACKDROP_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackdropImageData {
    pub mime: String,
    pub data_base64: String,
}

fn detect_raster_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis")
    {
        return Some("image/avif");
    }
    None
}

/// Read one user-picked raster backdrop image after checking size & magic bytes.
#[tauri::command]
pub fn read_backdrop_image(path: String) -> Result<BackdropImageData, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| matches!(c, '\0' | '\r' | '\n')) {
        return Err("backdrop.err.read_failed".to_string());
    }
    let file = Path::new(trimmed);
    let meta = std::fs::metadata(file).map_err(|_| "backdrop.err.read_failed".to_string())?;
    if !meta.is_file() {
        return Err("backdrop.err.read_failed".to_string());
    }
    if meta.len() > MAX_BACKDROP_IMAGE_BYTES {
        return Err("backdrop.err.too_large".to_string());
    }
    let bytes = std::fs::read(file).map_err(|_| "backdrop.err.read_failed".to_string())?;
    let Some(mime) = detect_raster_mime(&bytes) else {
        return Err("backdrop.err.unsupported".to_string());
    };
    Ok(BackdropImageData {
        mime: mime.to_string(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(name: &str, filename: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ccgui-backdrop-test-{}-{}",
                std::process::id(),
                name
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir.join(filename))
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
    fn reads_valid_png_and_webp_with_detected_mime() {
        let png = Scratch::new("png", "bg.png");
        let mut png_bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        png_bytes.extend_from_slice(&[1, 2, 3, 4]);
        std::fs::write(&png.0, &png_bytes).unwrap();
        let data = read_backdrop_image(png.path()).unwrap();
        assert_eq!(data.mime, "image/png");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data.data_base64)
            .unwrap();
        assert_eq!(decoded, png_bytes);

        let webp = Scratch::new("webp", "bg.webp");
        let mut webp_bytes = b"RIFF\x12\x00\x00\x00WEBP".to_vec();
        webp_bytes.extend_from_slice(b"VP8 ");
        std::fs::write(&webp.0, &webp_bytes).unwrap();
        let data = read_backdrop_image(webp.path()).unwrap();
        assert_eq!(data.mime, "image/webp");
    }

    #[test]
    fn rejects_svg_and_spoofed_text_extensions() {
        let svg = Scratch::new("svg", "evil.png");
        std::fs::write(&svg.0, b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").unwrap();
        assert_eq!(
            read_backdrop_image(svg.path()).unwrap_err(),
            "backdrop.err.unsupported"
        );

        let spoof = Scratch::new("spoof", "fake.jpg");
        std::fs::write(&spoof.0, b"not an image").unwrap();
        assert_eq!(
            read_backdrop_image(spoof.path()).unwrap_err(),
            "backdrop.err.unsupported"
        );
    }

    #[test]
    fn rejects_missing_and_oversized_files() {
        let missing = Scratch::new("missing", "absent.png");
        assert_eq!(
            read_backdrop_image(missing.path()).unwrap_err(),
            "backdrop.err.read_failed"
        );

        let large = Scratch::new("large", "huge.png");
        let file = std::fs::File::create(&large.0).unwrap();
        file.set_len(MAX_BACKDROP_IMAGE_BYTES + 1).unwrap();
        drop(file);
        assert_eq!(
            read_backdrop_image(large.path()).unwrap_err(),
            "backdrop.err.too_large"
        );
    }
}
