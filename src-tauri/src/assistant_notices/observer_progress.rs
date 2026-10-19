//! Optional schema-3 extension. Progress never occupies or acknowledges a completion slot.
use super::*;
use std::collections::VecDeque;

const CHECKPOINT_TTL_MS: u64 = 180_000;
const ATTEMPT_INTERVAL_MS: u64 = 30_000;
const CHECKPOINT_CHARS: usize = 1_500;
const MIN_CHECKPOINT_CHARS: usize = 80;
const FINGERPRINT_CAP: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    pub id: String,
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
    pub prompt: String,
    pub summary: String,
    pub started_at_ms: u64,
    pub captured_at_ms: u64,
    pub observer_generation: u64,
    root: String,
    token: String,
    admission_generation: u64,
}

#[derive(Default)]
pub(super) struct ProgressCapture {
    last_attempt_ms: Option<u64>,
    fingerprints: VecDeque<[u8; 32]>,
}

pub(super) fn initialize(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS observer_readiness (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), format INTEGER NOT NULL CHECK(format=1),
            generation INTEGER NOT NULL, ready_until_ms INTEGER NOT NULL);
         INSERT OR IGNORE INTO observer_readiness VALUES(1,1,0,0);
         CREATE TABLE IF NOT EXISTS observer_checkpoints (
            root TEXT PRIMARY KEY,
            format INTEGER NOT NULL CHECK(format=1), id TEXT NOT NULL UNIQUE,
            token TEXT NOT NULL, admission_generation INTEGER NOT NULL,
            engine TEXT NOT NULL, session_id TEXT NOT NULL, workspace_path TEXT NOT NULL,
            prompt TEXT NOT NULL, summary TEXT NOT NULL, started_at_ms INTEGER NOT NULL,
            captured_at_ms INTEGER NOT NULL, observer_generation INTEGER NOT NULL);"
    ).map_err(storage)
}

fn ready_generation(connection: &Connection, now: u64) -> Result<Option<u64>, String> {
    connection.query_row(
        "SELECT generation FROM observer_readiness WHERE singleton=1 AND format=1 AND generation>0 AND ready_until_ms>?1",
        [sqlite_u64(now)?], |row| row.get(0),
    ).optional().map_err(storage)
}

fn current(connection: &Connection, checkpoint: &Checkpoint, now: u64) -> Result<bool, String> {
    if now > MAX_MS
        || checkpoint.captured_at_ms > now
        || now.saturating_sub(checkpoint.captured_at_ms) > CHECKPOINT_TTL_MS
        || ready_generation(connection, now)? != Some(checkpoint.observer_generation)
    {
        return Ok(false);
    }
    let metadata: Option<Option<String>> = connection.query_row(
        "SELECT metadata_json FROM slots WHERE root=?1 AND token=?2 AND generation=?3 AND active=1",
        params![checkpoint.root, checkpoint.token, sqlite_u64(checkpoint.admission_generation)?],
        |row| row.get(0),
    ).optional().map_err(storage)?;
    let Some(Some(metadata)) = metadata else {
        return Ok(false);
    };
    let Ok(phase) = serde_json::from_str::<Pending>(&metadata) else {
        return Ok(false);
    };
    if !(phase.started
        && phase.generation == checkpoint.admission_generation
        && phase.started_at_ms == checkpoint.started_at_ms
        && phase.engine == checkpoint.engine
        && phase.session_id == checkpoint.session_id
        && phase.workspace_path == checkpoint.workspace_path)
    {
        return Ok(false);
    }
    // A subsequent turn can use another worker/root. Both active and unACKed
    // inactive slots carry authoritative source/turn metadata. Equal timestamps
    // on distinct reservations are ambiguous, so neither may publish progress.
    let mut statement = connection
        .prepare("SELECT root,token,metadata_json FROM slots LIMIT ?1")
        .map_err(storage)?;
    let rows = statement
        .query_map([(SLOT_CAP + 1) as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(storage)?;
    for (index, row) in rows.enumerate() {
        if index >= SLOT_CAP {
            return Ok(false);
        }
        let (root, token, metadata) = row.map_err(storage)?;
        let Some(metadata) = metadata else {
            continue;
        };
        let Ok(other) = serde_json::from_str::<Pending>(&metadata) else {
            continue;
        };
        if other.engine == checkpoint.engine
            && other.session_id == checkpoint.session_id
            && other.workspace_path == checkpoint.workspace_path
            && (other.started_at_ms > checkpoint.started_at_ms
                || other.started_at_ms == checkpoint.started_at_ms
                    && (root != checkpoint.root || token != checkpoint.token))
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn load_checkpoints(connection: &Connection) -> Result<Vec<Checkpoint>, String> {
    let mut statement = connection.prepare(
        "SELECT id,engine,session_id,workspace_path,prompt,summary,started_at_ms,captured_at_ms,observer_generation,root,token,admission_generation
         FROM observer_checkpoints WHERE format=1 ORDER BY captured_at_ms,id LIMIT ?1",
    ).map_err(storage)?;
    let rows = statement
        .query_map([SLOT_CAP as i64], |row| {
            Ok(Checkpoint {
                id: row.get(0)?,
                engine: row.get(1)?,
                session_id: row.get(2)?,
                workspace_path: row.get(3)?,
                prompt: row.get(4)?,
                summary: row.get(5)?,
                started_at_ms: row.get(6)?,
                captured_at_ms: row.get(7)?,
                observer_generation: row.get(8)?,
                root: row.get(9)?,
                token: row.get(10)?,
                admission_generation: row.get(11)?,
            })
        })
        .map_err(storage)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage)
}

impl Outbox {
    /// Refresh a policy generation's lease; zero expiry revokes it. Resume with a new
    /// generation so an already ACKed checkpoint cannot become current again.
    pub fn set_observer_ready(&self, generation: u64, ready_until_ms: u64) -> Result<(), String> {
        if generation > MAX_MS || ready_until_ms > MAX_MS || generation == 0 && ready_until_ms != 0
        {
            return Err("invalid_request".into());
        }
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let changed = transaction.execute(
            "UPDATE observer_readiness SET generation=?1,ready_until_ms=?2 WHERE singleton=1 AND format=1",
            params![sqlite_u64(generation)?, sqlite_u64(ready_until_ms)?],
        ).map_err(storage)?;
        if changed != 1 {
            return Err("storage_unavailable".into());
        }
        if ready_until_ms == 0 {
            transaction
                .execute("DELETE FROM observer_checkpoints", [])
                .map_err(storage)?;
        }
        transaction.commit().map_err(storage)
    }

    pub fn observer_pending(&self, limit: usize, now: u64) -> Result<Vec<Checkpoint>, String> {
        if now > MAX_MS {
            return Err("invalid_request".into());
        }
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        // The independent progress cap bounds this scan. Filtering before the
        // caller's limit prevents stale roots from starving current checkpoints.
        let candidates = load_checkpoints(&transaction)?;
        let mut checkpoints = Vec::new();
        for checkpoint in candidates {
            if current(&transaction, &checkpoint, now)? {
                checkpoints.push(checkpoint);
            } else {
                transaction
                    .execute(
                        "DELETE FROM observer_checkpoints WHERE id=?1",
                        [&checkpoint.id],
                    )
                    .map_err(storage)?;
            }
        }
        checkpoints.truncate(limit.min(SLOT_CAP));
        transaction.commit().map_err(storage)?;
        Ok(checkpoints)
    }

    /// ACK only this exact checkpoint, never a newer replacement on its root.
    pub fn finish_checkpoint(&self, id: &str) -> Result<(), String> {
        self.connection
            .lock()
            .execute("DELETE FROM observer_checkpoints WHERE id=?1", [id])
            .map_err(storage)?;
        Ok(())
    }

    /// Caller holds its policy lock. The synchronous closure must not call this
    /// outbox; the IMMEDIATE transaction linearizes publication with start/cancel.
    /// An ACK removes delivery state, not the private proof carried by a copy.
    pub fn with_current_checkpoint<T>(
        &self,
        checkpoint: &Checkpoint,
        now: u64,
        closure: impl FnOnce() -> T,
    ) -> Result<Option<T>, String> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if !current(&transaction, checkpoint, now)? {
            return Ok(None);
        }
        let result = closure();
        transaction.commit().map_err(storage)?;
        Ok(Some(result))
    }

    fn persist_checkpoint(&self, run: &Run, summary: String, now: u64) -> Result<bool, String> {
        let Some(session) = &run.session else {
            return Ok(false);
        };
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let Some(observer_generation) = ready_generation(&transaction, now)? else {
            return Ok(false);
        };
        let checkpoint = Checkpoint {
            id: uuid::Uuid::new_v4().to_string(),
            engine: run.engine.clone(),
            session_id: session.clone(),
            workspace_path: run.workspace.clone(),
            prompt: run.prompt.clone(),
            summary,
            started_at_ms: run.started_at_ms,
            captured_at_ms: now,
            observer_generation,
            root: run.reservation.root.clone(),
            token: run.reservation.token.clone(),
            admission_generation: run.reservation.generation,
        };
        if !current(&transaction, &checkpoint, now)? {
            return Ok(false);
        }
        // No FK: optional cleanup failures cannot block completion ACKs or slot
        // release. Reclaim whatever stale rows can be removed, then independently
        // enforce the same bounded storage budget before admitting another root.
        for old in load_checkpoints(&transaction)? {
            if !current(&transaction, &old, now)? {
                let _ =
                    transaction.execute("DELETE FROM observer_checkpoints WHERE id=?1", [&old.id]);
            }
        }
        let (count, replacing): (usize, bool) = transaction.query_row(
            "SELECT COUNT(*),EXISTS(SELECT 1 FROM observer_checkpoints WHERE root=?1) FROM observer_checkpoints",
            [&checkpoint.root], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(storage)?;
        if count >= SLOT_CAP && !replacing {
            transaction.commit().map_err(storage)?;
            return Ok(false);
        }
        transaction.execute(
            "INSERT OR REPLACE INTO observer_checkpoints(root,format,id,token,admission_generation,engine,session_id,workspace_path,prompt,summary,started_at_ms,captured_at_ms,observer_generation)
             VALUES(?1,1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![checkpoint.root,checkpoint.id,checkpoint.token,sqlite_u64(checkpoint.admission_generation)?,checkpoint.engine,checkpoint.session_id,
                checkpoint.workspace_path,checkpoint.prompt,checkpoint.summary,sqlite_u64(checkpoint.started_at_ms)?,sqlite_u64(now)?,sqlite_u64(observer_generation)?],
        ).map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok(true)
    }

    pub(super) fn invalidate_checkpoint(&self, reservation: &Reservation) {
        // Optional progress storage must never break completion persistence.
        let Ok(generation) = sqlite_u64(reservation.generation) else {
            return;
        };
        let _ = self.connection.lock().execute(
            "DELETE FROM observer_checkpoints WHERE root=?1 AND token=?2 AND admission_generation=?3",
            params![reservation.root,reservation.token,generation],
        );
    }
}

pub(super) fn stable_candidate(summary: &str) -> Option<String> {
    let text = bounded(summary.trim(), CHECKPOINT_CHARS);
    (text.chars().count() >= MIN_CHECKPOINT_CHARS).then_some(text)
}

pub(super) fn capture(outbox: &Outbox, run: &mut Run, summary: String, now: u64) {
    if run.killed.load(Ordering::SeqCst) || run.poisoned {
        return;
    }
    if run
        .progress
        .last_attempt_ms
        .is_some_and(|last| now.saturating_sub(last) < ATTEMPT_INTERVAL_MS)
    {
        return;
    }
    let fingerprint: [u8; 32] = Sha256::digest(summary.as_bytes()).into();
    if run.progress.fingerprints.contains(&fingerprint) {
        return;
    }
    // Failed writes and absent readiness consume this interval as well.
    run.progress.last_attempt_ms = Some(now);
    if matches!(outbox.persist_checkpoint(run, summary, now), Ok(true)) {
        run.progress.fingerprints.push_back(fingerprint);
        if run.progress.fingerprints.len() > FINGERPRINT_CAP {
            run.progress.fingerprints.pop_front();
        }
    }
}
