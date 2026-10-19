//! App-owned durable inbox. Text is data; this module performs no external work.
use crate::assistant_notices::completion_outbox::Pending;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};

const CAP: i64 = 512;
const MAX_MS: u64 = i64::MAX as u64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeSource {
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
    pub label: String,
}
impl NoticeSource {
    pub fn validate(&self) -> Result<(), String> {
        if !crate::config::ENGINES.contains(&self.engine.as_str())
            || !native_id(&self.session_id)
            || self.workspace_path.is_empty()
            || self.workspace_path.len() > 4096
            || self.workspace_path.chars().any(char::is_control)
            || self.label.chars().count() > 200
        {
            return Err("invalid_source".into());
        }
        Ok(())
    }
    pub fn key(&self) -> String {
        let bytes =
            serde_json::to_vec(&(&self.engine, &self.session_id, &self.workspace_path)).unwrap();
        format!("{:x}", Sha256::digest(bytes))
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeKind {
    Completion,
    Aside,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeObserver {
    pub engine: String,
    pub model: String,
    pub effort: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: String,
    pub kind: NoticeKind,
    pub source: NoticeSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observer: Option<NoticeObserver>,
    pub turn_id: String,
    pub created_at_ms: u64,
    pub started_at_ms: u64,
    pub tease: String,
    pub body: String,
    pub pinned: bool,
    pub expires_at_ms: Option<u64>,
    pub read: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitStatus {
    Recorded,
    Duplicate,
    Superseded,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub status: CommitStatus,
    pub notice: Option<Notice>,
}
pub struct Store {
    connection: Mutex<Connection>,
}
fn storage(_: rusqlite::Error) -> String {
    "storage_unavailable".into()
}
fn native_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control)
}
fn time(t: u64) -> Result<i64, String> {
    i64::try_from(t).map_err(|_| "invalid_time".into())
}
fn fingerprint(n: &Notice) -> String {
    // Labels are presentation metadata, not immutable event identity.
    let data = serde_json::to_vec(&(
        &n.id,
        n.kind,
        n.source.key(),
        &n.turn_id,
        n.created_at_ms,
        n.started_at_ms,
        &n.tease,
        &n.body,
    ))
    .unwrap();
    format!("{:x}", Sha256::digest(data))
}
fn decode(s: String) -> Result<Notice, String> {
    serde_json::from_str(&s).map_err(|_| "storage_corrupt".into())
}
fn get_from(c: &Connection, id: &str) -> Result<Option<Notice>, String> {
    c.query_row("SELECT data FROM notices WHERE id=?1", [id], |r| r.get(0))
        .optional()
        .map_err(storage)?
        .map(decode)
        .transpose()
}
fn save(c: &Connection, n: &Notice) -> Result<(), String> {
    let data = serde_json::to_string(n).map_err(|_| "storage_unavailable".to_string())?;
    c.execute(
        "UPDATE notices SET data=?2,is_read=?3,expires=?4,pinned=?5 WHERE id=?1",
        params![
            n.id,
            data,
            n.read,
            n.expires_at_ms.map(|v| v as i64),
            n.pinned
        ],
    )
    .map_err(storage)?;
    Ok(())
}
fn insert(c: &Connection, n: &Notice) -> Result<(), String> {
    let normalized = n
        .tease
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    c.execute("INSERT INTO notices(id,source,kind,created,data,hash,is_read,expires,pinned,normalized) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![n.id,n.source.key(),if n.kind==NoticeKind::Completion {0}else{1},n.created_at_ms as i64,serde_json::to_string(n).unwrap(),fingerprint(n),n.read,n.expires_at_ms.map(|v|v as i64),n.pinned,normalized]).map_err(storage)?;
    Ok(())
}
fn room(tx: &Transaction<'_>, now: u64) -> Result<(), String> {
    let count: i64 = tx
        .query_row("SELECT count(*) FROM notices", [], |r| r.get(0))
        .map_err(storage)?;
    if count < CAP {
        return Ok(());
    }
    // Retain recent aside keys for the full deduplication window.
    let removed = tx.execute("DELETE FROM notices WHERE id IN (SELECT id FROM notices WHERE is_read=1 AND pinned=0 AND (kind=0 OR created<=?1) ORDER BY created,id LIMIT 1)", [now as i64 - 90_000]).map_err(storage)?;
    if removed == 0 {
        Err("inbox_capacity".into())
    } else {
        Ok(())
    }
}
fn source_slot(tx: &Transaction<'_>, key: &str) -> Result<(), String> {
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sources WHERE source=?1)",
            [key],
            |r| r.get(0),
        )
        .map_err(storage)?;
    if !exists {
        let count: i64 = tx
            .query_row("SELECT count(*) FROM sources", [], |r| r.get(0))
            .map_err(storage)?;
        if count >= CAP {
            let removed = tx.execute("DELETE FROM sources WHERE source IN (SELECT source FROM sources WHERE NOT EXISTS (SELECT 1 FROM notices WHERE notices.source=sources.source) ORDER BY rowid LIMIT 1)", []).map_err(storage)?;
            if removed == 0 {
                return Err("source_capacity".into());
            }
        }
        tx.execute("INSERT INTO sources(source,attention) VALUES(?1,0)", [key])
            .map_err(storage)?;
    }
    Ok(())
}
impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Arc<Self>, String> {
        let mut c = Connection::open(path).map_err(storage)?;
        c.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(storage)?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
            .map_err(storage)?;
        let version: i64 = c
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(storage)?;
        if version > 1 {
            return Err("unsupported_schema".into());
        }
        let tx = c.transaction().map_err(storage)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,source TEXT NOT NULL,kind INTEGER NOT NULL,created INTEGER NOT NULL,data TEXT NOT NULL,hash TEXT NOT NULL,is_read INTEGER NOT NULL,expires INTEGER,pinned INTEGER NOT NULL,normalized TEXT NOT NULL);
          CREATE UNIQUE INDEX IF NOT EXISTS completion_source ON notices(source) WHERE kind=0;
          CREATE TABLE IF NOT EXISTS sources(source TEXT PRIMARY KEY,attention INTEGER NOT NULL,latest_id TEXT,latest_started INTEGER,latest_completed INTEGER,latest_hash TEXT);
          PRAGMA user_version=1;").map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(Arc::new(Self {
            connection: Mutex::new(c),
        }))
    }
    pub fn record_completion(&self, p: &Pending, source: &NoticeSource) -> Result<Commit, String> {
        source.validate()?;
        time(p.started_at_ms)?;
        time(p.completed_at_ms)?;
        if p.cancel
            || p.started
            || !valid_id(&p.id)
            || p.summary.chars().count() > 8000
            || p.completed_at_ms < p.started_at_ms
            || p.engine != source.engine
            || p.session_id != source.session_id
            || p.workspace_path != source.workspace_path
        {
            return Err("invalid_completion".into());
        }
        let mut n = Notice {
            id: p.id.clone(),
            kind: NoticeKind::Completion,
            source: source.clone(),
            observer: None,
            turn_id: p.id.clone(),
            created_at_ms: p.completed_at_ms,
            started_at_ms: p.started_at_ms,
            tease: String::new(),
            body: p.summary.clone(),
            pinned: false,
            expires_at_ms: None,
            read: false,
        };
        let hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(p).map_err(|_| "invalid_completion")?)
        );
        let mut c = self.connection.lock();
        let tx = c.transaction().map_err(storage)?;
        let key = source.key();
        let known: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sources WHERE source=?1)",
                [&key],
                |r| r.get(0),
            )
            .map_err(storage)?;
        if !known {
            // Pruning a read row can free its old source slot in the same transaction.
            room(&tx, p.completed_at_ms)?;
        }
        source_slot(&tx, &key)?;
        let (watermark,latest): (i64,Option<(String,i64,i64,String)>) = tx.query_row("SELECT attention,latest_id,latest_started,latest_completed,latest_hash FROM sources WHERE source=?1", [&key], |r| {
            let id:Option<String>=r.get(1)?; Ok((r.get(0)?,match id {Some(id)=>Some((id,r.get(2)?,r.get(3)?,r.get(4)?)),None=>None}))
        }).map_err(storage)?;
        if let Some((id, started, completed, old_hash)) = latest {
            if id == p.id {
                if hash != old_hash {
                    return Err("payload_conflict".into());
                }
                return Ok(Commit {
                    status: CommitStatus::Duplicate,
                    notice: get_from(&tx, &id)?,
                });
            }
            if (p.started_at_ms, p.completed_at_ms, p.id.as_str())
                <= (started as u64, completed as u64, id.as_str())
            {
                return Ok(Commit {
                    status: CommitStatus::Superseded,
                    notice: None,
                });
            }
        }
        if get_from(&tx, &p.id)?.is_some() {
            return Err("payload_conflict".into());
        }
        n.read = watermark as u64 > p.completed_at_ms;
        tx.execute("DELETE FROM notices WHERE source=?1 AND kind=0", [&key])
            .map_err(storage)?;
        room(&tx, p.completed_at_ms)?;
        insert(&tx, &n)?;
        tx.execute("UPDATE sources SET latest_id=?2,latest_started=?3,latest_completed=?4,latest_hash=?5 WHERE source=?1",params![key,p.id,p.started_at_ms as i64,p.completed_at_ms as i64,hash]).map_err(storage)?;
        tx.commit().map_err(storage)?;
        Ok(Commit {
            status: CommitStatus::Recorded,
            notice: Some(n),
        })
    }
    pub fn attention(&self, source: &NoticeSource, at_ms: u64) -> Result<bool, String> {
        source.validate()?;
        let at = time(at_ms)?;
        let key = source.key();
        let mut c = self.connection.lock();
        let tx = c.transaction().map_err(storage)?;
        source_slot(&tx, &key)?;
        tx.execute(
            "UPDATE sources SET attention=max(attention,?2) WHERE source=?1",
            params![key, at],
        )
        .map_err(storage)?;
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM notices WHERE source=?1 AND kind=0 AND created<?2 AND is_read=0",
                params![key, at],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage)?;
        if let Some(ref id) = id {
            let mut n = get_from(&tx, id)?.ok_or("storage_corrupt")?;
            n.read = true;
            save(&tx, &n)?;
        }
        tx.commit().map_err(storage)?;
        Ok(id.is_some())
    }
    pub fn add_aside(
        &self,
        id: &str,
        source: &NoticeSource,
        turn_id: &str,
        tease: &str,
        body: &str,
        now: u64,
        linger_ms: u64,
    ) -> Result<Commit, String> {
        self.add_aside_with_observer(id, source, None, turn_id, tease, body, now, linger_ms)
    }
    pub fn add_aside_with_observer(
        &self,
        id: &str,
        source: &NoticeSource,
        observer: Option<&NoticeObserver>,
        turn_id: &str,
        tease: &str,
        body: &str,
        now: u64,
        linger_ms: u64,
    ) -> Result<Commit, String> {
        source.validate()?;
        if let Some(obs) = observer {
            if obs.engine.is_empty()
                || obs.engine.len() > 64
                || obs.engine.chars().any(char::is_control)
                || obs.model.len() > 256
                || obs.model.chars().any(char::is_control)
                || obs.effort.is_empty()
                || obs.effort.len() > 32
                || obs.effort.chars().any(char::is_control)
            {
                return Err("invalid_aside".into());
            }
        }
        time(now)?;
        if !valid_id(id)
            || !valid_id(turn_id)
            || tease.trim().is_empty()
            || tease.chars().count() > 120
            || body.chars().count() > 2000
            || !(8000..=36000).contains(&linger_ms)
            || now > MAX_MS - linger_ms
        {
            return Err("invalid_aside".into());
        }
        let n = Notice {
            id: id.into(),
            kind: NoticeKind::Aside,
            source: source.clone(),
            observer: observer.cloned(),
            turn_id: turn_id.into(),
            created_at_ms: now,
            started_at_ms: now,
            tease: tease.into(),
            body: body.into(),
            pinned: false,
            expires_at_ms: Some(now + linger_ms),
            read: false,
        };
        let mut c = self.connection.lock();
        let tx = c.transaction().map_err(storage)?;
        if let Some(old) = get_from(&tx, id)? {
            if fingerprint(&old) != fingerprint(&n) {
                return Err("payload_conflict".into());
            }
            return Ok(Commit {
                status: CommitStatus::Duplicate,
                notice: Some(old),
            });
        }
        let normalized = tease
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        let duplicate:Option<String>=tx.query_row("SELECT data FROM notices WHERE kind=1 AND normalized=?1 AND created>?2 ORDER BY created DESC LIMIT 1",params![normalized,now as i64 - 90_000],|r|r.get(0)).optional().map_err(storage)?;
        if let Some(data) = duplicate {
            return Ok(Commit {
                status: CommitStatus::Duplicate,
                notice: Some(decode(data)?),
            });
        }
        expire_from(&tx, now)?;
        let active:i64=tx.query_row("SELECT count(*) FROM notices WHERE kind=1 AND is_read=0 AND (pinned=1 OR expires IS NULL OR expires>?1)",[now as i64],|r|r.get(0)).map_err(storage)?;
        if active >= 2 {
            return Err("aside_capacity".into());
        }
        room(&tx, now)?;
        insert(&tx, &n)?;
        tx.commit().map_err(storage)?;
        Ok(Commit {
            status: CommitStatus::Recorded,
            notice: Some(n),
        })
    }
    pub fn get(&self, id: &str) -> Result<Option<Notice>, String> {
        get_from(&self.connection.lock(), id)
    }
    pub fn mark_read(&self, id: &str) -> Result<bool, String> {
        let c = self.connection.lock();
        let Some(mut n) = get_from(&c, id)? else {
            return Ok(false);
        };
        if n.read {
            return Ok(false);
        }
        n.read = true;
        save(&c, &n)?;
        Ok(true)
    }
    pub fn set_pinned(&self, id: &str, pinned: bool, now: u64) -> Result<bool, String> {
        if now > MAX_MS - 18_000 {
            return Err("invalid_time".into());
        }
        let c = self.connection.lock();
        let Some(mut n) = get_from(&c, id)? else {
            return Ok(false);
        };
        if n.kind != NoticeKind::Aside || n.read || n.pinned == pinned {
            return Ok(false);
        }
        n.pinned = pinned;
        n.expires_at_ms = if pinned { None } else { Some(now + 18_000) };
        save(&c, &n)?;
        Ok(true)
    }
    pub fn set_expiry(&self, id: &str, expires: Option<u64>) -> Result<bool, String> {
        if let Some(t) = expires {
            time(t)?;
        }
        let c = self.connection.lock();
        let Some(mut n) = get_from(&c, id)? else {
            return Ok(false);
        };
        if n.kind != NoticeKind::Aside || n.read || n.pinned || n.expires_at_ms == expires {
            return Ok(false);
        }
        n.expires_at_ms = expires;
        save(&c, &n)?;
        Ok(true)
    }
    pub fn expire(&self, now: u64) -> Result<bool, String> {
        time(now)?;
        let mut c = self.connection.lock();
        let tx = c.transaction().map_err(storage)?;
        let changed = expire_from(&tx, now)?;
        tx.commit().map_err(storage)?;
        Ok(changed)
    }
    pub fn unread(&self, now: u64) -> Result<Vec<Notice>, String> {
        time(now)?;
        let c = self.connection.lock();
        collect(&c,"SELECT data FROM notices WHERE is_read=0 AND (kind=0 OR pinned=1 OR expires IS NULL OR expires>?1) ORDER BY created DESC,id DESC LIMIT 512",now as i64)
    }
    pub fn history(&self, limit: usize) -> Result<Vec<Notice>, String> {
        collect(
            &self.connection.lock(),
            "SELECT data FROM notices ORDER BY created DESC,id DESC LIMIT ?1",
            limit.min(512) as i64,
        )
    }
}
fn collect(c: &Connection, sql: &str, arg: i64) -> Result<Vec<Notice>, String> {
    let mut stmt = c.prepare(sql).map_err(storage)?;
    let rows = stmt
        .query_map([arg], |r| r.get::<_, String>(0))
        .map_err(storage)?;
    rows.map(|r| r.map_err(storage).and_then(decode)).collect()
}
fn expire_from(c: &Connection, now: u64) -> Result<bool, String> {
    let expired = collect(
        c,
        "SELECT data FROM notices WHERE kind=1 AND pinned=0 AND is_read=0 AND expires<=?1",
        now as i64,
    )?;
    for mut n in expired.iter().cloned() {
        n.read = true;
        save(c, &n)?;
    }
    Ok(!expired.is_empty())
}
#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
