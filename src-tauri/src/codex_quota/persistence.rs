//! Versioned, bounded display-only cache. Restoring never verifies an account.
use super::*;
use std::io::{Read, Write};
use std::sync::atomic::Ordering;

const MAX_BYTES: usize = 32 * 1024;

fn invalidation_path(path: &Path) -> PathBuf { path.with_extension("invalidated") }

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DiskCache {
    version: u32,
    records: Vec<Record>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    stamp: String,
    collected_at: u64,
    identity_hash: Option<String>,
    five_hour: Option<Window>,
    seven_day: Option<Window>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Window {
    used_percentage: f64,
    resets_at: Option<u64>,
}

fn hash_valid(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Window {
    fn valid(&self) -> bool {
        self.used_percentage.is_finite() && (0.0..=100.0).contains(&self.used_percentage)
            && self.resets_at.is_none_or(|at| at > 0 && at <= 8_640_000_000_000)
    }
    fn quota(self) -> QuotaWindow {
        QuotaWindow { used_percentage: self.used_percentage, resets_at: self.resets_at }
    }
    fn from_quota(w: &QuotaWindow) -> Self {
        Self { used_percentage: w.used_percentage, resets_at: w.resets_at }
    }
}

impl Record {
    fn valid(&self, now: u64) -> bool {
        hash_valid(&self.stamp)
            && self.identity_hash.as_deref().is_none_or(hash_valid)
            && self.collected_at > 0 && self.collected_at <= now
            && (self.five_hour.is_some() || self.seven_day.is_some())
            && [&self.five_hour, &self.seven_day].into_iter().flatten().all(Window::valid)
    }
}

fn read(path: &Path) -> Option<DiskCache> {
    // A failed replacement may leave old account data behind. The marker has
    // no identity data and revokes the whole file until a new write succeeds.
    if invalidation_path(path).try_exists().ok()? { return None; }
    let mut bytes = Vec::new();
    std::fs::File::open(path).ok()?.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes).ok()?;
    if bytes.len() > MAX_BYTES { return None; }
    let disk: DiskCache = serde_json::from_slice(&bytes).ok()?;
    let now = now_seconds();
    if disk.version != 1 || disk.records.len() > MAX_BINDINGS
        || !disk.records.iter().all(|r| r.valid(now)) { return None; }
    let mut stamps = std::collections::HashSet::new();
    if !disk.records.iter().all(|r| stamps.insert(&r.stamp)) { return None; }
    Some(disk)
}

fn write(path: &Path, disk: &DiskCache) -> Result<(), ()> {
    let bytes = serde_json::to_vec(disk).map_err(|_| ())?;
    if bytes.len() > MAX_BYTES { return Err(()); }
    let parent = path.parent().ok_or(())?;
    std::fs::create_dir_all(parent).map_err(|_| ())?;
    let temporary = parent.join(format!(".codex-quota-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|_| ())?;
    let result = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    let result = result.and_then(|_| std::fs::rename(&temporary, path));
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result.map_err(|_| ())?;
    match std::fs::remove_file(invalidation_path(path)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(()),
    }
}

impl CodexQuotaState {
    pub(super) fn restore(&self, cache: &mut HashMap<String, Entry>) {
        if !self.persistence_enabled.load(Ordering::Relaxed) { return; }
        if self.persistence_loaded.swap(true, Ordering::Relaxed) { return; }
        let Some(disk) = self.persistence_path.as_deref().and_then(read) else { return; };
        for record in disk.records {
            cache.entry(record.stamp).or_insert_with(|| Entry {
                snapshot: Some(CodexQuotaSnapshot {
                    status: "stale",
                    windows: QuotaWindows {
                        five_hour: record.five_hour.map(Window::quota),
                        seven_day: record.seven_day.map(Window::quota),
                    },
                    collected_at: Some(record.collected_at),
                    source: Some("codex_app_server"),
                    ..Default::default()
                }),
                identity_hash: record.identity_hash,
                ..Default::default()
            });
        }
    }

    pub(super) fn persist(&self, cache: &HashMap<String, Entry>) {
        if !self.persistence_enabled.load(Ordering::Relaxed) { return; }
        let Some(path) = self.persistence_path.as_deref() else { return; };
        let now = now_seconds();
        let mut records: Vec<_> = cache.iter().filter_map(|(stamp, entry)| {
            let snapshot = entry.snapshot.as_ref()?;
            let record = Record {
                stamp: stamp.clone(),
                collected_at: snapshot.collected_at?,
                identity_hash: entry.identity_hash.clone(),
                five_hour: snapshot.windows.five_hour.as_ref().map(Window::from_quota),
                seven_day: snapshot.windows.seven_day.as_ref().map(Window::from_quota),
            };
            record.valid(now).then_some(record)
        }).collect();
        records.sort_by(|a, b| b.collected_at.cmp(&a.collected_at).then_with(|| a.stamp.cmp(&b.stamp)));
        records.truncate(MAX_BINDINGS);
        if write(path, &DiskCache { version: 1, records }).is_err() {
            // The directory can remain writable even when another process
            // locks the main cache against both replacement and deletion.
            let _ = std::fs::File::create(invalidation_path(path)).and_then(|mut file| {
                file.write_all(b"invalidated\n")?;
                file.sync_all()
            });
            // An older file may contain a now-invalidated identity. Prefer no
            // restart cache when replacement fails; memory remains authoritative.
            let _ = std::fs::remove_file(path);
            if !self.persistence_warned.swap(true, Ordering::Relaxed) {
                eprintln!("[codex-quota] cache persistence failed; using in-memory cache");
            }
        }
    }
}

#[cfg(test)]
mod tests;
