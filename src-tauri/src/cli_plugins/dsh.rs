//! Static DSH_HOME declarations, never a composed tree or running-plugin list.
//! Sources: deepseek-ai/deepseek-harness packages/boot/app-boot/src/profile.ts
//! and vendor/include/src/index.ts. No CLI invocation: even config dump can
//! initialize/normalize profiles. Installation-anchor bundles and argv overlays
//! cannot be resolved from home alone. No MCP declarations are emitted here:
//! dsh-mcp-client instances already belong to mcp::sources.

use serde_json::Value as Json;
use serde_yaml::Value as Yaml;
use std::{
    collections::BTreeSet,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub(super) struct DshInventory {
    pub profiles: Vec<DshProfile>,
    /// Machine-local declarations, applied after the profile layer by DSh.
    pub home_instances: Vec<DshInstance>,
}

#[derive(Debug)]
pub(super) struct DshProfile {
    pub name: String,
    pub path: PathBuf,
    pub packages: Vec<DshPackage>,
    /// Ordered selection, not proof of installation, activation, or compatibility.
    pub bundles: Vec<String>,
    /// Only this profile's own patch; bundle patches are not composed here.
    pub instances: Vec<DshInstance>,
}

#[derive(Debug)]
pub(super) struct DshPackage {
    pub name: String,
    /// Keep all dependency sections, including conflicting version declarations.
    pub declarations: Vec<(String, String)>,
    pub selected: bool,
    /// A readable package.json in this profile's node_modules only. False does
    /// not mean uninstalled: DSh also resolves from its installation anchor.
    pub installed_locally: bool,
    pub local_version: Option<String>,
}

#[derive(Debug)]
pub(super) struct DshInstance {
    /// Source-relative structural location; duplicate IDs are not deduplicated.
    pub location: String,
    pub id: Option<String>,
    pub name: Option<String>,
    /// Explicit !disabled only, never inherited, composed, or runtime state.
    pub enabled: Option<bool>,
    /// True for a patch targeting an existing instance, false inside insert.
    pub is_override: bool,
    pub group: Option<bool>,
}

fn invalid(path: &Path, kind: &str) -> String {
    // Parser diagnostics can contain credentials/config values; omit them.
    format!("Cannot statically read DSh {kind}: {}", path.display())
}

fn optional_read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err(invalid(path, "file")),
    }
}

fn manifest(path: &Path, bytes: &[u8]) -> Result<Json, String> {
    let value: Json = serde_json::from_slice(bytes).map_err(|_| invalid(path, "package JSON"))?;
    // serde_json::Value uses last-key-wins. YAML's mapping visitor rejects
    // duplicate keys, including in nested JSON objects, before we use the value.
    serde_yaml::from_slice::<Yaml>(bytes)
        .map_err(|_| invalid(path, "duplicate or unsupported package keys"))?;
    if !value.is_object() {
        return Err(invalid(path, "package object"));
    }
    Ok(value)
}

fn package_name(name: &str) -> bool {
    let parts: Vec<_> = name.split('/').collect();
    let valid = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"@._-".contains(&c))
    };
    (parts.len() == 1 && !name.starts_with('@') && valid(name))
        || (parts.len() == 2
            && parts[0].starts_with('@')
            && parts[0].len() > 1
            && valid(parts[0])
            && valid(parts[1]))
}

/// Enumerate only directories actually present; no shipped-profile synthesis.
/// Missing home/profiles is empty; malformed or unreadable input is an error.
pub(super) fn read_plugins(home: &Path) -> Result<DshInventory, String> {
    let home_instances = read_instances(&home.join("cordis.patch.yml"))?;
    let directory = home.join("profiles");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Ok(DshInventory {
                profiles: vec![],
                home_instances,
            })
        }
        Err(_) => return Err(invalid(&directory, "profiles directory")),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| invalid(&directory, "profile directory entry"))?;
        if entry.file_name() == "node_modules" {
            continue;
        }
        let metadata =
            fs::metadata(entry.path()).map_err(|_| invalid(&entry.path(), "profile metadata"))?;
        if metadata.is_dir() {
            paths.push(entry.path());
        }
    }
    paths.sort();
    let profiles = paths
        .iter()
        .map(|path| read_profile(path))
        .collect::<Result<_, _>>()?;
    Ok(DshInventory {
        profiles,
        home_instances,
    })
}

fn read_profile(path: &Path) -> Result<DshProfile, String> {
    let source = path.join("package.json");
    let bytes =
        optional_read(&source)?.ok_or_else(|| invalid(&source, "missing profile manifest"))?;
    let root = manifest(&source, &bytes)?;
    let mut bundles = Vec::new();
    if let Some(dsh) = root.get("dsh") {
        if !dsh.is_object() {
            return Err(invalid(&source, "dsh object"));
        }
        if let Some(profile) = dsh.get("profile") {
            if !profile.is_object() {
                return Err(invalid(&source, "profile object"));
            }
            if let Some(values) = profile.get("bundles") {
                for value in values
                    .as_array()
                    .ok_or_else(|| invalid(&source, "bundles array"))?
                {
                    let name = value
                        .as_str()
                        .filter(|v| package_name(v))
                        .ok_or_else(|| invalid(&source, "bundle name"))?;
                    bundles.push(name.to_owned());
                }
            }
        }
    }
    let mut names: BTreeSet<String> = bundles.iter().cloned().collect();
    let sections = [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ];
    for section in sections {
        if let Some(deps) = root.get(section) {
            for (name, spec) in deps
                .as_object()
                .ok_or_else(|| invalid(&source, "dependency map"))?
            {
                if !package_name(name) || spec.as_str().is_none_or(|v| v.trim().is_empty()) {
                    return Err(invalid(&source, "dependency declaration"));
                }
                names.insert(name.clone());
            }
        }
    }
    let mut packages = Vec::new();
    for name in names {
        let local_path = path.join("node_modules").join(&name).join("package.json");
        let local = optional_read(&local_path)?
            .map(|bytes| manifest(&local_path, &bytes))
            .transpose()?;
        let local_version = match local.as_ref().and_then(|value| value.get("version")) {
            None => None,
            Some(value) => Some(
                value
                    .as_str()
                    .ok_or_else(|| invalid(&local_path, "package version"))?
                    .to_owned(),
            ),
        };
        let declarations = sections
            .iter()
            .filter_map(|section| {
                root.get(section)?
                    .get(&name)?
                    .as_str()
                    .map(|spec| (section.to_string(), spec.to_owned()))
            })
            .collect();
        packages.push(DshPackage {
            selected: bundles.contains(&name),
            name,
            declarations,
            installed_locally: local.is_some(),
            local_version,
        });
    }
    Ok(DshProfile {
        name: path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| invalid(path, "profile name"))?
            .to_owned(),
        path: path.to_owned(),
        packages,
        bundles,
        instances: read_instances(&path.join("cordis.patch.yml"))?,
    })
}

fn check_yaml(value: &Yaml, path: &Path, depth: usize) -> Result<(), String> {
    if depth > 64 {
        return Err(invalid(path, "YAML nesting limit"));
    }
    match value {
        Yaml::Tagged(_) => return Err(invalid(path, "dynamic or unsupported YAML tag")),
        Yaml::Mapping(map) => {
            for (key, value) in map {
                if key.as_str().is_none_or(|key| key == "<<") {
                    return Err(invalid(path, "unsupported YAML mapping key"));
                }
                check_yaml(value, path, depth + 1)?;
            }
        }
        Yaml::Sequence(values) => {
            for value in values {
                check_yaml(value, path, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn read_instances(path: &Path) -> Result<Vec<DshInstance>, String> {
    let Some(bytes) = optional_read(path)? else {
        return Ok(vec![]);
    };
    // serde_yaml silently discards unknown tags in the standard namespace
    // (notably DSh's !!js). Fail closed before parsing those spellings. This
    // conservative check can also reject a quoted/commented tag spelling;
    // reporting unsupported input is preferable to claiming a lossy inventory.
    if bytes.windows(2).any(|pair| pair == b"!!" || pair == b"!<") {
        return Err(invalid(path, "explicit YAML tag spelling"));
    }
    let root: Yaml = serde_yaml::from_slice(&bytes).map_err(|_| invalid(path, "patch YAML"))?;
    check_yaml(&root, path, 0)?;
    let mut instances = Vec::new();
    walk_instances(&root, path, "", true, &mut instances)?;
    Ok(instances)
}

fn walk_instances(
    value: &Yaml,
    path: &Path,
    location: &str,
    is_override: bool,
    out: &mut Vec<DshInstance>,
) -> Result<(), String> {
    for (index, row) in value
        .as_sequence()
        .ok_or_else(|| invalid(path, "patch array"))?
        .iter()
        .enumerate()
    {
        let map = row.as_mapping().ok_or_else(|| invalid(path, "patch row"))?;
        let get = |key: &str| map.get(Yaml::String(key.to_owned()));
        let text = |key: &str| -> Result<Option<String>, String> {
            get(key)
                .map(|v| {
                    v.as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .ok_or_else(|| invalid(path, "instance identity"))
                })
                .transpose()
        };
        let boolean = |key: &str| -> Result<Option<bool>, String> {
            match get(key) {
                None | Some(Yaml::Null) => Ok(None),
                Some(v) => v
                    .as_bool()
                    .map(Some)
                    .ok_or_else(|| invalid(path, "instance boolean")),
            }
        };
        let id = text("id")?;
        let name = text("name")?;
        let group = boolean("group")?;
        let enabled = boolean("disabled")?.map(|v| !v);
        let here = format!("{location}/{index}");
        if id.is_some() || name.is_some() || group == Some(true) {
            out.push(DshInstance {
                location: here.clone(),
                id,
                name,
                enabled,
                is_override,
                group,
            });
        } else if get("insert").is_none() {
            return Err(invalid(path, "unidentified patch row"));
        }
        if let Some(insert) = get("insert") {
            walk_instances(insert, path, &format!("{here}/insert"), false, out)?;
        }
        if group == Some(true) {
            if let Some(config) = get("config") {
                walk_instances(config, path, &format!("{here}/config"), false, out)?;
            }
        }
        // Older source readers traverse these as nested entry lists. Do not
        // silently omit them or interpret scalar selectors as plugin instances.
        for key in ["before", "after"] {
            if let Some(nested) = get(key) {
                walk_instances(nested, path, &format!("{here}/{key}"), false, out)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("ccgui-dsh-{}", uuid::Uuid::new_v4())))
        }
        fn write(&self, relative: &str, body: &str) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn absent_home_is_not_created() {
        let f = Fixture::new();
        assert!(read_plugins(&f.0).unwrap().profiles.is_empty());
        assert!(!f.0.exists());
    }

    #[test]
    fn separates_installation_selection_and_instance_declarations() {
        let f = Fixture::new();
        let package = r#"{"dependencies":{"plain":"^1","selected":"file:../plugin"},"dsh":{"profile":{"bundles":["selected","@deepseek-ai/dsh-base","selected"]}}}"#;
        f.write("profiles/custom/package.json", package);
        f.write(
            "profiles/custom/node_modules/plain/package.json",
            r#"{"version":"1.2.3"}"#,
        );
        f.write("profiles/custom/cordis.patch.yml", "- insert:\n  - id: mcp\n    name: '@deepseek-ai/dsh-mcp-client'\n    disabled: true\n    config:\n      name: not-a-plugin\n      token: SECRET\n- id: mcp\n  disabled: false\n");
        f.write("profiles/another/package.json", "{}");
        f.write("profiles/node_modules/ignored/package.json", "{}");
        f.write("cordis.patch.yml", "- id: mcp\n  disabled: true\n");
        let inventory = read_plugins(&f.0).unwrap();
        assert_eq!(inventory.profiles.len(), 2);
        let p = &inventory.profiles[1];
        assert_eq!(p.name, "custom");
        assert_eq!(p.path, f.0.join("profiles/custom"));
        assert_eq!(p.bundles.len(), 3);
        let plain = p.packages.iter().find(|p| p.name == "plain").unwrap();
        assert!(plain.installed_locally && !plain.selected);
        assert_eq!(plain.local_version.as_deref(), Some("1.2.3"));
        let selected = p.packages.iter().find(|p| p.name == "selected").unwrap();
        assert!(selected.selected && !selected.installed_locally);
        assert_eq!(selected.declarations[0].1, "file:../plugin");
        assert_eq!(p.instances.len(), 2);
        assert_eq!(
            p.instances[0].name.as_deref(),
            Some("@deepseek-ai/dsh-mcp-client")
        );
        assert_eq!(p.instances[0].enabled, Some(false));
        assert!(!p.instances[0].is_override);
        assert!(p.instances[1].is_override);
        assert_eq!(p.instances[1].id.as_deref(), Some("mcp"));
        assert_eq!(inventory.home_instances[0].enabled, Some(false));
        assert!(!format!("{inventory:?}").contains("SECRET"));
        assert_eq!(
            fs::read_to_string(f.0.join("profiles/custom/package.json")).unwrap(),
            package
        );
    }

    #[test]
    fn nested_groups_and_unknown_enabled_are_preserved() {
        let f = Fixture::new();
        f.write("profiles/web/package.json", "{}");
        f.write("profiles/web/cordis.patch.yml", "- insert:\n  - id: group\n    group: true\n    config:\n    - id: child\n      name: child\n      disabled: null\n");
        let result = read_plugins(&f.0).unwrap();
        let rows = &result.profiles[0].instances;
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].group, Some(true));
        assert_eq!(rows[1].location, "/0/insert/0/config/0");
        assert_eq!(rows[1].enabled, None);
    }

    #[test]
    fn malformed_package_data_is_never_an_empty_inventory() {
        let f = Fixture::new();
        for bad in [
            "[]",
            "{",
            r#"{"dependencies":{"x":false}}"#,
            r#"{"dsh":{"profile":{"bundles":null}}}"#,
            r#"{"dependencies":{"x":"1","x":"2"}}"#,
            r#"{"dependencies":{"../escape":"1"}}"#,
        ] {
            f.write("profiles/web/package.json", bad);
            assert!(read_plugins(&f.0).is_err(), "{bad}");
        }
        f.write("profiles/web/package.json", r#"{"dependencies":{"x":"1"}}"#);
        f.write("profiles/web/node_modules/x/package.json", "invalid");
        assert!(read_plugins(&f.0).is_err());
    }

    #[test]
    fn unsupported_yaml_fails_without_leaking_values() {
        let f = Fixture::new();
        for bad in [
            "",
            "{}",
            "- id: a\n  disabled: SECRET",
            "- id: a\n  id: b",
            "- insert: SECRET",
            "- name: a\n  config: !!js SECRET",
            "- name: a\n  config:\n    <<: {token: SECRET}",
            "- id: a\n---\n- id: b",
        ] {
            f.write("cordis.patch.yml", bad);
            let error = read_plugins(&f.0).unwrap_err();
            assert!(!error.contains("SECRET"));
        }
    }

    #[test]
    fn missing_manifest_and_io_errors_are_reported() {
        let f = Fixture::new();
        f.write("profiles/custom/cordis.patch.yml", "[]");
        assert!(read_plugins(&f.0).is_err());
        f.write("profiles/custom/package.json", "{}");
        fs::create_dir_all(f.0.join("cordis.patch.yml")).unwrap();
        assert!(read_plugins(&f.0).is_err());
    }
}
