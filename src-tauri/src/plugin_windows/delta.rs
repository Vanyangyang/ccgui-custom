//! Private delta-v1 transport. Preflight every disjoint path and byte delta
//! before mutation: applying a patch never clones or serializes the full state.
use super::{Snapshot, MAX_STATE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::VecDeque, io};

pub(super) const MAX_REVISION: u64 = 9_007_199_254_740_991;
const MAX_PATCH: usize = 256 * 1024;
const MAX_LOG: usize = 1024 * 1024;
const INVALID: &str = "plugin_window_invalid_snapshot_update";
const CONFLICT: &str = "plugin_window_snapshot_conflict";
const BASE: &str = "plugin_window_snapshot_base_mismatch";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Segment {
    Key(String),
    Index(u64),
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Change {
    Set { path: Vec<Segment>, value: Value },
    Remove { path: Vec<Segment> },
}
impl Change {
    fn path(&self) -> &[Segment] {
        match self {
            Self::Set { path, .. } | Self::Remove { path } => path,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Update {
    Full {
        snapshot: Snapshot,
    },
    Patch {
        #[serde(rename = "baseRevision")]
        base_revision: u64,
        revision: u64,
        changes: Vec<Change>,
    },
    Unchanged {
        revision: u64,
    },
}
impl Update {
    pub(super) fn revision(&self) -> u64 {
        match self {
            Self::Full { snapshot } => snapshot.revision,
            Self::Patch { revision, .. } | Self::Unchanged { revision } => *revision,
        }
    }
    pub(super) fn validate(&self) -> Result<(), String> {
        revision(self.revision())?;
        match self {
            Self::Full { snapshot } => {
                validate_full(snapshot)?;
            }
            Self::Patch {
                base_revision,
                revision: target,
                changes,
            } => {
                revision(*base_revision)?;
                if target <= base_revision || changes.len() > 256 || bytes(self) > MAX_PATCH {
                    return Err(INVALID.into());
                }
                for (index, change) in changes.iter().enumerate() {
                    let path = change.path();
                    if path.len() > 64
                        || path
                            .iter()
                            .any(|s| matches!(s, Segment::Index(i) if *i > MAX_REVISION))
                    {
                        return Err(INVALID.into());
                    }
                    match change {
                        Change::Set { value, .. } => depth(value, path.len())?,
                        Change::Remove { .. } if !matches!(path.last(), Some(Segment::Key(_))) => {
                            return Err(INVALID.into())
                        }
                        _ => (),
                    }
                    if changes[..index]
                        .iter()
                        .any(|other| overlaps(path, other.path()))
                    {
                        return Err(INVALID.into());
                    }
                }
            }
            _ => (),
        }
        Ok(())
    }
}
fn revision(value: u64) -> Result<(), String> {
    if value > MAX_REVISION {
        Err(INVALID.into())
    } else {
        Ok(())
    }
}
fn depth(value: &Value, level: usize) -> Result<(), String> {
    if level > 64 {
        return Err(INVALID.into());
    }
    match value {
        Value::Object(map) => {
            for child in map.values() {
                depth(child, level + 1)?;
            }
        }
        Value::Array(array) => {
            for child in array {
                depth(child, level + 1)?;
            }
        }
        _ => (),
    }
    Ok(())
}
struct Counter(usize);
impl io::Write for Counter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(super) fn bytes(value: &impl Serialize) -> usize {
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value).expect("JSON values serialize");
    counter.0
}
// serde_json and JavaScript use different decimal/scientific thresholds.
// An outgoing patch is normalized and measured again by the JS decoder, so
// reserve 32 bytes per number rather than relying on serde's shorter spelling.
// This is deliberately conservative and only affects outgoing recovery patches;
// canonical accounting and incoming validation remain exact native JSON sizes.
fn js_number_padding(value: &Value) -> usize {
    match value {
        Value::Number(number) => 32usize.saturating_sub(bytes(number)),
        Value::Array(array) => array.iter().map(js_number_padding).sum(),
        Value::Object(map) => map.values().map(js_number_padding).sum(),
        _ => 0,
    }
}
pub(super) fn validate_full(snapshot: &Snapshot) -> Result<(), String> {
    revision(snapshot.revision)?;
    depth(&snapshot.state, 0)?;
    if bytes(&snapshot.state) > MAX_STATE {
        return Err("plugin_window_state_too_large".into());
    }
    Ok(())
}
fn overlaps(a: &[Segment], b: &[Segment]) -> bool {
    a.starts_with(b) || b.starts_with(a)
}
fn get<'a>(mut value: &'a Value, path: &[Segment]) -> Option<&'a Value> {
    for part in path {
        value = match (value, part) {
            (Value::Object(map), Segment::Key(key)) => map.get(key)?,
            (Value::Array(array), Segment::Index(index)) => {
                array.get(usize::try_from(*index).ok()?)?
            }
            _ => return None,
        };
    }
    Some(value)
}
fn get_mut<'a>(mut value: &'a mut Value, path: &[Segment]) -> &'a mut Value {
    for part in path {
        value = match (value, part) {
            (Value::Object(map), Segment::Key(key)) => map.get_mut(key).unwrap(),
            (Value::Array(array), Segment::Index(index)) => &mut array[*index as usize],
            _ => unreachable!("preflight validated path"),
        };
    }
    value
}
#[derive(Default)]
pub(super) struct DeltaState {
    pub(super) state_bytes: usize,
    log: VecDeque<(Update, usize)>,
    log_bytes: usize,
}
impl DeltaState {
    pub(super) fn new(state: &Value) -> Self {
        Self {
            state_bytes: bytes(state),
            ..Self::default()
        }
    }
    pub(super) fn apply(
        &mut self,
        canonical: &mut Snapshot,
        update: Update,
    ) -> Result<Option<Update>, String> {
        update.validate()?; // Even stale messages must have a valid wire shape/value.
        let target = update.revision();
        if target < canonical.revision {
            return Ok(None);
        }
        match &update {
            Update::Unchanged { .. } => {
                if target > canonical.revision {
                    return Err(BASE.into());
                }
                return Ok(None);
            }
            Update::Full { snapshot } if target == canonical.revision => {
                return if snapshot == canonical {
                    Ok(None)
                } else {
                    Err(CONFLICT.into())
                };
            }
            Update::Patch { changes, .. } if target == canonical.revision => {
                for change in changes {
                    let path = change.path();
                    // A removed key must still have a valid object parent.
                    let valid = match change {
                        Change::Set { value, .. } => get(&canonical.state, path) == Some(value),
                        Change::Remove { .. } => {
                            let (last, parent) = path.split_last().ok_or(INVALID)?;
                            matches!((get(&canonical.state, parent), last), (Some(Value::Object(map)), Segment::Key(key)) if !map.contains_key(key))
                        }
                    };
                    if !valid {
                        return Err(CONFLICT.into());
                    }
                }
                return Ok(None);
            }
            Update::Patch { base_revision, .. } if *base_revision != canonical.revision => {
                return Err(BASE.into())
            }
            _ => (),
        }
        // Keep only bounded patches in the log; full updates form a recovery barrier.
        let event = update.clone();
        let state_changed;
        match update {
            Update::Full { snapshot } => {
                state_changed = snapshot.state != canonical.state;
                self.state_bytes = bytes(&snapshot.state);
                *canonical = snapshot;
                self.log.clear();
                self.log_bytes = 0;
            }
            Update::Patch {
                revision, changes, ..
            } => {
                state_changed = changes.iter().any(|change| match change {
                    Change::Set { path, value } => get(&canonical.state, path) != Some(value),
                    Change::Remove { .. } => true,
                });
                let mut total = self.state_bytes as i128;
                // Object membership changes need a single aggregate comma adjustment
                // per parent (multiple independent additions/removals may share it).
                let mut object_counts: Vec<(Vec<Segment>, usize, i128)> = Vec::new();
                for change in &changes {
                    let path = change.path();
                    if path.is_empty() {
                        if let Change::Set { value, .. } = change {
                            total += bytes(value) as i128 - self.state_bytes as i128;
                        }
                        continue;
                    }
                    let (last, parent_path) = path.split_last().unwrap();
                    let parent = get(&canonical.state, parent_path).ok_or(INVALID)?;
                    match (parent, last, change) {
                        (Value::Object(map), Segment::Key(key), _) => {
                            let old = map.get(key);
                            let key_bytes = bytes(key) + 1;
                            let (delta, count) = match change {
                                Change::Set { value, .. } => (
                                    bytes(value) as i128 - old.map_or(0, bytes) as i128
                                        + if old.is_none() { key_bytes as i128 } else { 0 },
                                    if old.is_none() { 1 } else { 0 },
                                ),
                                Change::Remove { .. } => {
                                    let old = old.ok_or(INVALID)?;
                                    (-(bytes(old) as i128) - key_bytes as i128, -1)
                                }
                            };
                            total += delta;
                            if count != 0 {
                                if let Some(item) =
                                    object_counts.iter_mut().find(|item| item.0 == parent_path)
                                {
                                    item.2 += count;
                                } else {
                                    object_counts.push((parent_path.to_vec(), map.len(), count));
                                }
                            }
                        }
                        (Value::Array(array), Segment::Index(index), Change::Set { value, .. }) => {
                            let old = usize::try_from(*index)
                                .ok()
                                .and_then(|index| array.get(index))
                                .ok_or(INVALID)?;
                            total += bytes(value) as i128 - bytes(old) as i128;
                        }
                        _ => return Err(INVALID.into()),
                    }
                }
                for (_, count, delta) in object_counts {
                    total += (count as i128 + delta - 1).max(0) - (count as i128 - 1).max(0);
                }
                if total < 0 || total > MAX_STATE as i128 {
                    return Err("plugin_window_state_too_large".into());
                }
                // All operations are disjoint and checked, so mutation cannot fail.
                for change in changes {
                    let (path, new) = match change {
                        Change::Set { path, value } => (path, Some(value)),
                        Change::Remove { path } => (path, None),
                    };
                    if path.is_empty() {
                        canonical.state = new.unwrap();
                        continue;
                    }
                    let (last, parent) = path.split_last().unwrap();
                    match (get_mut(&mut canonical.state, parent), last) {
                        (Value::Object(map), Segment::Key(key)) => {
                            if let Some(value) = new {
                                map.insert(key.clone(), value);
                            } else {
                                map.remove(key);
                            }
                        }
                        (Value::Array(array), Segment::Index(index)) => {
                            array[*index as usize] = new.unwrap()
                        }
                        _ => unreachable!("preflight validated path"),
                    }
                }
                canonical.revision = revision;
                self.state_bytes = total as usize;
                let size = bytes(&event);
                self.log.push_back((event.clone(), size));
                self.log_bytes += size;
                while self.log.len() > 32 || self.log_bytes > MAX_LOG {
                    self.log_bytes -= self.log.pop_front().unwrap().1;
                }
            }
            _ => unreachable!(),
        }
        Ok(state_changed.then_some(event))
    }
    pub(super) fn since(&self, canonical: &Snapshot, known: u64) -> Result<Update, String> {
        revision(known)?;
        if known > canonical.revision {
            return Err(BASE.into());
        }
        if known == canonical.revision {
            return Ok(Update::Unchanged { revision: known });
        }
        let full = || Update::Full {
            snapshot: canonical.clone(),
        };
        let mut next = known;
        let mut paths: Vec<Vec<Segment>> = Vec::new();
        for (update, _) in &self.log {
            let Update::Patch {
                base_revision,
                revision,
                changes,
            } = update
            else {
                continue;
            };
            if *revision <= next {
                continue;
            }
            if *base_revision != next {
                return Ok(full());
            }
            for change in changes {
                let path = change.path();
                if paths.iter().any(|old| path.starts_with(old)) {
                    continue;
                }
                paths.retain(|old| !old.starts_with(path));
                paths.push(path.to_vec());
            }
            next = *revision;
        }
        if next != canonical.revision || paths.len() > 256 {
            return Ok(full());
        }
        let mut changes = Vec::new();
        let mut estimated = 0;
        let mut number_padding = 0;
        for path in paths {
            // Check subtrees before cloning; a merged ancestor can exceed patch budget.
            if let Some(value) = get(&canonical.state, &path) {
                let padding = js_number_padding(value);
                estimated += bytes(value) + padding + bytes(&path) + 40;
                if estimated > MAX_PATCH {
                    return Ok(full());
                }
                number_padding += padding;
                changes.push(Change::Set {
                    path,
                    value: value.clone(),
                });
            } else {
                estimated += bytes(&path) + 40;
                if estimated > MAX_PATCH {
                    return Ok(full());
                }
                changes.push(Change::Remove { path });
            }
        }
        let update = Update::Patch {
            base_revision: known,
            revision: canonical.revision,
            changes,
        };
        // Include the exact envelope, paths, set/remove wrappers and commas.
        // Revisions and numeric path segments are safe integers and already
        // have identical decimal spellings in Rust and JavaScript.
        if bytes(&update) + number_padding > MAX_PATCH || update.validate().is_err() {
            return Ok(full());
        }
        Ok(update)
    }
}

#[cfg(test)]
mod tests;
