use super::{run_probe, EngineCatalog, EngineModel};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
};

/// `cursor-agent models` prints `<id> - <label>` rows after a header. Rows
/// may end with a state suffix such as `(current, default)`.
pub(super) fn parse_models(stdout: &str) -> Vec<EngineModel> {
    let mut seen = HashSet::new();
    stdout
        .lines()
        .filter_map(|line| {
            let line = strip_ansi(line);
            let (id, label) = line.trim().split_once(" - ")?;
            let (id, label) = (id.trim(), strip_state_suffix(label.trim()));
            if id.is_empty() || id.chars().any(char::is_whitespace) || label.is_empty() || !seen.insert(id.to_string()) {
                return None;
            }
            Some(model(id, label))
        })
        .collect()
}

fn strip_state_suffix(label: &str) -> &str {
    match label.rfind(" (") {
        Some(at) if label.ends_with(')') => {
            let state = &label[at + 2..label.len() - 1];
            if state
                .split(',')
                .map(str::trim)
                .all(|part| matches!(part, "current" | "default"))
            {
                label[..at].trim()
            } else {
                label
            }
        }
        _ => label,
    }
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn model(id: &str, label: &str) -> EngineModel {
    EngineModel {
        id: id.to_owned(),
        name: Some(label.to_owned()),
        description: None,
        provider: "cursor".to_owned(),
        context_window: None,
    }
}

fn fallback_models() -> Vec<EngineModel> {
    vec![model("auto", "Auto")]
}

/// Live catalog from the selected binary; the last successful probe (per
/// binary) survives a transient failure, never asserted as authoritative.
pub(super) async fn cursor_catalog(bin: &str) -> EngineCatalog {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<EngineModel>>>> = OnceLock::new();
    let live = run_probe(bin, &["models"], "models")
        .await
        .ok()
        .map(|stdout| parse_models(&stdout))
        .filter(|models| !models.is_empty());
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(models) = live {
        cache.insert(bin.to_owned(), models.clone());
        return EngineCatalog::authoritative(models);
    }
    EngineCatalog {
        models: cache.get(bin).cloned().unwrap_or_else(fallback_models),
        authoritative: false,
        remote: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rows_and_strips_state_suffix() {
        let models = parse_models(
            "Available models\r\n\r\nauto - Auto (current, default)\r\ngpt-5.2 - GPT-5.2\r\n\u{1b}[2mcomposer-2.5 - Composer 2.5 (default)\u{1b}[0m\r\nauto - dup\r\nTip: use --model\r\n",
        );
        let rows: Vec<_> = models
            .iter()
            .map(|m| (m.id.as_str(), m.name.as_deref().unwrap()))
            .collect();
        assert_eq!(rows, [("auto", "Auto"), ("gpt-5.2", "GPT-5.2"), ("composer-2.5", "Composer 2.5")]);
    }

    #[test]
    fn keeps_meaningful_parentheses() {
        assert_eq!(strip_state_suffix("Opus (1M context)"), "Opus (1M context)");
    }
}
