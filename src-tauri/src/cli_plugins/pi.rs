//! Read-only Pi package declarations, not installation or runtime activation proof.
//! No package paths, extension code, or MCP processes are inspected or executed.
//! Pi extensions may create MCP integrations dynamically; no static MCP contract
//! has been verified, so callers must report that capability as unknown.

use serde::Deserialize;
use std::{fs, io::ErrorKind, path::Path};

pub(super) struct PiPlugin {
    /// Exact configured source, including version/ref and relative path spelling.
    pub id: String,
    pub scope: String,
    pub enabled: Option<bool>,
    pub resources: PiResourceFilters,
}

/// None means the package's allowed resources; Some([]) means none of that type.
/// Preserve !glob, +path and -path verbatim; never evaluate filters here.
#[derive(Default, Deserialize, Debug, PartialEq)]
pub(super) struct PiResourceFilters {
    pub extensions: Option<Vec<String>>,
    pub skills: Option<Vec<String>>,
    pub prompts: Option<Vec<String>>,
    pub themes: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct Settings {
    // Unknown settings (including credentials) are ignored, never retained.
    #[serde(default)]
    packages: Vec<Package>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Package {
    Source(String),
    Filtered {
        source: String,
        #[serde(flatten)]
        resources: PiResourceFilters,
    },
}

/// Keep both scopes: Pi's trust, project override and autoload rules decide
/// effective loading later. Never deduplicate or resolve sources in inventory.
/// Missing files are empty; IO, syntax and declaration errors are sanitized.
pub(super) fn read_plugins(
    user_settings: &Path,
    workspace: Option<&Path>,
) -> Result<Vec<PiPlugin>, String> {
    let mut plugins = read_scope(user_settings, "user")?;
    if let Some(workspace) = workspace {
        plugins.extend(read_scope(&workspace.join(".pi/settings.json"), "project")?);
    }
    Ok(plugins)
}

fn read_scope(path: &Path, scope: &str) -> Result<Vec<PiPlugin>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(format!("Cannot read Pi {scope} settings")),
    };
    // Serde's derived struct visitor also accepts positional arrays; settings
    // must be a JSON object. Only JSON whitespace can precede its opening brace.
    if bytes
        .iter()
        .find(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        != Some(&b'{')
    {
        return Err(format!(
            "Invalid Pi {scope} settings JSON or packages declaration"
        ));
    }
    let settings: Settings = serde_json::from_slice(&bytes)
        .map_err(|_| format!("Invalid Pi {scope} settings JSON or packages declaration"))?;
    settings
        .packages
        .into_iter()
        .enumerate()
        .map(|(index, package)| {
            let (id, resources) = match package {
                Package::Source(source) => (source, PiResourceFilters::default()),
                Package::Filtered { source, resources } => (source, resources),
            };
            if id.trim().is_empty() {
                return Err(format!(
                    "Invalid Pi {scope} package source at index {index}"
                ));
            }
            Ok(PiPlugin {
                id,
                scope: scope.to_owned(),
                // A declaration, even with empty filters, does not establish runtime
                // state (trust, autoload, other resources and CLI flags also apply).
                enabled: None,
                resources,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("ccgui-pi-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("workspace/.pi")).unwrap();
            Self(root)
        }

        fn user(&self) -> PathBuf {
            self.0.join("settings.json")
        }
        fn workspace(&self) -> PathBuf {
            self.0.join("workspace")
        }
        fn project(&self) -> PathBuf {
            self.workspace().join(".pi/settings.json")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn retains_sources_and_both_scopes_without_claiming_activation() {
        let f = Fixture::new();
        fs::write(
            f.user(),
            r#"{"packages":["npm:@example/tools@1.0.0","./relative"]}"#,
        )
        .unwrap();
        fs::write(f.project(), r#"{"autoload":false,"packages":["npm:@example/tools@1.0.0","git:github.com/example/tools@v1"]}"#).unwrap();
        let rows = read_plugins(&f.user(), Some(&f.workspace())).unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| (r.id.as_str(), r.scope.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("npm:@example/tools@1.0.0", "user"),
                ("./relative", "user"),
                ("npm:@example/tools@1.0.0", "project"),
                ("git:github.com/example/tools@v1", "project"),
            ]
        );
        assert!(rows.iter().all(|r| r.enabled.is_none()));
        assert_eq!(rows[0].resources, PiResourceFilters::default());
    }

    #[test]
    fn preserves_object_resource_filters_exactly() {
        let f = Fixture::new();
        fs::write(f.user(), r#"{"packages":[{"source":"../tools","extensions":["extensions/*.ts","!extensions/legacy.ts","+one.ts","-two.ts"],"skills":[],"prompts":["prompts/review.md"]}]}"#).unwrap();
        let rows = read_plugins(&f.user(), None).unwrap();
        assert_eq!(rows[0].id, "../tools");
        assert_eq!(
            rows[0].resources.extensions.as_ref().unwrap(),
            &vec![
                "extensions/*.ts",
                "!extensions/legacy.ts",
                "+one.ts",
                "-two.ts"
            ]
        );
        assert_eq!(rows[0].resources.skills, Some(vec![]));
        assert_eq!(
            rows[0].resources.prompts,
            Some(vec!["prompts/review.md".into()])
        );
        assert_eq!(rows[0].resources.themes, None);
        assert_eq!(rows[0].enabled, None);
    }

    #[test]
    fn missing_files_and_missing_packages_are_empty() {
        let f = Fixture::new();
        assert!(read_plugins(&f.user(), Some(&f.workspace()))
            .unwrap()
            .is_empty());
        fs::write(f.user(), r#"{"unrelated":{"secret":"not-retained"}}"#).unwrap();
        assert!(read_plugins(&f.user(), None).unwrap().is_empty());
    }

    #[test]
    fn no_workspace_does_not_read_project_settings() {
        let f = Fixture::new();
        fs::write(f.project(), "broken-private-project-value").unwrap();
        assert!(read_plugins(&f.user(), None).unwrap().is_empty());
        let error = read_plugins(&f.user(), Some(&f.workspace())).err().unwrap();
        assert!(error.contains("project"));
        assert!(!error.contains("private"));
    }

    #[test]
    fn malformed_json_and_package_shapes_return_sanitized_errors() {
        let f = Fixture::new();
        for content in [
            "{private-value",
            "[]",
            r#"{"packages":null}"#,
            r#"{"packages":[{"source":"private-value","skills":42}]}"#,
            r#"{"packages":[{"skills":[]}]}"#,
            r#"{"packages":[" "]}"#,
        ] {
            fs::write(f.user(), content).unwrap();
            let error = read_plugins(&f.user(), None).err().unwrap();
            assert!(error.contains("user"));
            assert!(!error.contains("private-value"));
        }
    }

    #[test]
    fn unreadable_settings_are_not_treated_as_missing() {
        let f = Fixture::new();
        fs::create_dir(f.user()).unwrap();
        assert!(read_plugins(&f.user(), None).is_err());
    }
}
