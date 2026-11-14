//! Reuse only completed, validated map results for an exact prompt and source/route.
//! Process-local and bounded: no transcript or summary cache is written to disk.

use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

const MAX_ENTRIES: usize = 256;
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 32 * 1024;
const TTL: Duration = Duration::from_secs(60 * 60);
const CONTRACT: &[u8] = b"full-handoff-call-cache-v1";

struct Entry { key: [u8; 32], summary: String, created: Instant }

#[derive(Default)]
struct Store { entries: VecDeque<Entry>, bytes: usize }

impl Store {
    fn prune(&mut self, now: Instant) {
        self.entries.retain(|entry| now.duration_since(entry.created) < TTL);
        self.bytes = self.entries.iter().map(|entry| entry.summary.len()).sum();
    }

    fn get(&mut self, key: &[u8; 32], now: Instant) -> Option<String> {
        self.prune(now);
        let index = self.entries.iter().position(|entry| &entry.key == key)?;
        let entry = self.entries.remove(index)?;
        let summary = entry.summary.clone();
        self.entries.push_back(entry);
        Some(summary)
    }

    fn put(&mut self, key: [u8; 32], summary: &str, now: Instant) {
        if summary.trim().is_empty() || summary.contains('\0') || summary.len() > MAX_ENTRY_BYTES { return; }
        self.prune(now);
        if let Some(index) = self.entries.iter().position(|entry| entry.key == key) {
            self.bytes -= self.entries.remove(index).expect("existing entry").summary.len();
        }
        while self.entries.len() >= MAX_ENTRIES || self.bytes + summary.len() > MAX_BYTES {
            if let Some(entry) = self.entries.pop_front() { self.bytes -= entry.summary.len(); }
            else { break; }
        }
        self.bytes += summary.len();
        self.entries.push_back(Entry { key, summary: summary.to_owned(), created: now });
    }
}

static STORE: LazyLock<Arc<Mutex<Store>>> = LazyLock::new(|| Arc::new(Mutex::new(Store::default())));

#[derive(Clone)]
pub(super) struct CallCache { scope: [u8; 32], store: Arc<Mutex<Store>> }

impl CallCache {
    /// The caller supplies the saved source's absolute path and frozen model
    /// route. Explicit plugin text has no verified workspace identity: no cache.
    pub(super) fn scoped(source: &std::path::Path, route: &str) -> Self {
        Self::with_store(source, route, Arc::clone(&STORE))
    }

    fn with_store(source: &std::path::Path, route: &str, store: Arc<Mutex<Store>>) -> Self {
        let mut hash = Sha256::new();
        let path = source.as_os_str().as_encoded_bytes();
        hash.update(CONTRACT);
        hash.update((path.len() as u64).to_le_bytes());
        hash.update(path);
        hash.update(route.as_bytes());
        let scope = hash.finalize().into();
        Self { scope, store }
    }

    #[cfg(test)]
    pub(super) fn key(&self, prompt: &str) -> [u8; 32] {
        self.key_with_prefix(prompt, None)
    }

    pub(super) fn key_with_prefix(&self, prompt: &str, prefix: Option<&[u8; 32]>) -> [u8; 32] {
        let mut hash = Sha256::new();
        hash.update(self.scope);
        hash.update([u8::from(prefix.is_some())]);
        if let Some(prefix) = prefix { hash.update(prefix); }
        hash.update(prompt.as_bytes());
        hash.finalize().into()
    }

    pub(super) fn get(&self, key: &[u8; 32]) -> Option<String> {
        self.store.lock().ok()?.get(key, Instant::now())
    }

    pub(super) fn put(&self, key: [u8; 32], summary: &str) {
        if let Ok(mut store) = self.store.lock() { store.put(key, summary, Instant::now()); }
    }

    #[cfg(test)]
    pub(super) fn isolated() -> Self {
        Self::with_store(std::path::Path::new("fixture/source"), "fixture-route", Arc::new(Mutex::new(Store::default())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_prompt_source_and_model_route_are_isolated() {
        let store = Arc::new(Mutex::new(Store::default()));
        let cache = |path: &str, route| CallCache::with_store(std::path::Path::new(path), route, Arc::clone(&store));
        let first = cache("workspace-a/source", "codex/model/provider/high");
        first.put(first.key("prompt-v1 budget-4000 source-a"), "verified summary");
        assert_eq!(first.get(&first.key("prompt-v1 budget-4000 source-a")).as_deref(), Some("verified summary"));
        for other in [cache("workspace-b/source", "codex/model/provider/high"), cache("workspace-a/source", "codex/model/provider/low"),
            cache("workspace-a/source", "codex/other/provider/high"), cache("workspace-a/source", "codex/model/other/high")] {
            assert!(other.get(&other.key("prompt-v1 budget-4000 source-a")).is_none());
        }
        for prompt in ["prompt-v2 budget-4000 source-a", "prompt-v1 budget-3000 source-a", "prompt-v1 budget-4000 source-b"] {
            assert!(first.get(&first.key(prompt)).is_none());
        }
    }

    #[test]
    fn expiry_does_not_extend_on_read_and_lru_and_bytes_stay_bounded() {
        let now = Instant::now();
        let mut store = Store::default();
        let key = |i: usize| Sha256::digest(i.to_le_bytes()).into();
        store.put(key(0), "old", now);
        assert_eq!(store.get(&key(0), now + TTL / 2).as_deref(), Some("old"));
        assert!(store.get(&key(0), now + TTL).is_none());
        for i in 0..MAX_ENTRIES { store.put(key(i), "short", now); }
        assert!(store.get(&key(0), now).is_some());
        store.put(key(MAX_ENTRIES), "new", now);
        assert!(store.get(&key(0), now).is_some());
        assert!(store.get(&key(1), now).is_none());
        for i in 0..MAX_ENTRIES { store.put(key(i), &"x".repeat(MAX_ENTRY_BYTES), now); }
        assert!(store.entries.len() <= MAX_ENTRIES);
        assert!(store.bytes <= MAX_BYTES);
        assert_eq!(store.bytes, store.entries.iter().map(|entry| entry.summary.len()).sum::<usize>());
    }

    #[test]
    fn invalid_or_excessive_results_are_not_retained() {
        let mut store = Store::default();
        for value in [" ".to_owned(), "bad\0summary".into(), "x".repeat(MAX_ENTRY_BYTES + 1)] {
            store.put([0; 32], &value, Instant::now());
            assert!(store.entries.is_empty());
        }
    }
}
