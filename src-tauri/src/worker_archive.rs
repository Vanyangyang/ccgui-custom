//! Read-only, profile-bound access to physically retired worker journals.
//! No process or executable liveness is required. Cached metadata describes the
//! validated snapshot at open; reads fail if any archive file subsequently changes.

use crate::runtime_events::{EventEnvelope, ReplayBatch};
use crate::task_worker::{Command, Outcome, WorkerError, WorkerManifest, PROTOCOL};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs::{File, Metadata};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

const MANIFEST_BYTES: usize = 64 * 1024;
const EVENT_BYTES: usize = 128 * 1024 * 1024 + 1024;
const RECEIPT_BYTES: usize = 16 * 1024 * 1024;
const PAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVENTS: usize = 1_000_000;
const INDEX_BYTES: usize = 32 * 1024 * 1024;
const MAX_REQUESTS: usize = 8192;
const MAX_RUN_ALIASES: usize = 16384;
// Every command writes accepted + completed; retirement legitimately repeats
// its completed receipt after atomically retiring the manifest.
const MAX_RECEIPT_RECORDS: usize = MAX_REQUESTS * 3;

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

fn hex_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn plain_absolute(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
}

fn redirected(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes junctions and other reparse points, not just symbolic links.
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn checked_directory(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "Read archive directory failed")?;
    if !metadata.is_dir()
        || redirected(&metadata)
        || dunce::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err("Archive directory must be a canonical, non-redirected directory".into());
    }
    Ok(())
}

fn checked_file(path: &Path) -> Result<Metadata, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| "Read archive file metadata failed")?;
    if !metadata.is_file()
        || redirected(&metadata)
        || dunce::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err("Archive file must be a regular, non-redirected file".into());
    }
    Ok(metadata)
}

#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    length: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
}

impl Stamp {
    fn from(metadata: &Metadata) -> Result<Self, String> {
        Ok(Self {
            length: metadata.len(),
            modified: metadata
                .modified()
                .map_err(|_| "Archive modification time is unavailable")?,
            created: metadata.created().ok(),
        })
    }
}

struct GuardedFile {
    path: PathBuf,
    stamp: Stamp,
}

impl GuardedFile {
    fn open(path: PathBuf) -> Result<(Self, File), String> {
        let stamp = Stamp::from(&checked_file(&path)?)?;
        let file = File::open(&path).map_err(|_| "Open archive file failed")?;
        if Stamp::from(
            &file
                .metadata()
                .map_err(|_| "Read open archive metadata failed")?,
        )? != stamp
        {
            return Err("Archive file changed while opening".into());
        }
        Ok((Self { path, stamp }, file))
    }

    fn verify(&self) -> Result<(), String> {
        if Stamp::from(&checked_file(&self.path)?)? != self.stamp {
            return Err("Archive file changed or was truncated after indexing".into());
        }
        Ok(())
    }

    fn reader(&self) -> Result<File, String> {
        self.verify()?;
        let file = File::open(&self.path).map_err(|_| "Reopen archive file failed")?;
        if Stamp::from(
            &file
                .metadata()
                .map_err(|_| "Read open archive metadata failed")?,
        )? != self.stamp
        {
            return Err("Archive file changed while reopening".into());
        }
        Ok(file)
    }
}

#[derive(Clone, Copy)]
struct Record {
    offset: u64,
    length: u64,
}

struct ReceiptIndex {
    fingerprint: String,
    completed: Option<Record>,
}

#[derive(Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case", deny_unknown_fields)]
enum ReceiptRecord {
    Accepted { id: String, fingerprint: String },
    Completed { id: String, outcome: Outcome },
}

/// Offsets only: a large journal never requires retaining its payload history.
/// The private manifest contains a credential and intentionally is not Debug.
pub struct Archive {
    profile: PathBuf,
    directory: PathBuf,
    manifest: WorkerManifest,
    manifest_file: GuardedFile,
    events_file: GuardedFile,
    receipts_file: GuardedFile,
    events: Vec<Record>,
    receipts: HashMap<String, ReceiptIndex>,
    session_id: Option<String>,
    run_ids: BTreeSet<String>,
}

pub fn open(profile: &Path, worker_id: &str) -> Result<Archive, String> {
    if !valid_id(worker_id) || !plain_absolute(profile) {
        return Err("Invalid archive profile or worker identifier".into());
    }
    // Reject redirects anywhere in the supplied profile, not just its last component.
    for ancestor in profile.ancestors() {
        checked_directory(ancestor)?;
    }
    let directory = profile.join("runtime").join("task-workers").join(worker_id);
    for path in [
        profile.join("runtime"),
        profile.join("runtime/task-workers"),
        directory.clone(),
    ] {
        checked_directory(&path)?;
    }

    let (manifest_file, mut manifest_reader) =
        GuardedFile::open(directory.join("manifest.retired.json"))?;
    if manifest_file.stamp.length > MANIFEST_BYTES as u64 {
        return Err("Retired worker manifest exceeds its size limit".into());
    }
    let mut bytes = Vec::new();
    (&mut manifest_reader)
        .take(MANIFEST_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Read retired worker manifest failed")?;
    if bytes.len() > MANIFEST_BYTES {
        return Err("Retired worker manifest exceeds its size limit".into());
    }
    let manifest: WorkerManifest =
        serde_json::from_slice(&bytes).map_err(|_| "Retired worker manifest is invalid")?;
    if manifest.protocol != PROTOCOL
        || manifest.profile != profile
        || manifest.worker_id != worker_id
        || !valid_id(&manifest.run_id)
        || !hex_digest(&manifest.token)
        || !hex_digest(&manifest.schema_hash)
        || manifest.port == 0
        || !plain_absolute(&manifest.executable)
    {
        return Err("Retired worker manifest identity or protocol is invalid".into());
    }
    // The schema can belong to an older host, and the executable may be gone.
    // Neither changes the meaning of the versioned immutable journal protocol.
    manifest_file.verify()?;

    let (events_file, events_reader) = GuardedFile::open(directory.join("events.jsonl"))?;
    let mut reader = BufReader::new(events_reader);
    let mut events = Vec::new();
    let mut line = Vec::new();
    let mut offset = 0u64;
    let mut session_id = None;
    let mut run_ids = BTreeSet::from([manifest.run_id.clone()]);
    while read_line(&mut reader, &mut line, EVENT_BYTES)? {
        if events.len() >= MAX_EVENTS
            || (events.len() + 1) * std::mem::size_of::<Record>() > INDEX_BYTES
        {
            return Err("Worker archive event index capacity exceeded".into());
        }
        let event: EventEnvelope = serde_json::from_slice(&line[..line.len() - 1])
            .map_err(|_| "Worker archive event is invalid JSON")?;
        if event.stream_id != worker_id
            || event.seq != events.len() as u64 + 1
            || event.name.is_empty()
        {
            return Err("Worker archive event stream or contiguous sequence is invalid".into());
        }
        update_session(&event, &mut session_id);
        collect_run_ids(&event, &mut run_ids)?;
        if events.len() == events.capacity() {
            // Explicit growth stops at one million 16-byte records (16 MB),
            // rather than allowing a final geometric allocation past the cap.
            let capacity = events
                .capacity()
                .max(1)
                .saturating_mul(2)
                .min(MAX_EVENTS)
                .min(INDEX_BYTES / std::mem::size_of::<Record>());
            events
                .try_reserve_exact(capacity - events.len())
                .map_err(|_| "Allocate worker archive event index failed")?;
            if events
                .capacity()
                .saturating_mul(std::mem::size_of::<Record>())
                > INDEX_BYTES
            {
                return Err("Worker archive event index allocation exceeds its byte limit".into());
            }
        }
        events.push(Record {
            offset,
            length: line.len() as u64,
        });
        offset = offset
            .checked_add(line.len() as u64)
            .ok_or("Worker archive offset overflow")?;
    }
    if offset != events_file.stamp.length {
        return Err("Worker event archive changed during indexing".into());
    }
    events_file.verify()?;
    drop(line);

    let (receipts_file, receipts_reader) = GuardedFile::open(directory.join("receipts.jsonl"))?;
    let mut reader = BufReader::new(receipts_reader);
    let mut receipts: HashMap<String, ReceiptIndex> = HashMap::new();
    let mut count = 0;
    let mut offset = 0u64;
    // Release any event-sized allocation before scanning much smaller receipts.
    let mut line = Vec::new();
    while read_line(&mut reader, &mut line, RECEIPT_BYTES)? {
        count += 1;
        if count > MAX_RECEIPT_RECORDS {
            return Err("Worker archive receipt record capacity exceeded".into());
        }
        let record = Record {
            offset,
            length: line.len() as u64,
        };
        let receipt: ReceiptRecord = serde_json::from_slice(&line[..line.len() - 1])
            .map_err(|_| "Worker archive receipt is invalid JSON")?;
        match receipt {
            ReceiptRecord::Accepted { id, fingerprint } => {
                if !valid_id(&id) || !hex_digest(&fingerprint) {
                    return Err("Worker archive receipt identity is invalid".into());
                }
                if let Some(existing) = receipts.get(&id) {
                    if existing.fingerprint != fingerprint {
                        return Err(
                            "Worker archive receipt identity has conflicting parameters".into()
                        );
                    }
                } else {
                    if receipts.len() >= MAX_REQUESTS {
                        return Err("Worker archive request capacity exceeded".into());
                    }
                    receipts.insert(
                        id,
                        ReceiptIndex {
                            fingerprint,
                            completed: None,
                        },
                    );
                }
            }
            ReceiptRecord::Completed { id, outcome: _ } => {
                if !valid_id(&id) {
                    return Err("Worker archive receipt identity is invalid".into());
                }
                let entry = receipts
                    .get_mut(&id)
                    .ok_or("Worker archive completion has no accepted request")?;
                entry.completed = Some(record);
            }
        }
        offset = offset
            .checked_add(line.len() as u64)
            .ok_or("Worker archive offset overflow")?;
    }
    if offset != receipts_file.stamp.length {
        return Err("Worker receipt archive changed during indexing".into());
    }
    let archive = Archive {
        profile: profile.to_path_buf(),
        directory,
        manifest,
        manifest_file,
        events_file,
        receipts_file,
        events,
        receipts,
        session_id,
        run_ids,
    };
    archive.verify()?;
    Ok(archive)
}

impl Archive {
    pub fn manifest(&self) -> &WorkerManifest {
        &self.manifest
    }
    pub fn head(&self) -> u64 {
        self.events.len() as u64
    }
    pub fn session_id(&self) -> Option<String> {
        self.session_id.clone()
    }
    pub fn run_ids(&self) -> Vec<String> {
        self.run_ids.iter().cloned().collect()
    }

    fn verify(&self) -> Result<(), String> {
        for ancestor in self.directory.ancestors() {
            checked_directory(ancestor)?;
            if ancestor == self.profile {
                break;
            }
        }
        self.manifest_file.verify()?;
        self.events_file.verify()?;
        self.receipts_file.verify()?;
        Ok(())
    }

    pub fn replay(&self, after: u64, limit: usize) -> Result<ReplayBatch, String> {
        self.verify()?;
        if limit == 0 || limit > 512 {
            return Err("Expected 1 to 512 archive events".into());
        }
        if after > self.head() {
            return Err("Archive cursor exceeds the worker head".into());
        }
        let mut file = self.events_file.reader()?;
        let mut events = Vec::new();
        let mut total = 0usize;
        for record in self.events.iter().skip(after as usize).take(limit) {
            let length = usize::try_from(record.length)
                .map_err(|_| "Archive event length exceeds this platform")?;
            if !events.is_empty() && length > PAGE_BYTES.saturating_sub(total) {
                break;
            }
            let bytes = read_record(&mut file, *record, EVENT_BYTES)?;
            let event: EventEnvelope = serde_json::from_slice(&bytes[..bytes.len() - 1])
                .map_err(|_| "Worker archive event changed after indexing")?;
            if event.stream_id != self.manifest.worker_id
                || event.seq != after + events.len() as u64 + 1
            {
                return Err("Worker archive event identity changed after indexing".into());
            }
            total += length;
            events.push(event);
            if total >= PAGE_BYTES {
                break;
            }
        }
        self.verify()?;
        Ok(ReplayBatch {
            stream_id: self.manifest.worker_id.clone(),
            through: after + events.len() as u64,
            events,
        })
    }

    /// Mutation recovery must preserve the live worker's exact request-ID to
    /// command binding. A conflict is a known rejected Outcome, not uncertainty.
    pub fn receipt_for(
        &self,
        request_id: &str,
        command: &Command,
    ) -> Result<Option<Outcome>, String> {
        if !valid_id(request_id) {
            return Err("Invalid archive request identifier".into());
        }
        self.verify()?;
        let Some(entry) = self.receipts.get(request_id) else {
            return Ok(None);
        };
        let bytes =
            serde_json::to_vec(command).map_err(|_| "Encode archived worker command failed")?;
        let fingerprint = format!("{:x}", Sha256::digest(bytes));
        if entry.fingerprint != fingerprint {
            return Ok(Some(Err(WorkerError::new(
                "request_conflict",
                "Request ID was already used with different parameters",
            ))));
        }
        self.receipt(request_id)
    }

    /// Diagnostic lookup only; mutation callers must use receipt_for.
    pub fn receipt(&self, request_id: &str) -> Result<Option<Outcome>, String> {
        if !valid_id(request_id) {
            return Err("Invalid archive request identifier".into());
        }
        self.verify()?;
        let Some(entry) = self.receipts.get(request_id) else {
            return Ok(None);
        };
        let Some(record) = entry.completed else {
            return Ok(Some(Err(WorkerError::unknown("outcome_unknown",
                "Archived request was accepted without a durable completion; do not issue a new request ID"))));
        };
        let mut file = self.receipts_file.reader()?;
        let bytes = read_record(&mut file, record, RECEIPT_BYTES)?;
        let receipt: ReceiptRecord = serde_json::from_slice(&bytes[..bytes.len() - 1])
            .map_err(|_| "Worker archive receipt changed after indexing")?;
        self.verify()?;
        match receipt {
            ReceiptRecord::Completed { id, outcome } if id == request_id => Ok(Some(outcome)),
            _ => Err("Worker archive receipt identity changed after indexing".into()),
        }
    }
}

/// A bounded line reader rejects partial tails, blank records, and oversized
/// lines without allocating an unbounded read_until buffer.
fn read_line<R: BufRead>(reader: &mut R, line: &mut Vec<u8>, max: usize) -> Result<bool, String> {
    line.clear();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|_| "Read archive journal failed")?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(false)
            } else {
                Err("Worker archive has a partial final record".into())
            };
        }
        let end = available.iter().position(|byte| *byte == b'\n');
        let take = end.map_or(available.len(), |position| position + 1);
        if take > (max + 1).saturating_sub(line.len()) {
            return Err("Worker archive record exceeds its size limit".into());
        }
        let needed = line.len() + take;
        if line.capacity() < needed {
            let capacity = line
                .capacity()
                .max(8192)
                .saturating_mul(2)
                .max(needed)
                .min(max + 1);
            line.try_reserve_exact(capacity - line.len())
                .map_err(|_| "Allocate worker archive record failed")?;
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if end.is_some() {
            if line.len() <= 1 {
                return Err("Worker archive contains an empty record".into());
            }
            return Ok(true);
        }
    }
}

fn read_record(file: &mut File, record: Record, max: usize) -> Result<Vec<u8>, String> {
    let length =
        usize::try_from(record.length).map_err(|_| "Archive record exceeds this platform")?;
    if length <= 1 || length > max + 1 {
        return Err("Archive index record length is invalid".into());
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| "Allocate archive record failed")?;
    bytes.resize(length, 0);
    file.seek(SeekFrom::Start(record.offset))
        .and_then(|_| file.read_exact(&mut bytes))
        .map_err(|_| "Read indexed archive record failed")?;
    if bytes.last() != Some(&b'\n') {
        return Err("Indexed archive record was truncated".into());
    }
    Ok(bytes)
}

fn update_session(event: &EventEnvelope, session: &mut Option<String>) {
    if event.name != crate::event_sink::ENGINE_EVENT_NAME {
        return;
    }
    if let Some(events) = event.payload.as_array() {
        for event in events {
            let candidate = event.get("sessionId").and_then(Value::as_str).or_else(|| {
                (event["kind"] == "session")
                    .then(|| event["data"].as_str())
                    .flatten()
            });
            if let Some(value) = candidate.filter(|value| !value.is_empty() && value.len() <= 256) {
                *session = Some(value.into());
            }
        }
    }
}

fn collect_run_ids(event: &EventEnvelope, aliases: &mut BTreeSet<String>) -> Result<(), String> {
    if event.name != crate::event_sink::ENGINE_EVENT_NAME {
        return Ok(());
    }
    if let Some(events) = event.payload.as_array() {
        for event in events {
            let Some(value) = event.get("runId") else {
                continue;
            };
            let id = value
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or("Worker archive contains an invalid run alias")?;
            if !aliases.contains(id) {
                if aliases.len() >= MAX_RUN_ALIASES {
                    return Err("Worker archive run alias capacity exceeded".into());
                }
                aliases.insert(id.to_owned());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    struct Fixture {
        profile: PathBuf,
        directory: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let profile =
                std::env::temp_dir().join(format!("ccgui-worker-archive-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&profile).unwrap();
            let profile = dunce::canonicalize(profile).unwrap();
            let directory = profile.join("runtime/task-workers/worker-test");
            std::fs::create_dir_all(&directory).unwrap();
            let manifest = WorkerManifest {
                protocol: PROTOCOL,
                worker_id: "worker-test".into(),
                run_id: "run-test".into(),
                profile: profile.clone(),
                executable: profile.join("removed-old-worker.exe"),
                pid: 0,
                process_start_time: 0,
                port: 1,
                token: "a".repeat(64),
                schema_hash: "b".repeat(64),
            };
            std::fs::write(
                directory.join("manifest.retired.json"),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
            std::fs::write(directory.join("events.jsonl"), []).unwrap();
            std::fs::write(directory.join("receipts.jsonl"), []).unwrap();
            Self { profile, directory }
        }
        fn append(&self, filename: &str, record: Value) {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(self.directory.join(filename))
                .unwrap();
            serde_json::to_writer(&mut file, &record).unwrap();
            file.write_all(b"\n").unwrap();
        }
        fn event(&self, seq: u64, payload: Value) {
            self.append("events.jsonl", json!({"stream_id":"worker-test","seq":seq,"name":"engine://event","payload":payload}));
        }
        fn open(&self) -> Result<Archive, String> {
            open(&self.profile, "worker-test")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Delete only this fixture's fixed files, then empty fixed directories.
            for file in ["manifest.retired.json", "events.jsonl", "receipts.jsonl"] {
                let _ = std::fs::remove_file(self.directory.join(file));
            }
            let _ = std::fs::remove_dir(&self.directory);
            let _ = std::fs::remove_dir(self.profile.join("runtime/task-workers"));
            let _ = std::fs::remove_dir(self.profile.join("runtime"));
            let _ = std::fs::remove_dir(&self.profile);
        }
    }

    #[test]
    fn replays_unicode_and_one_complete_nine_mib_event_without_process_or_executable() {
        let fixture = Fixture::new();
        fixture.event(1, json!([{"kind":"session","data":"session-中文"}]));
        let text = "中文😀".repeat(950_000);
        assert!(text.len() > 9 * 1024 * 1024);
        fixture.event(2, json!([{"kind":"delta","text":text}]));
        fixture.event(3, json!([{"kind":"done"}]));
        let archive = fixture.open().unwrap();
        assert_eq!(archive.head(), 3);
        assert_eq!(archive.session_id().as_deref(), Some("session-中文"));
        assert_eq!(archive.manifest().run_id, "run-test");
        assert_eq!(archive.replay(0, 512).unwrap().through, 1);
        let large = archive.replay(1, 512).unwrap();
        assert_eq!(large.through, 2);
        assert_eq!(large.events.len(), 1);
        assert_eq!(large.events[0].payload[0]["text"], text);
        assert_eq!(archive.replay(2, 512).unwrap().through, 3);
        assert!(archive.replay(3, 1).unwrap().events.is_empty());
        assert!(archive.replay(4, 1).is_err());
        assert!(archive.replay(0, 0).is_err());
        assert!(archive.replay(0, 513).is_err());
    }

    #[test]
    fn rejects_partial_tails_missing_duplicate_and_cross_stream_sequences() {
        for records in [vec![1, 3], vec![1, 1], vec![2]] {
            let fixture = Fixture::new();
            for seq in records {
                fixture.event(seq, json!("text"));
            }
            assert!(fixture.open().is_err());
        }
        let fixture = Fixture::new();
        fixture.event(1, json!("text"));
        let path = fixture.directory.join("events.jsonl");
        let length = std::fs::metadata(&path).unwrap().len();
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_len(length - 1)
            .unwrap();
        assert!(fixture.open().err().unwrap().contains("partial"));
        let fixture = Fixture::new();
        fixture.append(
            "events.jsonl",
            json!({"stream_id":"another-worker","seq":1,"name":"delta","payload":null}),
        );
        assert!(fixture.open().is_err());
    }

    #[test]
    fn returns_exact_last_completed_outcome_and_never_treats_accepted_as_unexecuted() {
        let fixture = Fixture::new();
        fixture.append(
            "receipts.jsonl",
            json!({"id":"complete","phase":"accepted","fingerprint":"a".repeat(64)}),
        );
        fixture.append(
            "receipts.jsonl",
            json!({"id":"complete","phase":"completed","outcome":{"Ok":{"text":"中文😀"}}}),
        );
        let last = WorkerError::unknown("receipt_unknown", "native failure");
        fixture.append(
            "receipts.jsonl",
            json!({"id":"complete","phase":"completed","outcome":{"Err":last}}),
        );
        fixture.append(
            "receipts.jsonl",
            json!({"id":"pending","phase":"accepted","fingerprint":"b".repeat(64)}),
        );
        let archive = fixture.open().unwrap();
        assert_eq!(archive.receipt("complete").unwrap(), Some(Err(last)));
        assert!(
            archive
                .receipt("pending")
                .unwrap()
                .unwrap()
                .unwrap_err()
                .outcome_unknown
        );
        assert_eq!(archive.receipt("absent").unwrap(), None);
        assert!(archive.receipt("../escape").is_err());
    }

    #[test]
    fn mutation_receipt_requires_the_exact_original_command_fingerprint() {
        let fixture = Fixture::new();
        let command = Command::Followup {
            prompt: "原文😀".into(),
            image_paths: Some(vec!["image.png".into()]),
        };
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&command).unwrap())
        );
        for id in ["complete", "pending"] {
            fixture.append(
                "receipts.jsonl",
                json!({"id":id,"phase":"accepted","fingerprint":fingerprint}),
            );
        }
        fixture.append(
            "receipts.jsonl",
            json!({"id":"complete","phase":"completed","outcome":{"Ok":{"sent":true}}}),
        );
        let archive = fixture.open().unwrap();
        assert_eq!(
            archive.receipt_for("complete", &command).unwrap(),
            Some(Ok(json!({"sent":true})))
        );
        assert!(
            archive
                .receipt_for("pending", &command)
                .unwrap()
                .unwrap()
                .unwrap_err()
                .outcome_unknown
        );
        let changed = Command::Followup {
            prompt: "changed".into(),
            image_paths: Some(vec!["image.png".into()]),
        };
        for id in ["complete", "pending"] {
            let conflict = archive
                .receipt_for(id, &changed)
                .unwrap()
                .unwrap()
                .unwrap_err();
            assert_eq!(conflict.code, "request_conflict");
            assert!(!conflict.outcome_unknown);
        }
        assert_eq!(archive.receipt_for("absent", &command).unwrap(), None);
        assert!(archive.receipt_for("../escape", &command).is_err());
        assert!(MAX_EVENTS * std::mem::size_of::<Record>() < INDEX_BYTES);
    }

    #[test]
    fn continuation_run_aliases_preserve_exact_followup_receipt_recovery() {
        let fixture = Fixture::new();
        fixture.event(
            1,
            json!([{"runId":"run-X-c1","kind":"delta","data":"continued 中文😀"}]),
        );
        fixture.event(2, json!([{"runId":"run-X-c1","kind":"done"},{"runId":"run-X-c2","kind":"delta","data":"next"}]));
        let command = Command::Followup {
            prompt: "already accepted".into(),
            image_paths: None,
        };
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&command).unwrap())
        );
        fixture.append(
            "receipts.jsonl",
            json!({"id":"followup-stable","phase":"accepted","fingerprint":fingerprint}),
        );
        fixture.append(
            "receipts.jsonl",
            json!({"id":"followup-stable","phase":"completed","outcome":{"Ok":true}}),
        );
        let archive = fixture.open().unwrap();
        assert_eq!(archive.run_ids(), vec!["run-X-c1", "run-X-c2", "run-test"]);
        assert_eq!(
            archive.receipt_for("followup-stable", &command).unwrap(),
            Some(Ok(json!(true)))
        );
    }

    #[test]
    fn run_aliases_reject_invalid_identifiers_and_overflow_without_truncation() {
        for id in [
            json!("../escape"),
            json!(""),
            json!(null),
            json!(17),
            json!("x".repeat(129)),
        ] {
            let fixture = Fixture::new();
            fixture.event(1, json!([{"runId":id,"kind":"done"}]));
            assert!(fixture.open().err().unwrap().contains("invalid run alias"));
        }
        let mut aliases: BTreeSet<String> =
            (0..MAX_RUN_ALIASES).map(|id| format!("run-{id}")).collect();
        let duplicate = EventEnvelope {
            stream_id: "worker-test".into(),
            seq: 1,
            name: "engine://event".into(),
            payload: json!([{"runId":"run-0"}]),
        };
        assert!(collect_run_ids(&duplicate, &mut aliases).is_ok());
        let extra = EventEnvelope {
            payload: json!([{"runId":"one-too-many"}]),
            ..duplicate
        };
        assert!(collect_run_ids(&extra, &mut aliases)
            .unwrap_err()
            .contains("capacity"));
        assert_eq!(aliases.len(), MAX_RUN_ALIASES);
        assert!(!aliases.contains("one-too-many"));
    }

    #[test]
    fn rejects_receipt_conflicts_or_completions_without_acceptance() {
        let fixture = Fixture::new();
        fixture.append(
            "receipts.jsonl",
            json!({"id":"request","phase":"accepted","fingerprint":"a".repeat(64)}),
        );
        fixture.append(
            "receipts.jsonl",
            json!({"id":"request","phase":"accepted","fingerprint":"b".repeat(64)}),
        );
        assert!(fixture.open().is_err());
        let fixture = Fixture::new();
        fixture.append(
            "receipts.jsonl",
            json!({"id":"request","phase":"completed","outcome":{"Ok":true}}),
        );
        assert!(fixture.open().is_err());
        let fixture = Fixture::new();
        std::fs::write(
            fixture.directory.join("receipts.jsonl"),
            b"{\"phase\":\"accepted\"",
        )
        .unwrap();
        assert!(fixture.open().err().unwrap().contains("partial"));
    }

    #[test]
    fn detects_event_receipt_and_manifest_changes_after_indexing() {
        for filename in ["events.jsonl", "receipts.jsonl", "manifest.retired.json"] {
            let fixture = Fixture::new();
            fixture.event(1, json!("first"));
            let archive = fixture.open().unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(fixture.directory.join(filename))
                .unwrap()
                .set_len(0)
                .unwrap();
            assert!(archive.replay(0, 1).is_err());
            assert!(archive.receipt("absent").is_err());
        }
    }

    #[test]
    fn rejects_scope_escape_and_manifest_identity_mismatch() {
        let fixture = Fixture::new();
        assert!(open(&fixture.profile, "../worker-test").is_err());
        assert!(open(&fixture.profile.join("runtime/.."), "worker-test").is_err());
        let manifest_path = fixture.directory.join("manifest.retired.json");
        let original: Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        for (key, value) in [
            ("workerId", json!("other-worker")),
            ("runId", json!("../other")),
            ("protocol", json!(PROTOCOL + 1)),
            ("profile", json!(fixture.profile.join("elsewhere"))),
        ] {
            let mut changed = original.clone();
            changed[key] = value;
            std::fs::write(&manifest_path, serde_json::to_vec(&changed).unwrap()).unwrap();
            assert!(fixture.open().is_err());
        }
    }

    #[test]
    fn bounded_line_reader_rejects_oversize_without_consuming_unbounded_input() {
        let mut reader = BufReader::new(&b"12345\n"[..]);
        assert!(read_line(&mut reader, &mut Vec::new(), 4).is_err());
        let mut reader = BufReader::new(&b"1234\n"[..]);
        assert!(read_line(&mut reader, &mut Vec::new(), 4).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_event_file_even_when_target_is_in_same_profile() {
        let fixture = Fixture::new();
        let path = fixture.directory.join("events.jsonl");
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(fixture.directory.join("receipts.jsonl"), &path).unwrap();
        assert!(fixture.open().is_err());
    }
}
