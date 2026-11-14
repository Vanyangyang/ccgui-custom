//! Static declarations only; never imports extensions, expands env, or connects MCP.
//! Verified against can1357/oh-my-pi c29f7c56f5530d805bb2887ade964aa55970d8e1:
//! docs/mcp-config.md and packages/coding-agent/src/discovery/
//! {omp-plugins,claude-plugins,agent-plugin-format,agent-plugins}.ts.
//! Returned names are local declaration keys, not runtime plugin namespaces.
//! Values remain literal for host redaction. Success does NOT prove completeness:
//! extension code may register additional servers. The UI must retain that caveat.
//! This is a declaration reader, not OMP's runtime validator or effective-config
//! resolver (provider priorities are native=100, extensions=90, portable=75,
//! marketplace=70). Host/global configs are intentionally out of scope.
//! Remote server URLs are returned as data; remote declaration-file references
//! are rejected. No referenced executable, cwd, or server endpoint is accessed.
//! Filesystem checks reject existing links/junctions, but are not a sandbox
//! against an adversary concurrently replacing ancestor directories.

use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Component, Path},
};

const LIMIT: u64 = 1024 * 1024;
const INVALID: &str = "Invalid or unsupported static OMP MCP declaration";
const UNSAFE: &str = "Unsafe OMP MCP declaration path";
const IO_ERROR: &str = "Cannot read static OMP MCP declaration";
const MANIFEST_SCHEMA: &str = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA: &str = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

fn object(value: &Value) -> Result<&Map<String, Value>, String> {
    value.as_object().ok_or_else(|| INVALID.into())
}

/// Reject links/reparse points as well as proving canonical containment. This
/// deliberately also rejects in-root links: discovery need not follow them.
fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn document(root: &Path, relative: &str, required: bool) -> Result<Option<Value>, String> {
    // Check both separator styles on every OS; reject URLs, ADS, drive prefixes,
    // UNC, placeholders and traversal before touching the referenced file.
    if relative.is_empty()
        || relative.contains([':', '\\', '$', '\0'])
        || relative.starts_with('/')
        || Path::new(relative)
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(UNSAFE.into());
    }
    let mut candidate = root.to_path_buf();
    for part in Path::new(relative).components() {
        candidate.push(part);
        match fs::symlink_metadata(&candidate) {
            Ok(meta) if linked(&meta) => return Err(UNSAFE.into()),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !required => return Ok(None),
            Err(_) => return Err(IO_ERROR.into()),
        }
    }
    let canonical = fs::canonicalize(&candidate).map_err(|_| IO_ERROR.to_owned())?;
    if !canonical.starts_with(root) {
        return Err(UNSAFE.into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Do not follow a final-component reparse point swapped after checking;
        // deny writes/deletion of the opened file while reading.
        options.custom_flags(0x00200000).share_mode(1);
    }
    let file = options.open(&canonical).map_err(|_| IO_ERROR.to_owned())?;
    let meta = file.metadata().map_err(|_| IO_ERROR.to_owned())?;
    if linked(&meta) || !meta.is_file() {
        return Err(UNSAFE.into());
    }
    if meta.len() > LIMIT {
        return Err("OMP MCP declaration exceeds size limit".into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| IO_ERROR.to_owned())?;
    if bytes.len() as u64 > LIMIT {
        return Err("OMP MCP declaration exceeds size limit".into());
    }
    // Never include serde errors, paths, keys or values (all can contain secrets).
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| INVALID.to_owned())?;
    object(&value)?;
    Ok(Some(value))
}

fn servers(value: &Value, flat: bool, portable: bool) -> Result<Vec<(String, Value)>, String> {
    let doc = object(value)?;
    if portable
        && (doc.get("$schema").and_then(Value::as_str) != Some(MCP_SCHEMA)
            || doc.keys().any(|k| k != "$schema" && k != "mcpServers"))
    {
        return Err(INVALID.into());
    }
    let map = match doc.get("mcpServers") {
        Some(v) => object(v)?,
        None if flat => doc,
        None => return Err(INVALID.into()),
    };
    entries(map, portable)
}

fn entries(map: &Map<String, Value>, portable: bool) -> Result<Vec<(String, Value)>, String> {
    let mut out = Vec::new();
    for (name, value) in map {
        let cfg = object(value)?;
        if name.trim().is_empty()
            || !(cfg.get("command").is_some_and(Value::is_string)
                || cfg.get("url").is_some_and(Value::is_string))
        {
            return Err(INVALID.into());
        }
        for field in ["command", "url", "cwd", "type"] {
            if cfg.get(field).is_some_and(|v| !v.is_string()) {
                return Err(INVALID.into());
            }
        }
        if cfg
            .get("args")
            .is_some_and(|v| !v.as_array().is_some_and(|a| a.iter().all(Value::is_string)))
        {
            return Err(INVALID.into());
        }
        for field in ["env", "headers"] {
            if cfg.get(field).is_some_and(|v| {
                !v.as_object()
                    .is_some_and(|m| m.values().all(Value::is_string))
            }) {
                return Err(INVALID.into());
            }
        }
        if portable {
            let allowed: &[&str] = match cfg.get("type").and_then(Value::as_str) {
                Some("stdio") if cfg.get("command").is_some_and(Value::is_string) => {
                    &["type", "command", "args", "env", "cwd"]
                }
                Some("streamable-http" | "sse") if cfg.get("url").is_some_and(Value::is_string) => {
                    &["type", "url", "headers"]
                }
                _ => return Err(INVALID.into()),
            };
            if cfg.keys().any(|k| !allowed.contains(&k.as_str())) {
                return Err(INVALID.into());
            }
        }
        out.push((name.clone(), value.clone()));
    }
    Ok(out)
}

fn portable_manifest(value: &Value) -> Result<bool, String> {
    let manifest = object(value)?;
    let Some(schema) = manifest.get("$schema") else {
        return Ok(false);
    };
    let schema = schema.as_str().ok_or(INVALID)?;
    if !schema.starts_with("https://agent-plugins.org/schemas/") {
        return Ok(false);
    }
    if schema != MANIFEST_SCHEMA {
        return Err(INVALID.into());
    }
    let name = manifest
        .get("name")
        .and_then(Value::as_str)
        .ok_or(INVALID)?;
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    if name.is_empty()
        || name.len() > 64
        || !alnum(name.as_bytes()[0])
        || !alnum(*name.as_bytes().last().unwrap())
        || name.contains("--")
        || name.contains("..")
        || !name.bytes().all(|b| alnum(b) || b == b'-' || b == b'.')
    {
        return Err(INVALID.into());
    }
    for field in [
        "version",
        "description",
        "homepage",
        "repository",
        "license",
    ] {
        if manifest.get(field).is_some_and(|v| !v.is_string()) {
            return Err(INVALID.into());
        }
    }
    if manifest
        .get("keywords")
        .is_some_and(|v| !v.as_array().is_some_and(|a| a.iter().all(Value::is_string)))
    {
        return Err(INVALID.into());
    }
    if let Some(author) = manifest.get("author") {
        if object(author)?
            .iter()
            .any(|(k, v)| !["name", "email", "url"].contains(&k.as_str()) || !v.is_string())
        {
            return Err(INVALID.into());
        }
    }
    Ok(true)
}

pub(super) fn read(root: &Path, kind: &str) -> Result<Vec<(String, Value)>, String> {
    if !matches!(kind, "npm" | "marketplace") {
        return Err(INVALID.into());
    }
    let root = fs::canonicalize(root).map_err(|_| IO_ERROR.to_owned())?;
    if !root.is_dir() {
        return Err(UNSAFE.into());
    }
    // Portable manifests govern MCP exclusively in either installation kind.
    if let Some(manifest) = document(&root, "plugin.json", false)? {
        if portable_manifest(&manifest)? {
            return document(&root, "mcp.json", false)?
                .map_or(Ok(Vec::new()), |v| servers(&v, false, true));
        }
    }
    if kind == "npm" {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        // OMP emits in this order; capability dedup keeps the first name.
        for path in [".mcp.json", "mcp.json"] {
            if let Some(doc) = document(&root, path, false)? {
                for (name, value) in servers(&doc, false, false)? {
                    if seen.insert(name.clone()) {
                        out.push((name, value));
                    }
                }
            }
        }
        return Ok(out);
    }
    for path in [".omp-plugin/plugin.json", ".claude-plugin/plugin.json"] {
        if let Some(manifest) = document(&root, path, false)? {
            if let Some(pointer) = manifest.get("mcpServers") {
                return match pointer {
                    Value::Object(map) => entries(map, false),
                    Value::String(path) if !path.trim().is_empty() => {
                        let doc = document(&root, path.trim(), true)?.ok_or(IO_ERROR)?;
                        servers(&doc, true, false)
                    }
                    // OMP skips empty strings; retain that documented fallback.
                    Value::String(_) => continue,
                    _ => Err(INVALID.into()),
                };
            }
        }
    }
    document(&root, ".mcp.json", false)?.map_or(Ok(Vec::new()), |v| servers(&v, true, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("omp-mcp-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn put(&self, path: &str, value: Value) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn native_sources_merge_first_name_wins_and_preserve_literals() {
        let f = Fixture::new();
        f.put(
            ".mcp.json",
            json!({"mcpServers":{"same":{"command":"first","env":{"TOKEN":"!do-not-execute"}}}}),
        );
        f.put("mcp.json", json!({"mcpServers":{"same":{"command":"second"},"extra":{"url":"https://example.invalid"}}}));
        let rows = read(&f.0, "npm").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].1["command"], "first");
        assert_eq!(rows[0].1["env"]["TOKEN"], "!do-not-execute");
    }

    #[test]
    fn marketplace_inline_priority_and_empty_map_are_authoritative() {
        let f = Fixture::new();
        f.put(
            ".omp-plugin/plugin.json",
            json!({"mcpServers":{"native":{"command":"native"}}}),
        );
        f.put(
            ".claude-plugin/plugin.json",
            json!({"mcpServers":{"claude":{"command":"claude"}}}),
        );
        f.put(".mcp.json", json!({"fallback":{"command":"fallback"}}));
        assert_eq!(read(&f.0, "marketplace").unwrap()[0].0, "native");
        f.put(".omp-plugin/plugin.json", json!({}));
        assert_eq!(read(&f.0, "marketplace").unwrap()[0].0, "claude");
        f.put(".claude-plugin/plugin.json", json!({"mcpServers":{}}));
        assert!(read(&f.0, "marketplace").unwrap().is_empty());
    }

    #[test]
    fn marketplace_pointer_supports_both_file_shapes_and_fallback() {
        let f = Fixture::new();
        for doc in [
            json!({"one":{"command":"x"}}),
            json!({"mcpServers":{"one":{"command":"x"}}}),
        ] {
            f.put(
                ".omp-plugin/plugin.json",
                json!({"mcpServers":"./config/servers.json"}),
            );
            f.put("config/servers.json", doc.clone());
            assert_eq!(read(&f.0, "marketplace").unwrap().len(), 1);
            f.put(".omp-plugin/plugin.json", json!({}));
            f.put(".mcp.json", doc);
            assert_eq!(read(&f.0, "marketplace").unwrap().len(), 1);
        }
    }

    #[test]
    fn portable_overrides_both_legacy_providers() {
        let f = Fixture::new();
        f.put(
            "plugin.json",
            json!({"$schema":MANIFEST_SCHEMA,"name":"portable"}),
        );
        f.put(
            "mcp.json",
            json!({"$schema":MCP_SCHEMA,"mcpServers":{"p":{"type":"stdio","command":"node"}}}),
        );
        f.put(
            ".mcp.json",
            json!({"mcpServers":{"legacy":{"command":"old"}}}),
        );
        f.put(
            ".omp-plugin/plugin.json",
            json!({"mcpServers":{"inline":{"command":"old"}}}),
        );
        for kind in ["npm", "marketplace"] {
            let rows = read(&f.0, kind).unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].0, "p");
        }
        f.put("mcp.json", json!({"mcpServers":{}}));
        assert!(read(&f.0, "npm").is_err());
        f.put("plugin.json", json!({"$schema":"https://agent-plugins.org/schemas/future/plugin.schema.json","name":"p"}));
        assert!(read(&f.0, "npm").is_err());
    }

    #[test]
    fn unsafe_missing_dynamic_and_unknown_declarations_fail_without_secrets() {
        let f = Fixture::new();
        for pointer in [
            json!("../SECRET.json"),
            json!("https://SECRET.invalid/mcp"),
            json!("C:/SECRET.json"),
            json!("//SECRET/share"),
            json!("config\\SECRET.json"),
            json!("${SECRET}/mcp.json"),
            json!("missing-SECRET.json"),
            json!(["SECRET"]),
            json!(false),
        ] {
            f.put(".omp-plugin/plugin.json", json!({"mcpServers":pointer}));
            let error = read(&f.0, "marketplace").unwrap_err();
            assert!(!error.contains("SECRET"));
        }
        f.put(
            ".mcp.json",
            json!({"mcpServers":{"SECRET":{"env":{"TOKEN":"SECRET"}}}}),
        );
        assert!(!read(&f.0, "npm").unwrap_err().contains("SECRET"));
        fs::write(f.0.join(".mcp.json"), br#"{"SECRET": broken}"#).unwrap();
        assert!(!read(&f.0, "npm").unwrap_err().contains("SECRET"));
        assert!(read(&f.0, "unknown").is_err());
    }

    #[test]
    fn absent_is_empty_but_wrong_shape_size_and_directory_fail() {
        let f = Fixture::new();
        assert!(read(&f.0, "npm").unwrap().is_empty());
        for doc in [
            json!([]),
            json!({"mcpServers":null}),
            json!({"unexpected":{}}),
        ] {
            f.put(".mcp.json", doc);
            assert!(read(&f.0, "npm").is_err());
        }
        fs::write(f.0.join(".mcp.json"), vec![b' '; LIMIT as usize + 1]).unwrap();
        assert!(read(&f.0, "npm").unwrap_err().contains("size limit"));
        fs::remove_file(f.0.join(".mcp.json")).unwrap();
        fs::create_dir(f.0.join(".mcp.json")).unwrap();
        assert!(read(&f.0, "npm").is_err());
    }

    #[test]
    fn rejects_link_escape_before_reading() {
        let f = Fixture::new();
        let outside = Fixture::new();
        outside.put("servers.json", json!({"SECRET":{"command":"SECRET"}}));
        let link = f.0.join("escape");
        #[cfg(windows)]
        {
            // Junctions do not require symlink privilege on Windows.
            let status = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:OMP_MCP_TEST_LINK -Target $env:OMP_MCP_TEST_TARGET | Out-Null"])
                .env("OMP_MCP_TEST_LINK", &link).env("OMP_MCP_TEST_TARGET", &outside.0).status().unwrap();
            assert!(status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside.0, &link).unwrap();
        f.put(
            ".omp-plugin/plugin.json",
            json!({"mcpServers":"escape/servers.json"}),
        );
        assert_eq!(read(&f.0, "marketplace").unwrap_err(), UNSAFE);
        // A dangling reference beneath an escaping directory is also unsafe.
        f.put(
            ".omp-plugin/plugin.json",
            json!({"mcpServers":"escape/missing.json"}),
        );
        assert_eq!(read(&f.0, "marketplace").unwrap_err(), UNSAFE);
        #[cfg(windows)]
        fs::remove_dir(link).unwrap();
        #[cfg(unix)]
        fs::remove_file(link).unwrap();
    }
}
