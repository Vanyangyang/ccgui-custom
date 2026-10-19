use super::{run_probe, EngineCatalog, EngineModel};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};

const SNAPSHOT: &str = include_str!("../../../resources/engine-models/agy.json");
const CACHE_LIMIT: usize = 8;
type CacheKey = (String, PathBuf);
#[derive(Default)]
struct CatalogCache(Vec<(CacheKey, u64, Vec<EngineModel>)>);
impl CatalogCache {
    fn get(&self, key: &CacheKey) -> Option<Vec<EngineModel>> {
        self.0
            .iter()
            .find(|(k, _, _)| k == key)
            .map(|(_, _, models)| models.clone())
    }
    fn remember(&mut self, key: CacheKey, sequence: u64, models: Vec<EngineModel>) {
        // A slower older probe must not overwrite a newer successful probe.
        if self.0.iter().any(|(k, s, _)| k == &key && *s > sequence) {
            return;
        }
        self.0.retain(|(k, _, _)| k != &key);
        self.0.push((key, sequence, models));
        self.0.sort_by_key(|(_, s, _)| *s);
        if self.0.len() > CACHE_LIMIT {
            self.0.remove(0);
        }
    }
    fn resolve(
        &mut self,
        key: CacheKey,
        sequence: u64,
        live: Option<Vec<EngineModel>>,
    ) -> EngineCatalog {
        if let Some(models) = live.filter(|models| !models.is_empty()) {
            self.remember(key, sequence, models.clone());
            return EngineCatalog::authoritative(models);
        }
        EngineCatalog {
            models: self.get(&key).unwrap_or_else(fallback_models),
            authoritative: false,
            remote: false,
        }
    }
}

pub(super) async fn agy_catalog(bin: &str) -> EngineCatalog {
    static CACHE: OnceLock<Mutex<CatalogCache>> = OnceLock::new();
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let key = (bin.to_owned(), crate::engine::agy::agy_home());
    let mut live = None;
    if let Ok(stdout) = run_probe(bin, &["--output-format", "json", "models"], "models JSON").await
    {
        live = parse_agy_models_json(&stdout);
    }
    if live.is_none() {
        if let Ok(stdout) = run_probe(bin, &["models"], "models").await {
            let models = parse_agy_models_tsv(&stdout);
            if !models.is_empty() {
                live = Some(models);
            }
        }
    }
    // Never hold the cache lock across a child-process await.
    CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .resolve(key, sequence, live)
}

fn parse_agy_models_json(stdout: &str) -> Option<Vec<EngineModel>> {
    stdout.match_indices('{').find_map(|(start, _)| {
        let root: serde_json::Value = serde_json::from_str(&stdout[start..]).ok()?;
        if root.get("status")?.as_str()? != "SUCCESS"
            || root.pointer("/command/name")?.as_str()? != "models"
        {
            return None;
        }
        parse_rows(root.pointer("/command/data/models")?)
    })
}
fn parse_rows(rows: &serde_json::Value) -> Option<Vec<EngineModel>> {
    let mut seen = HashSet::new();
    let models: Option<Vec<_>> = rows
        .as_array()?
        .iter()
        .map(|row| {
            let id = row.get("id")?.as_str()?.trim();
            let label = row.get("label")?.as_str()?.trim();
            if id.is_empty()
                || id.chars().any(char::is_whitespace)
                || label.is_empty()
                || !seen.insert(id)
            {
                return None;
            }
            Some(model(id, label))
        })
        .collect();
    models.filter(|models| !models.is_empty())
}
/// Compatibility for old CLIs which only support id<TAB>Display Name.
pub fn parse_agy_models_tsv(stdout: &str) -> Vec<EngineModel> {
    let mut seen = HashSet::new();
    stdout
        .lines()
        .filter_map(|line| {
            let (id, label) = line.trim().split_once('\t')?;
            let (id, label) = (id.trim(), label.trim());
            if id.is_empty()
                || id.chars().any(char::is_whitespace)
                || label.is_empty()
                || !seen.insert(id)
            {
                return None;
            }
            Some(model(id, label))
        })
        .collect()
}
fn model(id: &str, label: &str) -> EngineModel {
    EngineModel {
        id: id.to_owned(),
        name: Some(label.to_owned()),
        description: None,
        provider: provider_of(id).to_owned(),
        context_window: None,
    }
}
fn fallback_models() -> Vec<EngineModel> {
    let root: serde_json::Value = serde_json::from_str(SNAPSHOT).expect("valid AGY snapshot JSON");
    parse_rows(&root["models"]).expect("nonempty valid AGY snapshot models")
}
fn provider_of(id: &str) -> &'static str {
    let lower = id.to_ascii_lowercase();
    if lower.starts_with("claude") {
        "anthropic"
    } else if lower.starts_with("gpt") || lower.starts_with("o1") || lower.starts_with("o3") {
        "openai"
    } else {
        "google"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key(bin: &str, home: &str) -> CacheKey {
        (bin.into(), home.into())
    }
    fn rows(id: &str) -> Vec<EngineModel> {
        vec![model(id, "Test")]
    }
    #[test]
    fn json_accepts_progress_and_rejects_invalid_or_failed_catalogs() {
        let valid = serde_json::json!({"status":"SUCCESS","command":{"name":"models","data":{"models":[{"id":"claude-opus-5-5-high","label":"Opus"}]}}});
        let parsed = parse_agy_models_json(&format!("Fetching...\n{}\n", valid)).unwrap();
        assert_eq!(parsed[0].provider, "anthropic");
        assert_eq!(parsed[0].name.as_deref(), Some("Opus"));
        for invalid in [
            "{}".to_owned(),
            valid.to_string().replace("SUCCESS", "ERROR"),
            valid.to_string().replace("claude-opus-5-5-high", "bad id"),
        ] {
            assert!(parse_agy_models_json(&invalid).is_none());
        }
        assert!(parse_rows(&serde_json::json!([])).is_none());
        assert!(
            parse_rows(&serde_json::json!([{"id":"a","label":"A"},{"id":"a","label":"B"}]))
                .is_none()
        );
    }
    #[test]
    fn tsv_skips_status_blank_invalid_and_duplicate_rows() {
        let parsed = parse_agy_models_tsv(
            "Fetching...\n\ngemini-a\tGemini A\ngemini-a\tDuplicate\nbad id\tBad\ngpt-a\tGPT A\n",
        );
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].provider, "google");
        assert_eq!(parsed[1].provider, "openai");
    }
    #[test]
    fn only_live_nonempty_results_are_authoritative_and_cache_is_isolated() {
        let mut cache = CatalogCache::default();
        let identity = key("agy", "home");
        assert!(
            cache
                .resolve(identity.clone(), 1, Some(rows("live")))
                .authoritative
        );
        let offline = cache.resolve(identity.clone(), 2, None);
        assert!(!offline.authoritative);
        assert_eq!(offline.models[0].id, "live");
        assert!(!cache.resolve(identity, 3, Some(vec![])).authoritative);
        for other in [key("other", "home"), key("agy", "other")] {
            let snapshot = cache.resolve(other, 4, None);
            assert!(!snapshot.authoritative);
            assert!(!snapshot.models.is_empty());
            assert_eq!(snapshot.models.len(), fallback_models().len());
            assert!(snapshot.models.iter().all(|m| !m.id.contains("4-6")));
        }
    }
    #[test]
    fn cache_is_bounded_and_older_completion_cannot_replace_newer_success() {
        let mut cache = CatalogCache::default();
        let identity = key("agy", "home");
        cache.remember(identity.clone(), 10, rows("new"));
        cache.remember(identity.clone(), 9, rows("old"));
        assert_eq!(cache.get(&identity).unwrap()[0].id, "new");
        for i in 11..19 {
            cache.remember(key(&i.to_string(), "home"), i, rows("other"));
        }
        assert_eq!(cache.0.len(), CACHE_LIMIT);
        assert!(cache.get(&identity).is_none());
    }
}
