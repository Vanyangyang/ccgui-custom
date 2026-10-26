use super::{EngineCatalog, EngineModel};
use crate::engine::cursor_picker::{self, CursorPickerModel};
use std::{collections::HashMap, sync::{Mutex, OnceLock}};

fn model(id: &str, label: &str) -> EngineModel {
    EngineModel {
        id: id.to_owned(), name: Some(label.to_owned()), description: None,
        provider: "cursor".to_owned(), context_window: None,
    }
}

fn fallback() -> EngineCatalog {
    EngineCatalog { models: vec![model("auto", "Auto")], authoritative: false, remote: false }
}

fn project_catalog(cache: &mut HashMap<String, Vec<EngineModel>>, bin: &str, result: Result<Vec<CursorPickerModel>, String>) -> EngineCatalog {
    if let Ok(models) = result {
        let models: Vec<_> = models.iter().map(|entry| model(&entry.id, &entry.name)).collect();
        if !models.is_empty() {
            cache.insert(bin.to_owned(), models.clone());
            return EngineCatalog::authoritative(models);
        }
    }
    EngineCatalog {
        models: cache.get(bin).cloned().unwrap_or_else(|| fallback().models),
        authoritative: false, remote: false,
    }
}

/// Both surfaces share the noninteractive ACP request and its single-flight
/// cache. Never fall back to launching `cursor-agent models`. Last successful
/// rows remain available after transient probe failures.
pub(super) async fn cursor_catalog() -> EngineCatalog {
    let Ok(bin) = cursor_picker::catalog_binary() else { return fallback() };
    let result = cursor_picker::cursor_picker_catalog(&bin).await;
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<EngineModel>>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap_or_else(|error| error.into_inner());
    project_catalog(&mut cache, &bin, result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acp_model() -> CursorPickerModel {
        CursorPickerModel { id: "fixture-model".into(), name: "Fixture Model".into(), parameters: vec![] }
    }

    #[test]
    fn acp_projection_preserves_identity_without_inventing_context() {
        let mut cache = HashMap::new();
        let catalog = project_catalog(&mut cache, "fake", Ok(vec![acp_model()]));
        assert!(catalog.authoritative);
        assert!(!catalog.remote);
        let projected = &catalog.models[0];
        assert_eq!(projected.id, "fixture-model");
        assert_eq!(projected.name.as_deref(), Some("Fixture Model"));
        assert_eq!(projected.provider, "cursor");
        assert_eq!(projected.context_window, None);
    }

    #[test]
    fn failure_or_empty_catalog_preserves_success_only_for_its_binary() {
        let mut cache = HashMap::new();
        project_catalog(&mut cache, "fake", Ok(vec![acp_model()]));
        for result in [Err("cursor_auth_required".into()), Ok(Vec::new())] {
            let stale = project_catalog(&mut cache, "fake", result);
            assert!(!stale.authoritative);
            assert!(!stale.remote);
            assert_eq!(stale.models[0].id, "fixture-model");
        }
        let missing = project_catalog(&mut cache, "other-fake", Err("unavailable".into()));
        assert!(!missing.authoritative);
        assert_eq!(missing.models[0].id, "auto");
    }
}
