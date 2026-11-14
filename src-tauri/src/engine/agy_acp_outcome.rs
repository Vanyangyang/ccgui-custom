//! Best-effort, read-only evidence for native AGY errors hidden behind `end_turn`.

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    fmt, fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

const ERROR_STEP_TYPE: i64 = 17;
const MAX_ERROR_PAYLOAD_BYTES: usize = 16_384;
const BUSY_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NativePromptFailure {
    UnexpectedEof,
    UsageLimit,
    Authentication,
    Provider,
}

impl NativePromptFailure {
    pub(super) fn message(self) -> &'static str {
        match self {
            Self::UnexpectedEof => "Antigravity's upstream response ended unexpectedly (unexpected EOF).",
            Self::UsageLimit => "Antigravity stopped this turn because of a rate or quota limit.",
            Self::Authentication => "Antigravity stopped this turn because upstream authentication or authorization failed.",
            Self::Provider => "Antigravity stopped this turn because of an upstream provider error.",
        }
    }
}

impl fmt::Display for NativePromptFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

pub(super) fn is_public_failure_message(message: &str) -> bool {
    [
        NativePromptFailure::UnexpectedEof,
        NativePromptFailure::UsageLimit,
        NativePromptFailure::Authentication,
        NativePromptFailure::Provider,
    ]
    .iter()
    .any(|failure| failure.message() == message)
}

pub(super) struct PromptOutcomeWatch {
    // Keep the original connection: reopening a replaced path could inspect a
    // different session. No transaction is held while the prompt is running.
    // None is only permitted when the file was explicitly absent at checkpoint.
    connection: Option<Connection>,
    path: PathBuf,
    before: i64,
}

/// An absent file with a verified parent chain may be created by this prompt.
/// Linked, unreadable, locked, or unsupported existing logs disable the check.
pub(super) fn checkpoint(db_path: &Path) -> Option<PromptOutcomeWatch> {
    if !ordinary_file_or_absent(db_path)? {
        return Some(PromptOutcomeWatch {
            connection: None,
            path: db_path.to_owned(),
            before: -1,
        });
    }
    let connection = open_read_only(db_path)?;
    let before = connection
        .query_row("SELECT max(idx) FROM steps", [], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .ok()?
        .unwrap_or(-1);
    if !ordinary_file(db_path) {
        return None;
    }
    Some(PromptOutcomeWatch {
        connection: Some(connection),
        path: db_path.to_owned(),
        before,
    })
}

impl PromptOutcomeWatch {
    /// Outer `None` means unavailable; `Some(None)` means no final new error.
    pub(super) fn check_failure(&self) -> Option<Option<NativePromptFailure>> {
        if !ordinary_file(&self.path) {
            return None;
        }
        let newly_created;
        let connection = match &self.connection {
            Some(connection) => connection,
            None => {
                newly_created = open_read_only(&self.path)?;
                &newly_created
            }
        };
        let step = connection
            .query_row(
                "SELECT step_type, substr(CAST(step_payload AS BLOB), 1, ?1) \
             FROM steps WHERE idx > ?2 ORDER BY idx DESC LIMIT 1",
                rusqlite::params![MAX_ERROR_PAYLOAD_BYTES as i64, self.before],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<Vec<u8>>>(1)?)),
            )
            .optional()
            .ok()?;
        if !ordinary_file(&self.path) {
            return None;
        }
        Some(match step {
            Some((ERROR_STEP_TYPE, payload)) => {
                Some(classify(payload.as_deref().unwrap_or_default()))
            }
            _ => None,
        })
    }

    pub(super) fn failure(&self) -> Option<NativePromptFailure> {
        self.check_failure().flatten()
    }
}

fn ordinary_file(path: &Path) -> bool {
    ordinary_file_or_absent(path) == Some(true)
}

fn open_read_only(path: &Path) -> Option<Connection> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    connection.busy_timeout(BUSY_TIMEOUT).ok()?;
    Some(connection)
}

/// Some(false) means only the leaf is explicitly NotFound; all parents exist.
fn ordinary_file_or_absent(path: &Path) -> Option<bool> {
    // Requiring an absolute, traversal-free path makes the parent-chain proof
    // explicit; do not canonicalize first, which would conceal symlinks.
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return None;
    }
    let mut exists = true;
    for (index, ancestor) in path.ancestors().enumerate() {
        let metadata = match fs::symlink_metadata(ancestor) {
            Ok(metadata) => metadata,
            Err(error) if index == 0 && error.kind() == std::io::ErrorKind::NotFound => {
                exists = false;
                continue;
            }
            Err(_) => return None,
        };
        if metadata.file_type().is_symlink() {
            return None;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            // Also reject junctions and other reparse points, not just symlinks.
            if metadata.file_attributes() & 0x400 != 0 {
                return None;
            }
        }
        if (index == 0 && !metadata.is_file()) || (index > 0 && !metadata.is_dir()) {
            return None;
        }
    }
    Some(exists)
}

fn classify(payload: &[u8]) -> NativePromptFailure {
    // Native protobuf length-delimited strings retain these ASCII markers.
    // Parsing is deliberately bounded and never exposes strings, URLs or stacks.
    let text = String::from_utf8_lossy(&payload[..payload.len().min(MAX_ERROR_PAYLOAD_BYTES)])
        .to_ascii_lowercase();
    if text.contains("quota_exhausted")
        || text.contains("resource_exhausted")
        || text.contains("error 429")
    {
        NativePromptFailure::UsageLimit
    } else if text.contains("error 401") || text.contains("error 403") {
        NativePromptFailure::Authentication
    } else if text.contains("unexpected eof") {
        NativePromptFailure::UnexpectedEof
    } else {
        NativePromptFailure::Provider
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    struct Fixture {
        root: PathBuf,
        path: PathBuf,
        writer: Connection,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("agy-outcome-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let path = root.join("session.db");
            let writer = Connection::open(&path).unwrap();
            writer.execute_batch("CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)").unwrap();
            Self { root, path, writer }
        }

        fn add(&self, index: i64, kind: i64, payload: &[u8]) {
            self.writer
                .execute(
                    "INSERT INTO steps VALUES(?1, ?2, ?3)",
                    rusqlite::params![index, kind, payload],
                )
                .unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // Close the writer before removing its directory on Windows.
            let old = std::mem::replace(&mut self.writer, Connection::open_in_memory().unwrap());
            drop(old);
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn new_final_error_is_classified_without_exposing_payload() {
        let fixture = Fixture::new();
        let watch = checkpoint(&fixture.path).unwrap();
        fixture.add(0, ERROR_STEP_TYPE, b"\x0a\x40Error 429, Message: secret-token-123 https://secret.example, Status: RESOURCE_EXHAUSTED");
        let failure = watch.failure().unwrap();
        assert_eq!(failure, NativePromptFailure::UsageLimit);
        assert!(!failure.to_string().contains("secret"));
        assert!(!format!("{failure:?}").contains("secret"));
    }

    #[test]
    fn old_errors_and_no_new_steps_do_not_fail() {
        let fixture = Fixture::new();
        fixture.add(0, ERROR_STEP_TYPE, b"unexpected EOF");
        let watch = checkpoint(&fixture.path).unwrap();
        assert_eq!(watch.check_failure(), Some(None));
        fixture.add(1, 1, b"success");
        assert_eq!(watch.failure(), None);
    }

    #[test]
    fn recovered_intermediate_error_does_not_fail() {
        let fixture = Fixture::new();
        let watch = checkpoint(&fixture.path).unwrap();
        fixture.add(0, ERROR_STEP_TYPE, b"unexpected EOF");
        fixture.add(1, 1, b"recovered");
        assert_eq!(watch.check_failure(), Some(None));
    }

    #[test]
    fn missing_corrupt_and_locked_logs_are_unavailable_with_bounded_wait() {
        let fixture = Fixture::new();
        let missing = fixture.root.join("missing.db");
        assert_eq!(checkpoint(&missing).unwrap().check_failure(), None);
        assert!(!missing.exists());
        assert!(checkpoint(&fixture.root.join("missing-parent/session.db")).is_none());
        let corrupt = fixture.root.join("corrupt.db");
        fs::write(&corrupt, b"not sqlite").unwrap();
        assert!(checkpoint(&corrupt).is_none());
        let watch = checkpoint(&fixture.path).unwrap();
        fixture.writer.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let start = Instant::now();
        assert!(checkpoint(&fixture.path).is_none());
        assert_eq!(watch.check_failure(), None);
        assert!(start.elapsed() < Duration::from_secs(1));
        fixture.writer.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn newly_created_log_reports_this_prompts_error() {
        let fixture = Fixture::new();
        let path = fixture.root.join("new-session.db");
        let watch = checkpoint(&path).unwrap();
        assert!(!path.exists());
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch(
                "CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
            )
            .unwrap();
        writer
            .execute(
                "INSERT INTO steps VALUES(0, 17, ?1)",
                [b"unexpected EOF secret-token".as_slice()],
            )
            .unwrap();
        assert_eq!(watch.failure(), Some(NativePromptFailure::UnexpectedEof));
    }

    #[test]
    fn corrupt_initial_log_does_not_become_an_absent_checkpoint() {
        let fixture = Fixture::new();
        let path = fixture.root.join("repaired.db");
        fs::write(&path, b"not sqlite").unwrap();
        let watch = checkpoint(&path);
        assert!(watch.is_none());
        fs::write(&path, b"").unwrap();
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch(
                "CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
            )
            .unwrap();
        writer
            .execute(
                "INSERT INTO steps VALUES(0, 17, ?1)",
                [b"unexpected EOF".as_slice()],
            )
            .unwrap();
        assert!(watch.and_then(|watch| watch.failure()).is_none());
        // A fresh checkpoint treats the repaired log's existing error as old.
        assert_eq!(checkpoint(&path).unwrap().check_failure(), Some(None));
    }

    #[test]
    fn classifications_are_fixed_and_payload_is_bounded() {
        for (payload, expected) in [
            (
                "unexpected EOF fake-token",
                NativePromptFailure::UnexpectedEof,
            ),
            ("reason:QUOTA_EXHAUSTED", NativePromptFailure::UsageLimit),
            (
                "Error 401, Message: token",
                NativePromptFailure::Authentication,
            ),
            (
                "Error 403, Message: token",
                NativePromptFailure::Authentication,
            ),
            ("unrecognized error token", NativePromptFailure::Provider),
        ] {
            assert_eq!(classify(payload.as_bytes()), expected);
        }
        let fixture = Fixture::new();
        let watch = checkpoint(&fixture.path).unwrap();
        let mut payload = vec![b'x'; MAX_ERROR_PAYLOAD_BYTES];
        payload.extend_from_slice(b"unexpected EOF");
        fixture.add(0, ERROR_STEP_TYPE, &payload);
        assert_eq!(watch.failure(), Some(NativePromptFailure::Provider));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_file_and_parent_symlinks() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let link = fixture.root.join("linked.db");
        symlink(&fixture.path, &link).unwrap();
        assert!(checkpoint(&link).is_none());
        let parent = fixture.root.join("linked-parent");
        symlink(&fixture.root, &parent).unwrap();
        assert!(checkpoint(&parent.join("session.db")).is_none());
    }
}
