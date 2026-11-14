//! Durable images for native task assignments. Public references identify
//! content; only the host reads the stored paths.
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_IMAGES: usize = 8;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const DIRECTORY: &str = "task-attachments";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskImage {
    pub source: String,
    pub path: String,
    pub sha256: String,
}

pub(super) fn capture(images: &[String], source_workspace: &str) -> Result<Vec<TaskImage>, String> {
    capture_in(
        &crate::engine::images::pasted_images_dir().join(DIRECTORY),
        images,
        Path::new(source_workspace),
    )
}

pub(super) fn paths(images: &[TaskImage]) -> Result<Option<Vec<String>>, String> {
    paths_in(
        &crate::engine::images::pasted_images_dir().join(DIRECTORY),
        images,
    )
}

pub(super) fn refs(images: &[TaskImage]) -> Vec<String> {
    images
        .iter()
        .map(|image| format!("task-image:{}", image.sha256))
        .collect()
}

fn extension(path: &Path) -> Result<(&'static str, &'static str), String> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Ok(("png", "image/png")),
        "jpg" | "jpeg" => Ok(("jpg", "image/jpeg")),
        "gif" => Ok(("gif", "image/gif")),
        "webp" => Ok(("webp", "image/webp")),
        _ => Err("Task image must be PNG, JPEG, GIF or WebP".into()),
    }
}

fn validate_source(source: &str) -> Result<(), String> {
    let trimmed = source.trim();
    // A drive-letter colon is allowed; URL schemes and NTFS streams are not.
    let bad_colon = trimmed.char_indices().any(|(index, ch)| {
        ch == ':' && !(index == 1 && trimmed.as_bytes()[0].is_ascii_alphabetic())
    });
    if trimmed.is_empty()
        || source.contains('\0')
        || source.chars().count() > 8192
        || trimmed.starts_with('\\')
        || trimmed.starts_with("//")
        || bad_colon
    {
        return Err("Invalid task image path".into());
    }
    Ok(())
}

fn digest(mime: &str, bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(mime.as_bytes());
    hash.update([0]);
    hash.update(bytes);
    format!("{:x}", hash.finalize())
}

fn canonical_directory(root: &Path, create: bool) -> Result<PathBuf, String> {
    if create {
        fs::create_dir_all(root).map_err(|_| "Cannot create task image storage")?;
    }
    let meta = fs::symlink_metadata(root).map_err(|_| "Task image storage is unavailable")?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("Invalid task image storage directory".into());
    }
    let canonical = fs::canonicalize(root).map_err(|_| "Cannot resolve task image storage")?;
    let parent = root
        .parent()
        .ok_or("Invalid task image storage directory")?;
    let parent = fs::canonicalize(parent).map_err(|_| "Cannot resolve task image storage")?;
    if canonical.parent() != Some(parent.as_path()) {
        return Err("Task image storage escaped its directory".into());
    }
    Ok(canonical)
}

fn bounded_read(path: &Path) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "Task image file is unavailable")?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.len() == 0
        || meta.len() > MAX_BYTES as u64
    {
        return Err("Task image must be a nonempty regular file of at most 8 MB".into());
    }
    let file = fs::File::open(path).map_err(|_| "Cannot read task image")?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read task image")?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("Invalid task image size".into());
    }
    Ok(bytes)
}

fn verify(root: &Path, image: &TaskImage) -> Result<Vec<u8>, String> {
    validate_source(&image.source)?;
    if image.sha256.len() != 64
        || !image
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid task image identity".into());
    }
    let path = Path::new(&image.path);
    if image.path.contains('\0') || image.path.chars().count() > 8192 || !path.is_absolute() {
        return Err("Invalid task image copy path".into());
    }
    let (ext, mime) = extension(path)?;
    if path.file_name().and_then(|name| name.to_str())
        != Some(format!("{}.{}", image.sha256, ext).as_str())
    {
        return Err("Task image storage identity does not match".into());
    }
    let canonical = fs::canonicalize(path).map_err(|_| "Task image copy is unavailable")?;
    if canonical.parent() != Some(root) {
        return Err("Task image copy escaped its storage directory".into());
    }
    let bytes = bounded_read(path)?;
    if digest(mime, &bytes) != image.sha256 {
        return Err("Task image copy failed integrity verification".into());
    }
    Ok(bytes)
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    if let Some(value) = value.strip_prefix(r"\\?\") {
        return value.to_owned();
    }
    value
}

fn capture_in(root: &Path, images: &[String], workspace: &Path) -> Result<Vec<TaskImage>, String> {
    if images.len() > MAX_IMAGES {
        return Err("At most 8 task images are supported".into());
    }
    if images.is_empty() {
        return Ok(Vec::new());
    }
    let root = canonical_directory(root, true)?;
    let mut captured = Vec::with_capacity(images.len());
    for source in images {
        validate_source(source)?;
        let path = crate::engine::images::absolutize_image_path(source, workspace)
            .ok_or("Invalid task image path")?;
        let (ext, expected_mime) = extension(&path)?;
        // Check regular-file/size before load_image so a named pipe cannot block.
        let meta = fs::metadata(&path).map_err(|_| "Task image source is unavailable")?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_BYTES as u64 {
            return Err("Invalid task image source size or type".into());
        }
        let (mime, encoded) = crate::engine::images::load_image(source, workspace)
            .map_err(|_| "Task image source is invalid or outside the allowed workspace")?;
        if mime != expected_mime {
            return Err("Task image type changed while reading".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "Invalid task image data")?;
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return Err("Invalid task image size".into());
        }
        let sha256 = digest(&mime, &bytes);
        let target = root.join(format!("{sha256}.{ext}"));
        let image = TaskImage {
            source: source.clone(),
            path: display_path(&target),
            sha256,
        };
        if !target.exists() {
            let temporary = root.join(format!(".capture-{}", uuid::Uuid::new_v4()));
            let result = (|| -> Result<(), String> {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)
                    .map_err(|_| "Cannot stage task image")?;
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|_| "Cannot persist task image")?;
                drop(file);
                // Publishing a link is atomic and never overwrites an existing copy.
                match fs::hard_link(&temporary, &target) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
                    Err(_) => Err("Cannot publish task image copy".into()),
                }
            })();
            let _ = fs::remove_file(&temporary);
            result?;
        }
        if verify(&root, &image)? != bytes {
            return Err("Task image copy does not match its source".into());
        }
        captured.push(image);
    }
    Ok(captured)
}

fn paths_in(root: &Path, images: &[TaskImage]) -> Result<Option<Vec<String>>, String> {
    if images.len() > MAX_IMAGES {
        return Err("At most 8 task images are supported".into());
    }
    if images.is_empty() {
        return Ok(None);
    }
    let root = canonical_directory(root, false)?;
    images
        .iter()
        .map(|image| verify(&root, image).map(|_| image.path.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        dir: PathBuf,
        workspace: PathBuf,
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("task-images-{}", uuid::Uuid::new_v4()));
            let workspace = dir.join("工作区");
            let root = dir.join("pasted-images").join(DIRECTORY);
            fs::create_dir_all(&workspace).unwrap();
            Self {
                dir,
                workspace,
                root,
            }
        }
        fn image(&self, name: &str, bytes: &[u8]) -> String {
            fs::write(self.workspace.join(name), bytes).unwrap();
            name.into()
        }
        fn capture(&self, images: &[String]) -> Result<Vec<TaskImage>, String> {
            capture_in(&self.root, images, &self.workspace)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn durable_copy_survives_source_change_and_deletion() {
        let f = Fixture::new();
        let source = f.image("图片😀.png", b"original");
        let images = f.capture(&[source.clone()]).unwrap();
        fs::write(f.workspace.join(&source), b"changed").unwrap();
        assert_eq!(
            bounded_read(Path::new(&paths_in(&f.root, &images).unwrap().unwrap()[0])).unwrap(),
            b"original"
        );
        fs::remove_file(f.workspace.join(&source)).unwrap();
        assert!(paths_in(&f.root, &images).is_ok());
        assert_eq!(images[0].source, source);
    }

    #[test]
    fn missing_or_corrupted_copy_fails_closed() {
        let f = Fixture::new();
        let images = f.capture(&[f.image("a.png", b"original")]).unwrap();
        fs::write(&images[0].path, b"changed").unwrap();
        assert!(paths_in(&f.root, &images).is_err());
        assert!(f.capture(&["a.png".into()]).is_err());
        fs::remove_file(&images[0].path).unwrap();
        assert!(paths_in(&f.root, &images).is_err());
    }

    #[test]
    fn rejects_unsafe_outside_and_invalid_paths() {
        let f = Fixture::new();
        fs::write(f.dir.join("outside.png"), b"outside").unwrap();
        for source in [
            "",
            " ",
            "x\0.png",
            "https://x/a.png",
            "data:image/png;base64,AA==",
            r"\\server\a.png",
            "//server/a.png",
            "file:///a.png",
            "../outside.png",
            "a.png:stream",
            "x.svg",
        ] {
            assert!(
                f.capture(&[source.into()]).is_err(),
                "accepted unsafe source"
            );
        }
        assert!(f.capture(&["a".repeat(8193)]).is_err());
    }

    #[test]
    fn rejects_empty_oversize_and_too_many_images() {
        let f = Fixture::new();
        assert!(f.capture(&[f.image("empty.png", b"")]).is_err());
        assert!(f
            .capture(&[f.image("large.png", &vec![0; MAX_BYTES + 1])])
            .is_err());
        assert!(f.capture(&vec!["a.png".into(); 9]).is_err());
        assert!(f
            .capture(&[f.image("limit.png", &vec![1; MAX_BYTES])])
            .is_ok());
    }

    #[test]
    fn empty_has_no_paths_and_order_and_refs_are_stable() {
        let f = Fixture::new();
        assert_eq!(paths_in(&f.root, &[]).unwrap(), None);
        assert!(f.capture(&[]).unwrap().is_empty());
        let a = f.image("a.png", b"a");
        let b = f.image("b.jpeg", b"b");
        let images = f.capture(&[b.clone(), a.clone(), b]).unwrap();
        assert_eq!(images[0].path, images[2].path);
        assert_ne!(images[0].path, images[1].path);
        assert_eq!(refs(&images)[0], refs(&images)[2]);
        assert!(refs(&images)
            .iter()
            .all(|r| r.starts_with("task-image:")
                && !r.contains(&f.dir.to_string_lossy().to_string())));
        assert_eq!(
            paths_in(&f.root, &images).unwrap().unwrap(),
            images.iter().map(|i| i.path.clone()).collect::<Vec<_>>()
        );
        assert_eq!(f.capture(&[a]).unwrap()[0], images[1]);
    }

    #[test]
    fn source_is_exact_and_mime_is_part_of_identity() {
        let f = Fixture::new();
        f.image("a.png", b"same bytes");
        f.image("a.jpg", b"same bytes");
        f.image("a.jpeg", b"same bytes");
        let images = f
            .capture(&[" a.png ".into(), "a.jpg".into(), "a.jpeg".into()])
            .unwrap();
        assert_eq!(images[0].source, " a.png ");
        assert_ne!(images[0].sha256, images[1].sha256);
        assert_eq!(images[1].sha256, images[2].sha256);
        assert_eq!(images[1].path, images[2].path);
        let restored: Vec<TaskImage> =
            serde_json::from_str(&serde_json::to_string(&images).unwrap()).unwrap();
        assert_eq!(restored, images);
        assert!(paths_in(&f.root, &restored).is_ok());
    }

    #[test]
    fn copied_paths_cannot_escape_or_change_identity() {
        let f = Fixture::new();
        let images = f.capture(&[f.image("a.png", b"a")]).unwrap();
        let mut altered = images.clone();
        let outside = f.dir.join(Path::new(&images[0].path).file_name().unwrap());
        fs::copy(&images[0].path, &outside).unwrap();
        altered[0].path = outside.to_string_lossy().into_owned();
        assert!(paths_in(&f.root, &altered).is_err());
        altered[0] = images[0].clone();
        altered[0].sha256 = "0".repeat(64);
        assert!(paths_in(&f.root, &altered).is_err());
    }

    #[test]
    fn concurrent_capture_publishes_one_complete_copy() {
        let f = Fixture::new();
        let source = f.image("same.png", &vec![7; 65536]);
        let images = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| f.capture(std::slice::from_ref(&source)).unwrap()))
                .collect();
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect::<Vec<_>>()
        });
        for image in &images {
            assert_eq!(image, &images[0]);
            assert!(paths_in(&f.root, image).is_ok());
        }
        assert_eq!(fs::read_dir(&f.root).unwrap().count(), 1);
    }
}
