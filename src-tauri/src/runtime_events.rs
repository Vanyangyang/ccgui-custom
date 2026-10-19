//! Bounded, in-memory event history. A gap requires a fresh caller snapshot.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub stream_id: String,
    pub seq: u64,
    pub name: String,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReplayBatch {
    pub stream_id: String,
    pub through: u64,
    pub events: Vec<EventEnvelope>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ReplayError {
    StreamMismatch,
    CursorAhead,
    Gap,
}

struct State {
    head: u64,
    bytes: usize,
    events: VecDeque<(EventEnvelope, usize)>,
}

pub struct EventJournal {
    stream_id: String,
    max_events: usize,
    max_bytes: usize,
    state: Mutex<State>,
}

impl EventJournal {
    pub fn new(stream_id: String, max_events: usize, max_bytes: usize) -> Self {
        Self {
            stream_id,
            max_events,
            max_bytes,
            state: Mutex::new(State {
                head: 0,
                bytes: 0,
                events: VecDeque::new(),
            }),
        }
    }

    /// Always returns the event for immediate delivery, even if it cannot be retained.
    /// Byte capacity measures serialized envelopes, including names and stream IDs.
    pub fn append(&self, name: &str, payload: Value) -> EventEnvelope {
        let mut state = self.state.lock().expect("event journal lock poisoned");
        let event = EventEnvelope {
            stream_id: self.stream_id.clone(),
            seq: state.head.checked_add(1).expect("event sequence exhausted"),
            name: name.to_owned(),
            payload,
        };
        let bytes = serialized_size(&event);
        state.head = event.seq;
        if self.max_events == 0 || bytes > self.max_bytes {
            // Keep only a contiguous suffix. An unretained event invalidates all
            // older history; subsequent events can begin a new suffix.
            state.events.clear();
            state.bytes = 0;
            return event;
        }
        while state.events.len() >= self.max_events || state.bytes > self.max_bytes - bytes {
            let (_, removed_bytes) = state.events.pop_front().expect("retained event exists");
            state.bytes -= removed_bytes;
        }
        state.bytes += bytes;
        state.events.push_back((event.clone(), bytes));
        event
    }

    pub fn head(&self) -> u64 {
        self.state.lock().expect("event journal lock poisoned").head
    }

    /// Returns a complete prefix through the captured head, or an explicit error.
    /// A cursor at the current head is valid even when history was not retained.
    pub fn replay_after(&self, stream_id: &str, after: u64) -> Result<ReplayBatch, ReplayError> {
        let state = self.state.lock().expect("event journal lock poisoned");
        if stream_id != self.stream_id {
            return Err(ReplayError::StreamMismatch);
        }
        if after > state.head {
            return Err(ReplayError::CursorAhead);
        }
        if after < state.head
            && state
                .events
                .front()
                .map_or(true, |(event, _)| event.seq > after + 1)
        {
            return Err(ReplayError::Gap);
        }
        Ok(ReplayBatch {
            stream_id: self.stream_id.clone(),
            through: state.head,
            events: state
                .events
                .iter()
                .filter(|(event, _)| event.seq > after)
                .map(|(event, _)| event.clone())
                .collect(),
        })
    }
}

// Count without allocating a second buffer proportional to an oversized payload.
fn serialized_size(event: &EventEnvelope) -> usize {
    struct Counter(usize);
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .ok_or_else(|| io::Error::other("event size overflow"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, event).expect("event envelope serialization failed");
    counter.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn empty_history_epoch_and_cursor_validation() {
        let journal = EventJournal::new("epoch".into(), 10, 4096);
        assert_eq!(journal.head(), 0);
        assert_eq!(journal.replay_after("epoch", 0).unwrap().events, vec![]);
        assert_eq!(
            journal.replay_after("other", 0),
            Err(ReplayError::StreamMismatch)
        );
        assert_eq!(
            journal.replay_after("epoch", 1),
            Err(ReplayError::CursorAhead)
        );
        let event = journal.append("delta", json!({"text": "中文🦀"}));
        assert_eq!(event.seq, 1);
        assert_eq!(
            serde_json::from_value::<EventEnvelope>(serde_json::to_value(&event).unwrap()).unwrap(),
            event
        );
        assert_eq!(
            journal.replay_after("epoch", 0).unwrap(),
            ReplayBatch {
                stream_id: "epoch".into(),
                through: 1,
                events: vec![event],
            }
        );
    }

    #[test]
    fn count_eviction_reports_gap_and_replays_boundary() {
        let journal = EventJournal::new("e".into(), 2, 4096);
        for n in 1..=3 {
            journal.append("event", json!(n));
        }
        assert_eq!(journal.replay_after("e", 0), Err(ReplayError::Gap));
        let batch = journal.replay_after("e", 1).unwrap();
        assert_eq!(batch.through, 3);
        assert_eq!(
            batch.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(journal.replay_after("e", 3).unwrap().events.is_empty());
    }

    #[test]
    fn byte_limit_counts_exact_serialized_envelope() {
        let sample = EventEnvelope {
            stream_id: "e".into(),
            seq: 1,
            name: "n".into(),
            payload: json!("中文🦀"),
        };
        let size = serde_json::to_vec(&sample).unwrap().len();
        assert_eq!(serialized_size(&sample), size);
        let journal = EventJournal::new("e".into(), 10, size);
        assert_eq!(journal.append("n", sample.payload.clone()), sample);
        assert_eq!(journal.replay_after("e", 0).unwrap().events.len(), 1);
        journal.append("n", sample.payload);
        assert_eq!(journal.replay_after("e", 0), Err(ReplayError::Gap));
        assert_eq!(journal.replay_after("e", 1).unwrap().events.len(), 1);
        assert_eq!(journal.state.lock().unwrap().bytes, size);
    }

    #[test]
    fn zero_capacity_never_claims_missing_history() {
        for (count, bytes) in [(0, 4096), (10, 0), (0, 0)] {
            let journal = EventJournal::new("e".into(), count, bytes);
            assert_eq!(journal.append("n", Value::Null).seq, 1);
            assert_eq!(journal.head(), 1);
            assert_eq!(journal.replay_after("e", 0), Err(ReplayError::Gap));
            assert!(journal.replay_after("e", 1).unwrap().events.is_empty());
            let state = journal.state.lock().unwrap();
            assert!(state.events.is_empty());
            assert_eq!(state.bytes, 0);
        }
    }

    #[test]
    fn oversized_event_delivered_but_breaks_replay_history() {
        let journal = EventJournal::new("e".into(), 10, 256);
        journal.append("n", Value::Null);
        let large = journal.append("n", json!("x".repeat(1024)));
        assert_eq!(large.seq, 2);
        assert_eq!(large.payload.as_str().unwrap().len(), 1024);
        assert_eq!(journal.state.lock().unwrap().bytes, 0);
        journal.append("n", Value::Null);
        assert_eq!(journal.replay_after("e", 1), Err(ReplayError::Gap));
        let batch = journal.replay_after("e", 2).unwrap();
        assert_eq!(batch.through, 3);
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].seq, 3);
    }

    #[test]
    fn concurrent_appends_and_replay_have_atomic_ordered_prefixes() {
        let journal = Arc::new(EventJournal::new("e".into(), 1000, 1_000_000));
        let workers: Vec<_> = (0..4)
            .map(|worker| {
                let journal = journal.clone();
                std::thread::spawn(move || {
                    let mut sequences = Vec::new();
                    for n in 0..100 {
                        sequences.push(journal.append("n", json!([worker, n])).seq);
                        let batch = journal.replay_after("e", 0).unwrap();
                        assert_eq!(batch.events.len() as u64, batch.through);
                        for (index, event) in batch.events.iter().enumerate() {
                            assert_eq!(event.seq, index as u64 + 1);
                        }
                    }
                    sequences
                })
            })
            .collect();
        let mut sequences: Vec<_> = workers
            .into_iter()
            .flat_map(|w| w.join().unwrap())
            .collect();
        sequences.sort_unstable();
        assert_eq!(sequences, (1..=400).collect::<Vec<_>>());
        assert_eq!(journal.head(), 400);
    }
}
