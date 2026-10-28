use super::*;
use std::ffi::OsString;
#[path = "loopback_tests.rs"]
mod loopback_tests;

fn call<'a>(schema: &'a Value) -> StructuredCall<'a> {
    StructuredCall { system_prompt: "Only submit structured observer data.", input: r#"{"locale":"en","snapshot":{}}"#,
        json_schema: schema, model: "gemini-3.8-flash-high", provider_id: None, effort: "high", timeout: Duration::from_secs(10) }
}
fn scratch() -> PathBuf { std::env::temp_dir().join(format!("ccgui-agy-test-{}", uuid::Uuid::new_v4())) }

#[test]
fn only_supported_agent_versions_are_accepted() {
    for version in ["1.3.4", "v1.4.7\n", "Antigravity CLI 1.4.9"] { assert!(version_result(version.as_bytes()).is_ok()); }
    for version in ["", "unknown", "1.2.11", "1.3.3", "1.3.4-rc1", "0.99.9"] { assert!(version_result(version.as_bytes()).is_err()); }
}

#[test]
fn stage_imports_no_user_customizations_and_commands_keep_model_and_homes_private() {
    let root = scratch(); std::fs::create_dir(&root).unwrap();
    let schema = json!({"type":"object"});
    let settings: NativeSettings = serde_json::from_value(json!({"modelProvider":"gemini", "apiKey":"private-fixture", "hooks":{"startup":"forbidden"},"mcpServers":{"bad":{}},"plugins":["bad"],"env":{"private":"value"}})).unwrap();
    let (home, cwd) = stage(&root, &call(&schema), &settings).unwrap();
    let config: Value = serde_json::from_slice(&std::fs::read(home.join(".gemini/antigravity-cli/settings.json")).unwrap()).unwrap();
    assert_eq!(config, json!({"modelProvider":"gemini"}));
    let agent = std::fs::read_to_string(home.join(".gemini/config/agents/ccgui-notice.md")).unwrap();
    assert!(agent.contains("tools: [finish]"));
    for control in ["excludeDefaultComponents: true", "inheritCustomizations: false", "inheritMcp: false", "commandExecutionPolicy: \"off\""] { assert!(agent.contains(control)); }
    assert!(!agent.contains("private-fixture"));
    let context = Context { bin: "agy".into(), env: HashMap::new(), settings };
    let command = request_command(&context, &home, &call(&schema));
    let args = command.as_std().get_args().map(|arg| arg.to_string_lossy().to_string()).collect::<Vec<_>>();
    assert!(args.windows(2).any(|pair| pair == ["--agent", AGENT]));
    assert!(args.windows(2).any(|pair| pair == ["--model", "gemini-3.8-flash-high"]));
    assert!(args.windows(2).any(|pair| pair == ["--print-timeout", "0"]));
    for forbidden in ["--conversation", "--continue", "--add-dir", "--dangerously-skip-permissions", "--effort"] { assert!(!args.iter().any(|arg| arg == forbidden)); }
    let env = command.as_std().get_envs().map(|(key,value)| (key.to_string_lossy().to_string(),value.map(OsString::from))).collect::<HashMap<_,_>>();
    for key in ["HOME", "USERPROFILE"] { assert_eq!(env[key], Some(home.clone().into_os_string())); }
    for key in ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "ANTIGRAVITY_GEMINI_DIR", "ANTIGRAVITY_HOME", "TMP", "TEMP"] {
        assert!(Path::new(env[key].as_ref().unwrap()).starts_with(&home), "{key}");
    }
    assert_eq!(env["ANTIGRAVITY_APP_DATA_DIR"], None);
    assert_eq!(env["AGY_CLI_DISABLE_AUTO_UPDATE"], Some("true".into()));
    assert!(cwd.starts_with(&root));
    assert!(crate::engine::agy::session_homes().iter().all(|path| !home.starts_with(path)));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn result_requires_the_restricted_agent_and_complete_structured_terminal_output() {
    let init = json!({"event":"init","init":{"agent":AGENT}});
    let result = json!({"event":"result","result":{"status":"SUCCESS","structured_output":{"thought":null},"usage":{"input_tokens":10}}});
    let stream = |events: Vec<Value>| events.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    let output = parse_result(stream(vec![init.clone(), result.clone()]).as_bytes()).unwrap();
    assert_eq!(output.structured, json!({"thought":null}));
    for events in [vec![result.clone()], vec![init.clone()], vec![json!({"event":"init","init":{"agent":"default"}}),result.clone()], vec![init.clone(),result.clone(),result.clone()],vec![init.clone(),json!({"event":"result","result":{"status":"SUCCESS","response":"partial"}})],vec![init,json!({"event":"result","result":{"status":"ERROR","error":"private error"}})]] {
        assert!(parse_result(stream(events).as_bytes()).is_err());
    }
}

#[test]
fn explicit_gemini_channel_cannot_restore_conflicting_auth_or_escape_private_homes() {
    let home = scratch();
    let context = Context { bin:"agy".into(), settings:NativeSettings { model_provider:Some("gemini".into()) },
        env:HashMap::from([("AGY_ADC_AUTH".into(),"true".into()),("GOOGLE_APPLICATION_CREDENTIALS".into(),"wrong-auth.json".into()),("GOOGLE_GENAI_USE_VERTEXAI".into(),"true".into()),("USERPROFILE".into(),"wrong-home".into()),("AGY_CLI_DISABLE_AUTO_UPDATE".into(),"false".into())]) };
    let command = command(&context, &home);
    let env = command.as_std().get_envs().map(|(key,value)| (key.to_string_lossy().to_string(),value.map(OsString::from))).collect::<HashMap<_,_>>();
    for key in ["AGY_ADC_AUTH", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI"] { assert_eq!(env[key],None); }
    assert_eq!(env["USERPROFILE"],Some(home.into_os_string()));
    assert_eq!(env["AGY_CLI_DISABLE_AUTO_UPDATE"],Some("true".into()));
}

#[cfg(windows)]
#[tokio::test]
async fn private_cleanup_retries_until_windows_releases_native_file_handles() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = scratch(); std::fs::create_dir(&root).unwrap();
    let path = root.join("history.db"); std::fs::write(&path,"synthetic snapshot").unwrap();
    let handle = std::fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
    drop(PrivateStaging(root.clone()));
    assert!(root.exists());
    tokio::time::sleep(Duration::from_millis(250)).await;
    drop(handle);
    tokio::time::timeout(Duration::from_secs(3),async { while root.exists() { tokio::time::sleep(Duration::from_millis(30)).await; } }).await.unwrap();
}

#[tokio::test]
async fn failed_cli_start_removes_its_private_home_without_a_session_registration() {
    let root = scratch();
    let schema = json!({"type":"object"});
    let context = Context { bin:format!("ccgui-absent-agy-{}",uuid::Uuid::new_v4()),env:HashMap::new(),settings:NativeSettings::default() };
    assert!(execute_in(context,call(&schema),&root).await.is_err());
    assert!(!root.exists());
}
