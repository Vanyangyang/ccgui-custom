use super::{EngineCatalog, EngineModel};
use std::collections::HashMap;
use std::sync::Mutex;

/// qoder has no static catalog and no cheap list subcommand: the only
/// CLI-sourced list is the ACP session/new handshake (spawns `qodercli
/// --acp`, seconds). Cache the last successful probe per engine id (Global
/// and CN handshake their own binaries) so reopening the picker does not
/// re-handshake every time.
static CACHE: Mutex<Option<HashMap<&'static str, Vec<EngineModel>>>> = Mutex::new(None);

pub(super) async fn qoder_catalog(
    engine: &'static str,
    bin: &str,
) -> Result<EngineCatalog, String> {
    {
        let cached = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(models) = cached.as_ref().and_then(|map| map.get(engine)) {
            return Ok(EngineCatalog::authoritative(models.clone()));
        }
    }
    let entries = crate::engine::qoder_session::probe_models(bin).await?;
    // session/new marks the current model as default: lead with it, since
    // the frontend auto-selects the first entry when nothing is pinned.
    let default_index = entries.iter().position(|entry| entry.is_default);
    let mut models: Vec<EngineModel> = entries
        .into_iter()
        .map(|entry| EngineModel {
            id: entry.id,
            name: entry.name,
            description: None,
            provider: engine.to_string(),
            context_window: None,
        })
        .collect();
    if let Some(index) = default_index.filter(|index| *index > 0) {
        let entry = models.remove(index);
        models.insert(0, entry);
    }
    if !models.is_empty() {
        let mut cached = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        cached
            .get_or_insert_with(HashMap::new)
            .insert(engine, models.clone());
    }
    Ok(EngineCatalog::authoritative(models))
}
