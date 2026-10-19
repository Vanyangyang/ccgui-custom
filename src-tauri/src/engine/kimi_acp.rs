use serde_json::{json, Map, Value};
use std::sync::atomic::AtomicBool;

use super::qoder_session::{
    initialize_params, jsonrpc_id_key, jsonrpc_result_response, AcpProcess, RPC_HANDSHAKE_TIMEOUT,
    SESSION_NEW_TIMEOUT, SESSION_RESUME_TIMEOUT,
};
use super::{Engine, EngineEvent, SendRequest, TurnCore, TurnState};

pub(super) fn selected_model(
    model: Option<&str>,
    command: &tokio::process::Command,
) -> Option<String> {
    if command
        .as_std()
        .get_envs()
        .any(|(key, value)| key == "KIMI_MODEL_API_KEY" && value.is_some())
    {
        Some("__kimi_env_model__".into())
    } else {
        model.map(str::to_string)
    }
}

pub(super) fn initialization() -> Value {
    let mut params = initialize_params();
    params["clientCapabilities"]["elicitation"] = json!({ "form": {} });
    params
}

async fn existing_additional_dirs(dirs: &[String]) -> Result<Vec<&str>, String> {
    let mut existing = Vec::new();
    for dir in dirs {
        match tokio::fs::metadata(dir).await {
            Ok(metadata) if metadata.is_dir() => existing.push(dir.as_str()),
            Ok(_) => eprintln!("[kimi] skipping a granted root that is no longer a directory"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                eprintln!("[kimi] skipping a granted root that no longer exists");
            }
            Err(error) => {
                return Err(format!("Kimi additional directory {dir:?}: {error}"));
            }
        }
    }
    Ok(existing)
}

pub(super) async fn attach_session(
    acp: &mut AcpProcess,
    req: &SendRequest,
    killed: &AtomicBool,
) -> Result<(String, Option<String>), String> {
    let mut params = json!({
        "cwd": req.workspace.to_string_lossy(), "mcpServers": [],
    });
    let (session_id, mut config) = if let Some(session_id) = &req.session_id {
        let mut params = params;
        params["sessionId"] = json!(session_id);
        let result = acp
            .routed(
                "session/load",
                params,
                SESSION_RESUME_TIMEOUT,
                killed,
                None,
                &mut |_| None,
            )
            .await?;
        (session_id.clone(), result)
    } else {
        params["additionalDirectories"] =
            json!(existing_additional_dirs(&req.additional_dirs).await?);
        let result = acp
            .routed(
                "session/new",
                params,
                SESSION_NEW_TIMEOUT,
                killed,
                None,
                &mut |_| None,
            )
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or("Kimi session handshake returned no sessionId")?
            .to_string();
        (session_id, result)
    };
    if let Some(model) = req.model.as_deref() {
        config = acp
            .routed(
                "session/set_config_option",
                json!({"sessionId": session_id, "configId": "model", "value": model}),
                RPC_HANDSHAKE_TIMEOUT,
                killed,
                None,
                &mut |_| None,
            )
            .await?;
    }
    let mut actual_effort = None;
    if let Some(effort) = req.effort.as_deref() {
        let effort = supported_effort(effort, &config);
        acp.routed(
            "session/set_config_option",
            json!({"sessionId": session_id, "configId": "thinking", "value": effort}),
            RPC_HANDSHAKE_TIMEOUT,
            killed,
            None,
            &mut |_| None,
        )
        .await?;
        actual_effort = Some(effort.to_string());
    }
    acp.routed(
        "session/set_mode",
        json!({"sessionId": session_id, "modeId": mode(req.permission.as_deref())}),
        RPC_HANDSHAKE_TIMEOUT,
        killed,
        None,
        &mut |_| None,
    )
    .await?;
    Ok((session_id, actual_effort))
}

fn mode(permission: Option<&str>) -> &'static str {
    match super::kimi::KimiEngine.resolve_permission(permission) {
        "plan" => "plan",
        _ => "yolo",
    }
}

fn supported_effort<'a>(requested: &'a str, config: &'a Value) -> &'a str {
    let options = config["configOptions"]
        .as_array()
        .and_then(|options| options.iter().find(|option| option["id"] == "thinking"))
        .and_then(|option| option["options"].as_array());
    let Some(options) = options else {
        return requested;
    };
    let accepts = |value: &str| options.iter().any(|option| option["value"] == value);
    let boolean = options
        .iter()
        .find(|option| option["value"] != "off")
        .is_some_and(|option| option["value"] == "on");
    if boolean && !matches!(requested, "off" | "none") {
        "on"
    } else if accepts(requested) {
        requested
    } else if requested == "none" && accepts("off") {
        "off"
    } else if !matches!(requested, "off" | "none") && accepts("on") {
        "on"
    } else {
        let levels = [
            "off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ];
        let rank = |value: &str| levels.iter().position(|level| *level == value);
        options
            .iter()
            .filter_map(|option| option["value"].as_str())
            .filter(|value| rank(value).is_some())
            .min_by_key(|value| rank(value).unwrap().abs_diff(rank(requested).unwrap_or(4)))
            .or_else(|| options.iter().find_map(|option| option["value"].as_str()))
            .unwrap_or(requested)
    }
}

fn fields(params: &Value) -> Result<Vec<Value>, String> {
    if params.get("mode").and_then(Value::as_str) != Some("form") {
        return Err("Unsupported Kimi elicitation mode".into());
    }
    let schema = &params["requestedSchema"];
    let properties = schema["properties"]
        .as_object()
        .ok_or("Kimi form has no properties")?;
    let required = schema["required"]
        .as_array()
        .ok_or("Kimi form has no field order")?;
    let prompts: Vec<_> = params["message"]
        .as_str()
        .unwrap_or_default()
        .lines()
        .collect();
    required
        .iter()
        .enumerate()
        .map(|(index, key)| {
            let key = key.as_str().ok_or("Invalid Kimi field id")?;
            let field = properties.get(key).ok_or("Missing Kimi field")?;
            let multi = field["type"] == "array";
            let choices = if multi {
                &field["items"]["anyOf"]
            } else {
                &field["oneOf"]
            };
            let choices = choices
                .as_array()
                .filter(|items| !items.is_empty())
                .ok_or("Unsupported Kimi choices")?;
            let options = choices
                .iter()
                .map(|choice| {
                    let label = choice["const"].as_str().ok_or("Invalid Kimi choice")?;
                    Ok(json!({ "label": label, "description": choice["description"] }))
                })
                .collect::<Result<Vec<Value>, String>>()?;
            let header = field["title"].as_str().unwrap_or(key);
            let question = if prompts.len() == required.len() {
                prompts[index].to_string()
            } else {
                format!("Q{} · {}", index + 1, header)
            };
            Ok(json!({
                "key": key, "question": question, "header": header,
                "multiSelect": multi, "allowOther": false, "options": options,
            }))
        })
        .collect()
}

pub(super) fn park_question(
    core: &TurnCore,
    state: &mut TurnState,
    id: &Value,
    params: &Value,
) -> Option<Value> {
    let questions = match fields(params) {
        Ok(questions) if !questions.is_empty() => questions,
        _ => return Some(jsonrpc_result_response(id, json!({ "action": "decline" }))),
    };
    core.dispatch_event(
        state,
        EngineEvent::Question {
            request_id: jsonrpc_id_key(id).unwrap_or_else(|| id.to_string()),
            tool_use_id: params["toolCallId"].as_str().map(str::to_string),
            input: json!({"questions": questions, "kimiAcp": {"rpcId": id, "fields": questions}}),
        },
    );
    None
}

pub(super) fn answer_frame(context: &Value, answers: Option<&Value>) -> Result<Value, String> {
    let id = context
        .get("rpcId")
        .filter(|id| id.is_string() || id.is_number())
        .ok_or("Missing Kimi request id")?;
    let Some(answers) = answers else {
        return Ok(jsonrpc_result_response(id, json!({ "action": "cancel" })));
    };
    let answers = answers
        .as_object()
        .ok_or("Kimi answers must be an object")?;
    let fields = context["fields"]
        .as_array()
        .ok_or("Missing Kimi question fields")?;
    let mut content = Map::new();
    for field in fields {
        let key = field["key"].as_str().ok_or("Missing Kimi field id")?;
        let question = field["question"].as_str().ok_or("Missing Kimi question")?;
        let answer = answers
            .get(question)
            .ok_or("Answer every Kimi question before submitting")?;
        let options = field["options"].as_array().ok_or("Missing Kimi choices")?;
        let valid = |value: &Value| {
            value.is_string()
                && options
                    .iter()
                    .any(|option| option.get("label") == Some(value))
        };
        let accepted = if field["multiSelect"] == true {
            answer
                .as_array()
                .is_some_and(|values| !values.is_empty() && values.iter().all(valid))
        } else {
            valid(answer)
        };
        if !accepted {
            return Err("Kimi only accepts the declared choices for this question".into());
        }
        content.insert(key.into(), answer.clone());
    }
    Ok(jsonrpc_result_response(
        id,
        json!({"action": "accept", "content": content}),
    ))
}

pub(super) fn usage(params: &Value) -> Option<Value> {
    let update = &params["update"];
    if update["sessionUpdate"] != "usage_update" {
        return None;
    }
    Some(
        json!({"input_tokens": update["used"].as_u64()?, "model_context_window": update["size"].as_u64()?}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn additional_dirs_keep_valid_roots_without_mutating_grants() {
        let home = std::env::temp_dir().join(format!("kimi-grants-{}", uuid::Uuid::new_v4()));
        let valid = home.join("有效目录 with spaces");
        let missing = home.join("missing");
        let file = home.join("file");
        std::fs::create_dir_all(&valid).unwrap();
        std::fs::write(&file, "file").unwrap();
        let dirs: Vec<String> = [&missing, &valid, &file]
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let original = dirs.clone();
        assert_eq!(
            existing_additional_dirs(&dirs).await.unwrap(),
            vec![dirs[1].as_str()]
        );
        assert_eq!(dirs, original);
        assert!(existing_additional_dirs(&[]).await.unwrap().is_empty());
        assert!(
            existing_additional_dirs(&[dirs[0].clone(), dirs[2].clone()])
                .await
                .unwrap()
                .is_empty()
        );
        std::fs::create_dir(&missing).unwrap();
        assert_eq!(
            existing_additional_dirs(&dirs).await.unwrap(),
            vec![dirs[0].as_str(), dirs[1].as_str()]
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn additional_dirs_follow_directory_links_but_report_other_io_errors() {
        let home = std::env::temp_dir().join(format!("kimi-grant-links-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        let valid = home.join("valid-link");
        let broken = home.join("broken-link");
        let cyclic = home.join("cyclic-link");
        std::os::unix::fs::symlink(&home, &valid).unwrap();
        std::os::unix::fs::symlink(home.join("missing"), &broken).unwrap();
        std::os::unix::fs::symlink(&cyclic, &cyclic).unwrap();
        let dirs = vec![
            valid.to_string_lossy().into_owned(),
            broken.to_string_lossy().into_owned(),
        ];
        assert_eq!(
            existing_additional_dirs(&dirs).await.unwrap(),
            vec![dirs[0].as_str()]
        );
        let error = existing_additional_dirs(&[cyclic.to_string_lossy().into_owned()])
            .await
            .unwrap_err();
        assert!(error.contains("Kimi additional directory"), "{error}");
        std::fs::remove_dir_all(home).unwrap();
    }

    fn request() -> Value {
        json!({"mode": "form", "message": "任务？\n语言？\n继续？", "requestedSchema": {
            "type": "object", "required": ["q0", "q1", "q2"], "properties": {
                "q0": {"type": "string", "title": "任务", "oneOf": [{"const":"修复", "description":"修复错误"}, {"const":"功能"}]},
                "q1": {"type": "array", "title": "语言", "items": {"anyOf": [{"const":"中文"}, {"const":"English"}]}},
                "q2": {"type": "string", "title": "继续", "oneOf": [{"const":"是"}, {"const":"否"}]}
            }
        }})
    }

    #[test]
    fn three_questions_round_trip_without_losing_multiselect_or_order() {
        let questions = fields(&request()).unwrap();
        assert_eq!(questions.len(), 3);
        assert_eq!(questions[0]["question"], "任务？");
        assert_eq!(questions[1]["multiSelect"], true);
        assert_eq!(questions[2]["allowOther"], false);
        for id in [json!(7), json!("rpc-7")] {
            let context = json!({"rpcId": id, "fields": questions});
            let answers = json!({"任务？": "修复", "语言？": ["中文", "English"], "继续？": "是"});
            assert_eq!(
                answer_frame(&context, Some(&answers)).unwrap(),
                json!({
                    "jsonrpc": "2.0", "id": id, "result": {"action": "accept", "content": {
                        "q0": "修复", "q1": ["中文", "English"], "q2": "是"
                    }}
                })
            );
            assert_eq!(
                answer_frame(&context, None).unwrap()["result"]["action"],
                "cancel"
            );
            assert!(answer_frame(&context, Some(&json!({}))).is_err());
            let mut invalid = answers.clone();
            invalid["任务？"] = json!("free text");
            assert!(answer_frame(&context, Some(&invalid)).is_err());
            invalid = answers.clone();
            invalid["语言？"] = json!([]);
            assert!(answer_frame(&context, Some(&invalid)).is_err());
        }
        assert!(fields(&json!({"mode": "url"})).is_err());
    }

    #[test]
    fn auto_keeps_questions_enabled_and_advertises_forms() {
        assert_eq!(mode(Some("auto")), "yolo");
        assert_eq!(mode(Some("plan")), "plan");
        assert_eq!(mode(Some("bypass")), "yolo");
        assert_eq!(
            initialization()["clientCapabilities"]["elicitation"],
            json!({"form": {}})
        );
    }

    #[test]
    fn channel_model_depends_on_resolved_environment_not_optional_provider_id() {
        let mut command = tokio::process::Command::new("kimi");
        assert_eq!(
            selected_model(Some("native-alias"), &command).as_deref(),
            Some("native-alias")
        );
        assert_eq!(selected_model(None, &command), None);
        command.env("KIMI_MODEL_API_KEY", "test-key");
        assert_eq!(
            selected_model(Some("channel-model"), &command).as_deref(),
            Some("__kimi_env_model__")
        );
        assert_eq!(
            selected_model(None, &command).as_deref(),
            Some("__kimi_env_model__")
        );
    }

    #[test]
    fn boolean_thinking_models_accept_effort_without_rejecting_the_turn() {
        let config = json!({"configOptions": [{"id": "thinking", "options": [{"value":"off"}, {"value":"on"}]}]});
        assert_eq!(supported_effort("medium", &config), "on");
        assert_eq!(supported_effort("high", &config), "on");
        assert_eq!(supported_effort("none", &config), "off");
        assert_eq!(supported_effort("off", &config), "off");
        let config = json!({"configOptions": [{"id": "thinking", "currentValue": "medium", "options": [{"value":"off"}, {"value":"on"}, {"value":"medium"}]}]});
        assert_eq!(supported_effort("medium", &config), "on");
        let config = json!({"configOptions": [{"id": "thinking", "options": [{"value":"medium"}, {"value":"high"}]}]});
        assert_eq!(supported_effort("high", &config), "high");
        assert_eq!(supported_effort("ultra", &config), "high");
        assert_eq!(supported_effort("low", &config), "medium");
        assert_eq!(supported_effort("off", &config), "medium");
    }

    #[test]
    fn multiline_prompts_do_not_shift_questions_and_answer_fields() {
        let mut params = request();
        params["message"] = json!("任务？\n请选择一项\n语言？\n继续？");
        params["requestedSchema"]["properties"]["q1"]["title"] = json!("任务");
        let questions = fields(&params).unwrap();
        assert_eq!(questions[0]["question"], "Q1 · 任务");
        assert_eq!(questions[1]["question"], "Q2 · 任务");
        assert_eq!(questions[2]["question"], "Q3 · 继续");
        let context = json!({"rpcId": 1, "fields": questions});
        let response = answer_frame(
            &context,
            Some(&json!({"Q1 · 任务":"修复", "Q2 · 任务":["中文"], "Q3 · 继续":"否"})),
        )
        .unwrap();
        assert_eq!(
            response["result"]["content"],
            json!({"q0":"修复", "q1":["中文"], "q2":"否"})
        );
    }

    #[test]
    fn usage_preserves_context_occupancy_and_window() {
        assert_eq!(
            usage(
                &json!({"update": {"sessionUpdate": "usage_update", "used": 29000, "size": 262144}})
            ),
            Some(json!({"input_tokens": 29000, "model_context_window": 262144}))
        );
        assert!(usage(&json!({"update": {"sessionUpdate": "agent_message_chunk"}})).is_none());
    }
}
