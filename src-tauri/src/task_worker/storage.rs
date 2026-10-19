use super::protocol::{WorkerError, WorkerManifest};
use crate::runtime_events::EventEnvelope;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

fn io_error(context: &str) -> WorkerError {
    // OS messages can contain staging or credential paths. Expose a bounded cause.
    WorkerError::new("worker_storage", context)
}

/// Every worker gets a new directory, so no stale archive can be overwritten.
pub(crate) fn create_directory(profile: &Path, worker_id: &str) -> Result<PathBuf, WorkerError> {
    let root = profile.join("runtime");
    private_directory(&root)?;
    let workers = root.join("task-workers");
    private_directory(&workers)?;
    let directory = workers.join(worker_id);
    std::fs::create_dir(&directory)
        .map_err(|_| io_error("Create unique worker directory failed"))?;
    restrict_directory(&directory)?;
    if dunce::canonicalize(&directory).map_err(|_| io_error("Resolve worker directory failed"))?
        != directory
    {
        return Err(io_error(
            "Worker directory must not redirect outside its profile",
        ));
    }
    Ok(directory)
}

pub(crate) fn private_directory(path: &Path) -> Result<(), WorkerError> {
    match std::fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(io_error("Create private runtime directory failed")),
    }
    let meta =
        std::fs::symlink_metadata(path).map_err(|_| io_error("Read runtime directory failed"))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(io_error("Runtime directory must be a real directory"));
    }
    if dunce::canonicalize(path).map_err(|_| io_error("Resolve runtime directory failed"))? != path
    {
        return Err(io_error("Runtime directory must remain inside the profile"));
    }
    restrict_directory(path)
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> Result<(), WorkerError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| io_error("Restrict worker directory permissions failed"))
}

#[cfg(windows)]
fn restrict_directory(path: &Path) -> Result<(), WorkerError> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    // Protected DACL: only the object's owner and SYSTEM; descendants inherit.
    // Raw declarations avoid requiring the unrelated windows Authorization feature.
    #[link(name = "advapi32")]
    extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut *mut c_void,
            size: *mut u32,
        ) -> i32;
        fn SetFileSecurityW(path: *const u16, information: u32, descriptor: *mut c_void) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    let text: Vec<u16> = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;OW)"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(io_error("Build private runtime permissions failed"));
        }
        let ok = SetFileSecurityW(path.as_ptr(), 0x8000_0004, descriptor) != 0;
        LocalFree(descriptor);
        if ok {
            Ok(())
        } else {
            Err(io_error("Restrict worker directory permissions failed"))
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn restrict_directory(_: &Path) -> Result<(), WorkerError> {
    Err(io_error(
        "Private worker directories are unsupported on this platform",
    ))
}

pub(crate) fn private_file(path: &Path) -> Result<File, WorkerError> {
    let mut options = OpenOptions::new();
    options.create_new(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| io_error("Create private worker file failed"))
}

pub(crate) fn publish_manifest(
    directory: &Path,
    manifest: &WorkerManifest,
) -> Result<(), WorkerError> {
    let pending = directory.join("manifest.pending");
    let mut file = private_file(&pending)?;
    serde_json::to_writer(&mut file, manifest)
        .map_err(|_| io_error("Encode worker manifest failed"))?;
    file.write_all(b"\n")
        .and_then(|_| file.sync_all())
        .map_err(|_| io_error("Persist worker manifest failed"))?;
    drop(file);
    std::fs::rename(pending, directory.join("manifest.json"))
        .map_err(|_| io_error("Publish worker manifest failed"))
}

pub(crate) fn retire_manifest(directory: &Path) -> Result<(), WorkerError> {
    // Keep archives and the final credential available to the same owner for
    // diagnosis. Discovery only reads manifest.json, never manifest.retired.json.
    std::fs::rename(
        directory.join("manifest.json"),
        directory.join("manifest.retired.json"),
    )
    .map_err(|_| io_error("Retire worker manifest failed"))
}

struct JournalState {
    file: File,
    records: Vec<StoredEvent>,
    end: u64,
    pending: VecDeque<PendingEvent>,
    pending_bytes: usize,
    session_id: Option<String>,
    fault: bool,
    #[cfg(test)]
    write_failure: bool,
}

struct PendingEvent {
    bytes: Vec<u8>,
    sha256: String,
}

struct StoredEvent {
    offset: u64,
    total_bytes: u64,
    sha256: String,
}

const PAGE_BYTES: usize = 2 * 1024 * 1024;

fn envelope_size(stream_id: &str, name: &str, payload: &Value) -> usize {
    #[derive(Serialize)]
    struct BorrowedEnvelope<'a> {
        stream_id: &'a str,
        seq: u64,
        name: &'a str,
        payload: &'a Value,
    }
    struct Counter(usize);
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .ok_or_else(|| std::io::Error::other("event size overflow"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Counter(0);
    serde_json::to_writer(
        &mut count,
        &BorrowedEnvelope {
            stream_id,
            seq: u64::MAX,
            name,
            payload,
        },
    )
    .expect("event envelope is serializable");
    count.0
}

/// Append-only worker lifetime journal. No retention eviction while a run is live.
/// Disk failures retain a bounded serialized backlog. Once full, producers wait
/// and retry persistence: the engine's stdout pipe then supplies backpressure.
/// No event is dropped and no failed write is acknowledged as durable. A single
/// event larger than the backlog budget occupies the queue alone (its size is
/// bounded by the negotiated event limit). Control requests can time out while
/// the single-thread engine runtime is backpressured; they must retain their IDs.
pub(crate) struct Journal {
    stream_id: String,
    state: Mutex<JournalState>,
    space: Condvar,
    max_pending_bytes: usize,
    max_pending_events: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsPage {
    pub stream_id: String,
    pub through: u64,
    pub head: u64,
    pub durable_through: u64,
    pub events: Vec<EventEnvelope>,
    /// The next event is too large for an inline page. `through` must not advance
    /// across it until the client has assembled and verified every byte.
    pub fragment: Option<EventFragment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventFragment {
    pub stream_id: String,
    pub seq: u64,
    pub total_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventChunk {
    pub event: EventFragment,
    pub offset: u64,
    pub data_base64: String,
}

impl Journal {
    pub(crate) fn new(directory: &Path, stream_id: String) -> Result<Self, WorkerError> {
        Ok(Self {
            stream_id,
            state: Mutex::new(JournalState {
                file: private_file(&directory.join("events.jsonl"))?,
                records: Vec::new(),
                end: 0,
                pending: VecDeque::new(),
                pending_bytes: 0,
                session_id: None,
                fault: false,
                #[cfg(test)]
                write_failure: false,
            }),
            space: Condvar::new(),
            max_pending_bytes: 16 * 1024 * 1024,
            max_pending_events: 256,
        })
    }

    pub(crate) fn append(&self, name: &str, payload: Value) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Measuring at the largest sequence gives an upper bound without
        // reserving a sequence before a potentially blocking admission wait.
        let estimate = envelope_size(&self.stream_id, name, &payload);
        loop {
            Self::persist(&mut state);
            let room = state.pending.is_empty()
                || (state.pending.len() < self.max_pending_events
                    && estimate <= self.max_pending_bytes.saturating_sub(state.pending_bytes));
            if room {
                break;
            }
            state = self
                .space
                .wait_timeout(state, Duration::from_millis(100))
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        let seq = (state.records.len() + state.pending.len()) as u64 + 1;
        if name == crate::event_sink::ENGINE_EVENT_NAME {
            if let Some(events) = payload.as_array() {
                for event in events {
                    let session = event.get("sessionId").and_then(Value::as_str).or_else(|| {
                        (event["kind"] == "session")
                            .then(|| event["data"].as_str())
                            .flatten()
                    });
                    if let Some(session) =
                        session.filter(|session| !session.is_empty() && session.len() <= 256)
                    {
                        state.session_id = Some(session.into());
                    }
                }
            }
        }
        let bytes = serde_json::to_vec(&EventEnvelope {
            stream_id: self.stream_id.clone(),
            seq,
            name: name.into(),
            payload,
        })
        .expect("event envelope is serializable");
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        state.pending_bytes += bytes.len();
        state.pending.push_back(PendingEvent { bytes, sha256 });
        Self::persist(&mut state);
        self.space.notify_all();
    }

    fn persist(state: &mut JournalState) {
        while let Some(event) = state.pending.front() {
            #[cfg(test)]
            if state.write_failure {
                state.fault = true;
                return;
            }
            let total_bytes = event.bytes.len() as u64;
            let end = state.end;
            // Truncate a partial previous write before retrying the same sequence.
            let written = state
                .file
                .set_len(end)
                .and_then(|_| state.file.seek(SeekFrom::Start(end)))
                .and_then(|_| state.file.write_all(&event.bytes))
                .and_then(|_| state.file.write_all(b"\n"))
                .and_then(|_| state.file.sync_data());
            if written.is_err() {
                state.fault = true;
                return;
            }
            state.records.push(StoredEvent {
                offset: end,
                total_bytes,
                sha256: event.sha256.clone(),
            });
            state.end += total_bytes + 1;
            state.pending_bytes -= total_bytes as usize;
            state.pending.pop_front();
        }
        state.fault = false;
    }

    pub(crate) fn watermarks(&self) -> (u64, u64, bool) {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        (
            (state.records.len() + state.pending.len()) as u64,
            state.records.len() as u64,
            state.fault,
        )
    }

    pub(crate) fn session_id(&self) -> Option<String> {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .session_id
            .clone()
    }

    pub(crate) fn replay(
        &self,
        stream_id: &str,
        after: u64,
        limit: usize,
    ) -> Result<EventsPage, WorkerError> {
        if stream_id != self.stream_id {
            return Err(WorkerError::new(
                "stream_mismatch",
                "Worker event stream changed",
            ));
        }
        if limit == 0 || limit > 512 {
            return Err(WorkerError::new(
                "invalid_limit",
                "Expected 1 to 512 events",
            ));
        }
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        Self::persist(&mut state);
        self.space.notify_all();
        let durable = state.records.len() as u64;
        let head = durable + state.pending.len() as u64;
        if after > head {
            return Err(WorkerError::new(
                "cursor_ahead",
                "Event cursor exceeds worker head",
            ));
        }
        let mut events = Vec::new();
        let mut bytes = 0;
        let mut fragment = None;
        for seq in after + 1..=head {
            if events.len() == limit {
                break;
            }
            let descriptor = self.descriptor(&state, seq)?;
            if descriptor.total_bytes > PAGE_BYTES as u64 {
                fragment = Some(descriptor);
                break;
            }
            if !events.is_empty() && bytes + descriptor.total_bytes as usize > PAGE_BYTES {
                break;
            }
            let event = if seq <= durable {
                let offset = state.records[(seq - 1) as usize].offset;
                state
                    .file
                    .seek(SeekFrom::Start(offset))
                    .map_err(|_| io_error("Seek worker event journal failed"))?;
                let mut line = String::new();
                BufReader::new(&mut state.file)
                    .read_line(&mut line)
                    .map_err(|_| io_error("Read worker event journal failed"))?;
                serde_json::from_str::<EventEnvelope>(&line)
                    .map_err(|_| io_error("Worker event journal is invalid"))?
            } else {
                serde_json::from_slice::<EventEnvelope>(
                    &state.pending[(seq - durable - 1) as usize].bytes,
                )
                .map_err(|_| io_error("Decode pending worker event failed"))?
            };
            bytes += descriptor.total_bytes as usize;
            events.push(event);
        }
        Ok(EventsPage {
            stream_id: self.stream_id.clone(),
            through: events.last().map_or(after, |event| event.seq),
            head,
            durable_through: durable,
            events,
            fragment,
        })
    }

    fn descriptor(&self, state: &JournalState, seq: u64) -> Result<EventFragment, WorkerError> {
        if seq == 0 || seq > (state.records.len() + state.pending.len()) as u64 {
            return Err(WorkerError::new(
                "event_unavailable",
                "Event sequence is not present in this worker journal",
            ));
        }
        let (total_bytes, sha256) = if seq <= state.records.len() as u64 {
            let record = &state.records[(seq - 1) as usize];
            (record.total_bytes, record.sha256.clone())
        } else {
            let pending = &state.pending[(seq - 1 - state.records.len() as u64) as usize];
            (pending.bytes.len() as u64, pending.sha256.clone())
        };
        Ok(EventFragment {
            stream_id: self.stream_id.clone(),
            seq,
            total_bytes,
            sha256,
        })
    }

    /// Byte offsets are into the exact JSON envelope, excluding the journal's
    /// newline. Durable events are read with bounded I/O, without loading or
    /// serializing the full event for every chunk.
    pub(crate) fn chunk(
        &self,
        stream_id: &str,
        seq: u64,
        offset: u64,
        limit: usize,
    ) -> Result<EventChunk, WorkerError> {
        if stream_id != self.stream_id {
            return Err(WorkerError::new(
                "stream_mismatch",
                "Worker event stream changed",
            ));
        }
        if limit == 0 || limit > super::protocol::EVENT_CHUNK_BYTES {
            return Err(WorkerError::new(
                "invalid_limit",
                "Event chunk limit exceeds the negotiated bound",
            ));
        }
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        Self::persist(&mut state);
        self.space.notify_all();
        let event = self.descriptor(&state, seq)?;
        if offset >= event.total_bytes {
            return Err(WorkerError::new(
                "invalid_offset",
                "Event chunk offset is outside the envelope",
            ));
        }
        let length = std::cmp::min(limit as u64, event.total_bytes - offset) as usize;
        let data = if seq <= state.records.len() as u64 {
            let start = state.records[(seq - 1) as usize]
                .offset
                .checked_add(offset)
                .ok_or_else(|| io_error("Event journal offset overflow"))?;
            state
                .file
                .seek(SeekFrom::Start(start))
                .map_err(|_| io_error("Seek worker event chunk failed"))?;
            let mut data = vec![0; length];
            state
                .file
                .read_exact(&mut data)
                .map_err(|_| io_error("Read worker event chunk failed"))?;
            data
        } else {
            let pending = &state.pending[(seq - 1 - state.records.len() as u64) as usize];
            pending.bytes[offset as usize..offset as usize + length].to_vec()
        };
        Ok(EventChunk {
            event,
            offset,
            data_base64: base64::engine::general_purpose::STANDARD.encode(data),
        })
    }
}

pub(crate) struct ReceiptLog(Mutex<(File, u64)>);
impl ReceiptLog {
    pub(crate) fn new(directory: &Path) -> Result<Self, WorkerError> {
        Ok(Self(Mutex::new((
            private_file(&directory.join("receipts.jsonl"))?,
            0,
        ))))
    }
    pub(crate) fn append(&self, value: &Value) -> Result<(), WorkerError> {
        let mut bytes =
            serde_json::to_vec(value).map_err(|_| io_error("Encode command receipt failed"))?;
        bytes.push(b'\n');
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let (file, end) = &mut *state;
        file.set_len(*end)
            .and_then(|_| file.seek(SeekFrom::Start(*end)))
            .and_then(|_| file.write_all(&bytes))
            .and_then(|_| file.sync_data())
            .map_err(|_| {
                WorkerError::unknown(
                    "receipt_storage",
                    "Persist command receipt failed; query the same request ID",
                )
            })?;
        *end += bytes.len() as u64;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn journal_replays_complete_sequences_and_keeps_archive_after_reader_disconnect() {
        let directory =
            std::env::temp_dir().join(format!("ccgui-worker-journal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let journal = Journal::new(&directory, "worker-test".into()).unwrap();
        for n in 1..=520 {
            journal.append("engine://event", json!([{ "seq": n, "text": "中文🦀" }]));
        }
        let first = journal.replay("worker-test", 0, 512).unwrap();
        assert_eq!(
            (first.through, first.head, first.durable_through),
            (512, 520, 520)
        );
        let next = journal.replay("worker-test", first.through, 512).unwrap();
        assert_eq!(
            next.events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            (513..=520).collect::<Vec<_>>()
        );
        assert_eq!(
            journal.replay("worker-test", 520, 1).unwrap().events.len(),
            0
        );
        assert_eq!(
            journal.replay("other", 0, 1).unwrap_err().code,
            "stream_mismatch"
        );
        assert_eq!(
            journal.replay("worker-test", 521, 1).unwrap_err().code,
            "cursor_ahead"
        );
        drop(journal);
        assert_eq!(
            BufReader::new(File::open(directory.join("events.jsonl")).unwrap())
                .lines()
                .count(),
            520
        );
        std::fs::remove_file(directory.join("events.jsonl")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn disk_failure_bounds_backlog_and_backpressures_until_persistence_recovers() {
        let directory =
            std::env::temp_dir().join(format!("ccgui-worker-pressure-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut journal = Journal::new(&directory, "bounded".into()).unwrap();
        journal.max_pending_bytes = 256;
        journal.max_pending_events = 2;
        journal.state.lock().unwrap().write_failure = true;
        let journal = std::sync::Arc::new(journal);
        journal.append("event", json!("x".repeat(100)));
        assert_eq!(journal.watermarks(), (1, 0, true));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let (sent, completed) = std::sync::mpsc::channel();
        let writer = {
            let journal = journal.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                journal.append("event", json!("y".repeat(100)));
                sent.send(()).unwrap();
            })
        };
        barrier.wait();
        assert!(matches!(
            completed.recv_timeout(Duration::from_millis(150)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        {
            let state = journal.state.lock().unwrap();
            assert!(state.pending_bytes <= journal.max_pending_bytes);
            assert_eq!(state.pending.len(), 1);
            assert_eq!(state.records.len(), 0);
        }
        journal.state.lock().unwrap().write_failure = false;
        let _ = journal.replay("bounded", 0, 10).unwrap();
        completed.recv_timeout(Duration::from_secs(2)).unwrap();
        writer.join().unwrap();
        let page = journal.replay("bounded", 0, 10).unwrap();
        assert_eq!((page.through, page.durable_through), (2, 2));
        assert_eq!(page.events[0].payload, json!("x".repeat(100)));
        assert_eq!(page.events[1].payload, json!("y".repeat(100)));
        assert_eq!(journal.state.lock().unwrap().pending_bytes, 0);
        drop(journal);
        std::fs::remove_file(directory.join("events.jsonl")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
