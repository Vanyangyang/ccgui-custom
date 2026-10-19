//! Pure, clock-injected admission and completion policy for assistant notices.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use uuid::Uuid;

const SOURCE_LIMIT: usize = 64;
const HISTORY_LIMIT: usize = 64;
const IDLE_MS: u64 = 30 * 60 * 1000;
const COOLDOWN_MS: u64 = 120 * 1000;
pub(super) const TICKET_MS: u64 = 180 * 1000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub checkpoint_id: String,
    pub project: String,
    pub goal: String,
    pub change: String,
    pub facts: Vec<String>,
}

impl Snapshot {
    fn normalized(self) -> Result<Self, String> {
        fn field(value: String, name: &str, max: usize, required: bool) -> Result<String, String> {
            let value = value.trim().to_owned();
            if (required && value.is_empty()) || value.chars().count() > max {
                return Err(format!("invalid {name} length"));
            }
            Ok(value)
        }
        if self.facts.len() > 4 {
            return Err("too many facts".into());
        }
        Ok(Self {
            checkpoint_id: field(self.checkpoint_id, "checkpoint_id", 160, false)?,
            project: field(self.project, "project", 200, true)?,
            goal: field(self.goal, "goal", 500, true)?,
            change: field(self.change, "change", 1500, true)?,
            facts: self
                .facts
                .into_iter()
                .map(|v| field(v, "fact", 500, true))
                .collect::<Result<_, _>>()?,
        })
    }

    fn fingerprint(&self) -> [u8; 32] {
        let mut hash = Sha256::new();
        // Length framing avoids ambiguous concatenations; checkpoint IDs are independent.
        for value in [&self.project, &self.goal, &self.change]
            .into_iter()
            .chain(self.facts.iter())
        {
            hash.update((value.len() as u64).to_le_bytes());
            hash.update(value.as_bytes());
        }
        hash.finalize().into()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ticket {
    pub id: String,
    pub source_key: String,
    pub turn_id: String,
    pub started_at_ms: u64,
    pub epoch: u64,
    pub settings_generation: u64,
    pub locale: String,
    pub snapshot: Snapshot,
    pub expires_at_ms: u64,
}

struct Source {
    turn_id: String,
    started_at_ms: u64,
    epoch: u64,
    touched_at_ms: u64,
    last_attempt_ms: Option<u64>,
    pending: Option<Ticket>,
    history: VecDeque<([u8; 32], String)>,
}

#[derive(Default)]
pub struct Policy {
    sources: HashMap<String, Source>,
    epoch: u64,
    settings_generation: u64,
    allowed: bool,
    locale: String,
}

impl Policy {
    pub fn configure(
        &mut self,
        settings_generation: u64,
        enabled: bool,
        paused: bool,
        focus_mode: bool,
        actually_focused: bool,
        locale: &str,
        now: u64,
    ) {
        let allowed = enabled && !paused && !(focus_mode && actually_focused);
        let locale = locale.trim();
        if self.settings_generation != settings_generation
            || self.locale != locale
            || self.allowed != allowed
        {
            for source in self.sources.values_mut() {
                source.pending = None;
            }
        }
        self.settings_generation = settings_generation;
        self.locale = locale.to_owned();
        self.allowed = allowed;
        self.prune(now);
    }

    fn prune(&mut self, now: u64) {
        self.sources
            .retain(|_, source| now.saturating_sub(source.touched_at_ms) < IDLE_MS);
        for source in self.sources.values_mut() {
            if source
                .pending
                .as_ref()
                .is_some_and(|ticket| now >= ticket.expires_at_ms)
            {
                source.pending = None;
            }
        }
    }

    pub fn begin(&mut self, source_key: &str, turn_id: &str, started_at_ms: u64, now: u64) -> bool {
        self.prune(now);
        if source_key.trim().is_empty() || turn_id.trim().is_empty() {
            return false;
        }
        if let Some(source) = self.sources.get_mut(source_key) {
            if source.turn_id == turn_id && source.started_at_ms == started_at_ms {
                source.touched_at_ms = source.touched_at_ms.max(now);
                return true;
            }
            if started_at_ms <= source.started_at_ms {
                return false;
            }
            self.epoch = self.epoch.saturating_add(1);
            source.turn_id = turn_id.to_owned();
            source.started_at_ms = started_at_ms;
            source.epoch = self.epoch;
            source.touched_at_ms = source.touched_at_ms.max(now);
            source.pending = None;
            return true;
        }
        if self.sources.len() >= SOURCE_LIMIT {
            return false;
        }
        self.epoch = self.epoch.saturating_add(1);
        self.sources.insert(
            source_key.to_owned(),
            Source {
                turn_id: turn_id.to_owned(),
                started_at_ms,
                epoch: self.epoch,
                touched_at_ms: now,
                last_attempt_ms: None,
                pending: None,
                history: VecDeque::new(),
            },
        );
        true
    }

    pub fn cancel(&mut self, source_key: &str, now: u64) {
        self.prune(now);
        if let Some(source) = self.sources.get_mut(source_key) {
            self.epoch = self.epoch.saturating_add(1);
            source.epoch = self.epoch;
            source.pending = None;
            source.touched_at_ms = source.touched_at_ms.max(now);
        }
    }

    pub fn prepare(
        &mut self,
        source_key: &str,
        turn_id: &str,
        started_at_ms: u64,
        snapshot: Snapshot,
        active_count: usize,
        now: u64,
    ) -> Result<Option<Ticket>, String> {
        // Validation precedes even pruning and turn changes: invalid input is inert.
        let snapshot = snapshot.normalized()?;
        if source_key.trim().is_empty() || turn_id.trim().is_empty() {
            return Err("source_key and turn_id are required".into());
        }
        if !self.begin(source_key, turn_id, started_at_ms, now) || !self.allowed {
            return Ok(None);
        }
        if active_count.saturating_add(self.pending_count(now)) >= 2 {
            return Ok(None);
        }
        let source = self
            .sources
            .get_mut(source_key)
            .expect("begin established source");
        if source.pending.is_some()
            || source
                .last_attempt_ms
                .is_some_and(|last| now.saturating_sub(last) < COOLDOWN_MS)
        {
            return Ok(None);
        }
        let fingerprint = snapshot.fingerprint();
        if source.history.iter().any(|(hash, checkpoint)| {
            *hash == fingerprint
                || (!snapshot.checkpoint_id.is_empty() && *checkpoint == snapshot.checkpoint_id)
        }) {
            return Ok(None);
        }
        let ticket = Ticket {
            id: Uuid::new_v4().to_string(),
            source_key: source_key.to_owned(),
            turn_id: turn_id.to_owned(),
            started_at_ms,
            epoch: source.epoch,
            settings_generation: self.settings_generation,
            locale: self.locale.clone(),
            snapshot,
            expires_at_ms: now.saturating_add(TICKET_MS),
        };
        source
            .history
            .push_back((fingerprint, ticket.snapshot.checkpoint_id.clone()));
        if source.history.len() > HISTORY_LIMIT {
            source.history.pop_front();
        }
        source.last_attempt_ms = Some(now);
        source.pending = Some(ticket.clone());
        Ok(Some(ticket))
    }

    pub fn current(&self, ticket: &Ticket, now: u64) -> bool {
        self.allowed
            && ticket.settings_generation == self.settings_generation
            && ticket.locale == self.locale
            && now < ticket.expires_at_ms
            && self.sources.get(&ticket.source_key).is_some_and(|source| {
                now.saturating_sub(source.touched_at_ms) < IDLE_MS
                    && source.epoch == ticket.epoch
                    && source.pending.as_ref() == Some(ticket)
            })
    }

    pub fn finish(&mut self, ticket: &Ticket, now: u64) -> bool {
        if !self.current(ticket, now) {
            return false;
        }
        let source = self
            .sources
            .get_mut(&ticket.source_key)
            .expect("current source");
        source.pending = None;
        source.touched_at_ms = source.touched_at_ms.max(now);
        true
    }

    pub fn pending_count(&self, now: u64) -> usize {
        self.sources
            .values()
            .filter(|source| {
                source
                    .pending
                    .as_ref()
                    .is_some_and(|ticket| self.current(ticket, now))
            })
            .count()
    }

    pub fn source_count(&self) -> usize {
        self.sources.len()
    }
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
