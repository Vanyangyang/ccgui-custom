//! Pure parser for `claude plugin list --json`; never starts or probes servers.

use serde_json::{Map, Value};
use std::path::Path;

// Deliberately neither Serialize nor Debug: MCP configs may contain credentials.
pub(super) struct ClaudePlugin {
    pub id: String,
    pub version: Option<String>,
    pub scope: String,
    pub project_path: Option<String>,
    pub install_path: Option<String>,
    pub enabled: Option<bool>,
    pub mcp_servers: Vec<ClaudeMcpServer>,
}

pub(super) struct ClaudeMcpServer {
    pub name: String,
    pub config: Value,
}

pub(super) fn parse_list(
    json: &str,
    workspace: Option<&Path>,
) -> Result<Vec<ClaudePlugin>, String> {
    // Do not include serde's error text: it can quote sensitive input tokens.
    let value: Value =
        serde_json::from_str(json).map_err(|_| "Invalid Claude plugin list JSON".to_owned())?;
    let rows = value
        .as_array()
        .ok_or_else(|| "Claude plugin list must be a JSON array".to_owned())?;
    let workspace = workspace.and_then(Path::to_str).and_then(normalize_path);
    let mut plugins = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let invalid = |field: &str| format!("Invalid Claude plugin row {index}: {field}");
        let row = row.as_object().ok_or_else(|| invalid("expected object"))?;
        let id = required_string(row, "id").ok_or_else(|| invalid("id"))?;
        let scope = required_string(row, "scope").ok_or_else(|| invalid("scope"))?;
        let version = optional_string(row, "version").map_err(|_| invalid("version"))?;
        let project_path =
            optional_string(row, "projectPath").map_err(|_| invalid("projectPath"))?;
        let install_path =
            optional_string(row, "installPath").map_err(|_| invalid("installPath"))?;
        let enabled = match row.get("enabled") {
            None | Some(Value::Null) => None,
            Some(Value::Bool(enabled)) => Some(*enabled),
            Some(_) => return Err(invalid("enabled")),
        };
        let mut mcp_servers = Vec::new();
        match row.get("mcpServers") {
            None => {}
            Some(Value::Object(servers)) => {
                for (name, config) in servers {
                    if name.trim().is_empty() || !config.is_object() {
                        return Err(invalid("mcpServers entry"));
                    }
                    mcp_servers.push(ClaudeMcpServer {
                        name: name.clone(),
                        config: config.clone(),
                    });
                }
            }
            Some(_) => return Err(invalid("mcpServers")),
        }
        if matches!(scope, "project" | "local") {
            let project = project_path.as_deref().and_then(normalize_path);
            if workspace.is_none() || project.is_none() || project != workspace {
                continue;
            }
        }
        plugins.push(ClaudePlugin {
            id: id.to_owned(),
            version,
            scope: scope.to_owned(),
            project_path,
            install_path,
            enabled,
            mcp_servers,
        });
    }
    Ok(plugins)
}

fn required_string<'a>(row: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    row.get(key)?.as_str().filter(|s| !s.trim().is_empty())
}

fn optional_string(row: &Map<String, Value>, key: &str) -> Result<Option<String>, ()> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(()),
    }
}

/// Lexical absolute-path comparison, without filesystem or current-dir access.
/// Windows drive/UNC paths accept either separator and compare ASCII case-insensitively.
/// POSIX paths stay case-sensitive. Symlinks and filesystem aliases are not resolved.
fn normalize_path(path: &str) -> Option<String> {
    if path.contains('\0') {
        return None;
    }
    let windows = path.starts_with("\\\\")
        || path.starts_with("//")
        || (path.as_bytes().get(1) == Some(&b':')
            && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic));
    let slashes = if windows {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    };
    let extended = slashes.strip_prefix("//?/");
    let path = extended.unwrap_or(&slashes);
    let unc = extended
        .and_then(|p| p.strip_prefix("UNC/"))
        .map(|p| format!("//{p}"));
    let path = unc.as_deref().unwrap_or(path);
    let drive = path.as_bytes().get(1) == Some(&b':')
        && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
    let (root, rest, windows) = if drive {
        if !path[2..].starts_with('/') {
            return None;
        }
        (path[..2].to_ascii_lowercase(), &path[3..], true)
    } else if let Some(rest) = path.strip_prefix("//") {
        let mut parts = rest.splitn(3, '/');
        let server = parts.next()?;
        let share = parts.next()?;
        if [server, share]
            .iter()
            .any(|s| s.is_empty() || *s == "." || *s == "..")
        {
            return None;
        }
        (
            format!("//{server}/{share}").to_ascii_lowercase(),
            parts.next().unwrap_or(""),
            true,
        )
    } else if path.starts_with('/') {
        (String::new(), &path[1..], false)
    } else {
        return None;
    };
    let mut parts = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    let normalized = format!("{root}/{}", parts.join("/"));
    Some(if windows {
        normalized.to_ascii_lowercase()
    } else {
        normalized
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scopes_duplicates_and_other_projects() {
        let rows = json!([
            {"id":"same@market","scope":"user","enabled":true},
            {"id":"same@market","scope":"managed","enabled":false},
            {"id":"same@market","scope":"project","projectPath":"g:/WORK/repo/./","enabled":true},
            {"id":"same@market","scope":"local","projectPath":"G:/work/other/../repo","enabled":false},
            {"id":"other","scope":"project","projectPath":"G:/work/repository","enabled":true},
            {"id":"missing","scope":"local","enabled":true},
            {"id":"relative","scope":"project","projectPath":"work/repo","enabled":true}
        ]);
        let plugins = parse_list(&rows.to_string(), Some(Path::new("G:\\work\\repo"))).unwrap();
        assert_eq!(plugins.len(), 4);
        assert!(plugins.iter().all(|p| p.id == "same@market"));
        assert_eq!(
            plugins.iter().map(|p| p.scope.as_str()).collect::<Vec<_>>(),
            ["user", "managed", "project", "local"]
        );
        assert_eq!(
            plugins.iter().map(|p| p.enabled).collect::<Vec<_>>(),
            [Some(true), Some(false), Some(true), Some(false)]
        );
        assert!(plugins[2].project_path.is_some());
        assert_eq!(parse_list(&rows.to_string(), None).unwrap().len(), 2);
    }

    #[test]
    fn disabled_and_missing_enabled_keep_mcp_declarations() {
        let rows = json!([
            {"id":"disabled","scope":"user","enabled":false,"version":"1","installPath":"C:/plugin",
             "mcpServers":{"server":{"command":"node","env":{"TOKEN":"test-secret"}}}},
            {"id":"unset","scope":"session","mcpServers":{"server":{"type":"http","url":"https://example.com"}}}
        ]);
        let plugins = parse_list(&rows.to_string(), None).unwrap();
        assert_eq!(plugins[0].enabled, Some(false));
        assert_eq!(plugins[1].enabled, None);
        assert!(plugins.iter().all(|p| p.mcp_servers.len() == 1));
        assert_eq!(plugins[0].version.as_deref(), Some("1"));
        assert_eq!(plugins[0].install_path.as_deref(), Some("C:/plugin"));
        assert_eq!(plugins[0].mcp_servers[0].name, "server");
        assert!(plugins[0].mcp_servers[0].config["env"]["TOKEN"].as_str() == Some("test-secret"));
        assert!(plugins[1].version.is_none());
    }

    #[test]
    fn rejects_malformed_output_without_echoing_values() {
        for input in [
            "",
            "not-json-secret",
            "{}",
            r#"{"installed":[]}"#,
            "[null]",
            r#"[{"id":"secret","scope":"user","enabled":"secret"}]"#,
            r#"[{"id":"secret","scope":"user","mcpServers":[]}]"#,
            r#"[{"id":"secret","scope":"user","mcpServers":{"x":"secret"}}]"#,
            r#"[{"id":"secret","scope":"user","projectPath":42}]"#,
            r#"[{"id":"secret"}]"#,
            r#"[{"id":"","scope":"user"}]"#,
        ] {
            let error = parse_list(input, None)
                .err()
                .expect("must reject malformed data");
            assert!(!error.contains("secret"));
        }
        assert!(parse_list("[]", None).unwrap().is_empty());
    }

    #[test]
    fn lexical_path_boundaries() {
        assert_eq!(
            normalize_path(r"\\?\C:\Work\repo\"),
            normalize_path("c:/work/repo")
        );
        assert_eq!(
            normalize_path(r"\\?\UNC\HOST\share\repo"),
            normalize_path("//host/share/repo/")
        );
        assert_eq!(
            normalize_path("/work/a/../repo"),
            normalize_path("/work/repo")
        );
        assert_ne!(normalize_path("/Work/repo"), normalize_path("/work/repo"));
        assert_ne!(normalize_path(r"/work/a\b"), normalize_path("/work/a/b"));
        for path in [
            "",
            ".",
            "C:repo",
            "C:/../repo",
            "//host",
            "/../repo",
            r"\work\repo",
            "UNC/host/share/repo",
        ] {
            assert!(normalize_path(path).is_none());
        }
    }
}
