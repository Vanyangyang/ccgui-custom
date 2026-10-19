//! Access to the plain and compressed representations of a Codex rollout.
use std::io::{self, BufRead, BufReader};
use std::path::{Path, PathBuf};

pub(crate) fn is_compressed(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "zst")
        && path
            .with_extension("")
            .extension()
            .is_some_and(|ext| ext == "jsonl")
}

pub(crate) fn plain_path(path: &Path) -> PathBuf {
    if is_compressed(path) {
        path.with_extension("")
    } else {
        path.to_path_buf()
    }
}

/// Prefer the live plain transcript, even when an index points at its compressed copy.
/// Only NotFound permits fallback: permission errors must surface on open.
pub(crate) fn resolve_path(path: &Path) -> PathBuf {
    let plain = plain_path(path);
    if !matches!(std::fs::metadata(&plain), Err(error) if error.kind() == io::ErrorKind::NotFound) {
        return plain;
    }
    if is_compressed(path) {
        return path.to_path_buf();
    }
    if plain.extension().is_some_and(|ext| ext == "jsonl") {
        let compressed = plain.with_extension("jsonl.zst");
        if !matches!(std::fs::metadata(&compressed), Err(error) if error.kind() == io::ErrorKind::NotFound)
        {
            return compressed;
        }
    }
    plain
}

pub(crate) fn open_reader(path: &Path) -> io::Result<Box<dyn BufRead>> {
    let mut resolved = resolve_path(path);
    let file = match std::fs::File::open(&resolved) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            resolved = resolve_path(path);
            std::fs::File::open(&resolved)?
        }
        result => result?,
    };
    if is_compressed(&resolved) {
        Ok(Box::new(BufReader::new(zstd::stream::read::Decoder::new(
            file,
        )?)))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

/// Remove both representations of exactly one rollout, compressed copy first.
pub(crate) fn remove_files(path: &Path) -> io::Result<()> {
    let plain = plain_path(path);
    if plain.extension().is_none_or(|ext| ext != "jsonl") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected Codex .jsonl or .jsonl.zst path",
        ));
    }
    for path in [plain.with_extension("jsonl.zst"), plain] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn compressed_rollout_resolves_old_and_direct_paths_and_prefers_plain() {
        let dir = std::env::temp_dir().join(format!("ccgui-rollout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("rollout-test.jsonl");
        let compressed = plain.with_extension("jsonl.zst");
        let original = "中文🙂\n{\"image\":\"data:image/png;base64,AA==\"}\n";
        std::fs::write(
            &compressed,
            zstd::encode_all(original.as_bytes(), 1).unwrap(),
        )
        .unwrap();
        for path in [&plain, &compressed] {
            assert_eq!(resolve_path(path), compressed);
            let mut text = String::new();
            open_reader(path)
                .unwrap()
                .read_to_string(&mut text)
                .unwrap();
            assert_eq!(text, original);
        }
        std::fs::write(&plain, "live").unwrap();
        assert_eq!(resolve_path(&compressed), plain);
        let mut text = String::new();
        open_reader(&compressed)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "live");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn compressed_rollout_removal_is_exact_and_idempotent() {
        let dir =
            std::env::temp_dir().join(format!("ccgui-rollout-delete-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("rollout-test.jsonl");
        let compressed = plain.with_extension("jsonl.zst");
        let neighbor = dir.join("rollout-other.jsonl.zst");
        std::fs::write(&neighbor, "untouched").unwrap();
        for raw in [true, false] {
            if raw {
                std::fs::write(&plain, "raw").unwrap();
            }
            std::fs::write(&compressed, "compressed").unwrap();
            remove_files(&compressed).unwrap();
            assert!(!plain.exists() && !compressed.exists());
        }
        remove_files(&plain).unwrap();
        assert!(remove_files(&dir.join("other.txt")).is_err());
        assert_eq!(std::fs::read_to_string(neighbor).unwrap(), "untouched");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
