//! Pi's print transport with no session, tools or external resources.
use super::{SideCallError, SideCallOutput, StructuredCall};
use serde_json::Value;
use tokio::time::Instant;

pub(super) async fn structured(call: StructuredCall<'_>) -> Result<SideCallOutput, SideCallError> {
    // Include discovery in the naming budget. Dropping either subprocess
    // future invokes the shared runner's process-tree guard.
    tokio::time::timeout(call.timeout, structured_inner(call))
        .await
        .map_err(|_| SideCallError::Timeout)?
}

async fn structured_inner(call: StructuredCall<'_>) -> Result<SideCallOutput, SideCallError> {
    let deadline = Instant::now() + call.timeout;
    let context =
        crate::engine::models::PiNamingContext::load_for(call.provider_id).map_err(|_| SideCallError::Unavailable)?;
    let cwd =
        crate::engine::models::pi_naming_directory().map_err(|_| SideCallError::Unavailable)?;
    let _cleanup = super::StagedFiles(vec![cwd.clone()]);
    let catalog =
        crate::engine::models::pi_naming_catalog_for(&context, &cwd, remaining(deadline)?).await?;
    let chosen = if call.model.is_empty() {
        catalog.first()
    } else {
        catalog.iter().find(|(model, _)| model.id == call.model)
    }
    .ok_or(SideCallError::Unavailable)?;
    let command = isolated_command(&context.bin, &call, &chosen.0.id, chosen.1, &context.env)?;
    let input = format!(
        "{}\n\nReturn only one JSON object matching this schema:\n{}",
        call.input, call.json_schema,
    );
    super::run_with_parser(
        "pi",
        command,
        &cwd,
        &input,
        remaining(deadline)?,
        parse_result,
    )
    .await
}

fn remaining(deadline: Instant) -> Result<std::time::Duration, SideCallError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or(SideCallError::Timeout)
}

fn isolated_command(
    bin: &str,
    call: &StructuredCall<'_>,
    model: &str,
    supports_effort: bool,
    env: &std::collections::HashMap<String, String>,
) -> Result<tokio::process::Command, SideCallError> {
    let effort = call.effort.trim();
    if !matches!(
        effort,
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    ) {
        return Err(SideCallError::Unavailable);
    }
    let mut command = crate::engine::command_for_binary(bin);
    command.args([
        "--print",
        "--mode",
        "json",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
        "--no-approve",
        "--offline",
        "--system-prompt",
        call.system_prompt,
        "--model",
        model,
    ]);
    // Override the CLI's default even for non-reasoning models. Pi clamps
    // valid levels to each model's supported levels; ultra is not a CLI level.
    command
        .arg("--thinking")
        .arg(if supports_effort { effort } else { "off" });
    command.envs(env);
    Ok(command)
}

fn parse_result(stdout: &[u8]) -> Result<SideCallOutput, SideCallError> {
    let text = std::str::from_utf8(stdout).map_err(|_| SideCallError::BadOutput)?;
    let mut final_message = None;
    let mut terminal_message = None;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let event: Value = serde_json::from_str(line).map_err(|_| SideCallError::BadOutput)?;
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or(SideCallError::BadOutput)?;
        if matches!(kind, "agent_start" | "turn_start") {
            terminal_message = None;
        }
        if kind.starts_with("tool_") || kind == "error" {
            return Err(SideCallError::Failed);
        }
        if let Some(update) = event.get("assistantMessageEvent") {
            if update
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.starts_with("toolcall_") || kind == "error")
            {
                return Err(SideCallError::Failed);
            }
        }
        if let Some(message) = event.get("message") {
            reject_failed_or_tool_message(message)?;
            if message.get("role").and_then(Value::as_str) == Some("assistant") {
                if kind == "message_end" {
                    final_message = Some(message.clone());
                    terminal_message = None;
                }
            }
        }
        if kind == "agent_end" {
            if event.get("willRetry") == Some(&Value::Bool(true))
                || event.get("isTerminal") == Some(&Value::Bool(false))
            {
                return Err(SideCallError::BadOutput);
            }
            let messages = event
                .get("messages")
                .and_then(Value::as_array)
                .ok_or(SideCallError::BadOutput)?;
            for message in messages {
                reject_failed_or_tool_message(message)?;
            }
            terminal_message = messages
                .iter()
                .rev()
                .find(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
                .cloned();
        }
    }
    let message = final_message.ok_or(SideCallError::BadOutput)?;
    // A message_end followed by EOF is an interrupted event stream. The
    // terminal agent_end must confirm the same final assistant message.
    if terminal_message.as_ref() != Some(&message) {
        return Err(SideCallError::BadOutput);
    }
    if message.get("stopReason").and_then(Value::as_str) != Some("stop") {
        return Err(SideCallError::BadOutput);
    }
    let content = message
        .get("content")
        .and_then(Value::as_array)
        .ok_or(SideCallError::BadOutput)?;
    let mut output = String::new();
    for part in content {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => output.push_str(
                part.get("text")
                    .and_then(Value::as_str)
                    .ok_or(SideCallError::BadOutput)?,
            ),
            Some("thinking") => {}
            _ => return Err(SideCallError::BadOutput),
        }
    }
    let structured: Value = serde_json::from_str(&output).map_err(|_| SideCallError::BadOutput)?;
    if !structured.is_object() {
        return Err(SideCallError::BadOutput);
    }
    Ok(SideCallOutput {
        structured,
        usage: message.get("usage").cloned(),
    })
}

fn reject_failed_or_tool_message(message: &Value) -> Result<(), SideCallError> {
    if message.get("stopReason").and_then(Value::as_str) == Some("length") {
        return Err(SideCallError::BadOutput);
    }
    if message.get("role").and_then(Value::as_str) == Some("toolResult")
        || matches!(
            message.get("stopReason").and_then(Value::as_str),
            Some("error" | "aborted" | "toolUse")
        )
        || message
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|content| {
                content
                    .iter()
                    .any(|part| part.get("type").and_then(Value::as_str) == Some("toolCall"))
            })
    {
        return Err(SideCallError::Failed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(stop_reason: &str, content: Value) -> Vec<u8> {
        let message =
            serde_json::json!({"role": "assistant", "stopReason": stop_reason, "content": content});
        format!(
            "{}\n{}\n",
            serde_json::json!({"type": "message_end", "message": message}),
            serde_json::json!({"type": "agent_end", "messages": [message], "willRetry": false}),
        )
        .into_bytes()
    }

    #[test]
    fn final_assistant_json_is_the_only_accepted_result() {
        let content = serde_json::json!([{"type":"text", "text":"{\"action\":\"keep\",\"title\":\"current\",\"reason\":\"stable\"}"}]);
        let output = parse_result(&reply("stop", content)).unwrap();
        assert_eq!(output.structured["action"], "keep");
        assert!(parse_result(&reply(
            "length",
            serde_json::json!([{"type":"text","text":"{}"}])
        ))
        .is_err());
        assert!(parse_result(&reply(
            "error",
            serde_json::json!([{"type":"text","text":"{}"}])
        ))
        .is_err());
        assert!(parse_result(&reply(
            "stop",
            serde_json::json!([{"type":"toolCall","name":"read"}])
        ))
        .is_err());
        assert!(parse_result(&reply(
            "stop",
            serde_json::json!([{"type":"text","text":"```json\n{}\n```"}])
        ))
        .is_err());
        assert!(parse_result(b"{\"type\":\"tool_execution_start\"}\n").is_err());
    }

    #[test]
    fn print_events_accept_text_and_thinking_but_require_terminal_confirmation() {
        let content = serde_json::json!([
            {"type":"thinking", "thinking":"private reasoning"},
            {"type":"text", "text":"{\"title\":"},
            {"type":"text", "text":"\"中文😀\"}"},
        ]);
        let mut stream = b"{\"type\":\"session\",\"id\":\"ephemeral\"}\n{\"type\":\"agent_start\"}\n{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"partial\"}}\n".to_vec();
        stream.extend(reply("stop", content));
        // Installed Pi 0.87.1 emits this after the final agent_end.
        stream.extend(b"{\"type\":\"agent_settled\"}\n");
        assert_eq!(parse_result(&stream).unwrap().structured["title"], "中文😀");
        let completed = String::from_utf8(reply(
            "stop",
            serde_json::json!([{"type":"text","text":"{}"}]),
        ))
        .unwrap();
        assert!(parse_result(completed.lines().next().unwrap().as_bytes()).is_err());
        assert!(parse_result(format!("{completed}{{\"type\":\"error\"}}\n").as_bytes()).is_err());
        assert!(
            parse_result(format!("{completed}{{\"type\":\"agent_start\"}}\n").as_bytes()).is_err()
        );
        assert!(parse_result(format!("{completed}{{\"type\":\"message_end\",\"message\":{{\"role\":\"assistant\",\"stopReason\":\"aborted\",\"content\":[]}}}}\n").as_bytes()).is_err());
    }

    #[test]
    fn errors_cancellation_length_and_tool_events_cannot_succeed() {
        for reason in ["error", "aborted", "toolUse", "length", "unknown", ""] {
            assert!(
                parse_result(&reply(
                    reason,
                    serde_json::json!([{"type":"text","text":"{}"}])
                ))
                .is_err(),
                "{reason}"
            );
        }
        for event in [
            serde_json::json!({"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","toolName":"read"}}),
            serde_json::json!({"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta"}}),
            serde_json::json!({"type":"message_update","assistantMessageEvent":{"type":"error"}}),
            serde_json::json!({"type":"tool_execution_end"}),
            serde_json::json!({"type":"message_end","message":{"role":"toolResult","content":[]}}),
        ] {
            let stream = format!(
                "{event}\n{}",
                String::from_utf8(reply(
                    "stop",
                    serde_json::json!([{"type":"text","text":"{}"}])
                ))
                .unwrap()
            );
            assert!(parse_result(stream.as_bytes()).is_err());
        }
        assert!(parse_result(b"{\"type\":\"message_end\"").is_err());
        assert!(parse_result(b"\xff").is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn catalog_time_is_deducted_from_the_request_budget() {
        let deadline = Instant::now() + std::time::Duration::from_secs(30);
        tokio::time::advance(std::time::Duration::from_secs(12)).await;
        assert_eq!(
            remaining(deadline).unwrap(),
            std::time::Duration::from_secs(18)
        );
        tokio::time::advance(std::time::Duration::from_secs(18)).await;
        assert_eq!(remaining(deadline).unwrap_err(), SideCallError::Timeout);
    }

    #[test]
    fn isolated_command_uses_native_flags_and_only_valid_thinking_levels() {
        let schema = serde_json::json!({"type":"object"});
        for effort in ["off", "minimal", "low", "medium", "high", "xhigh", "max"] {
            let call = StructuredCall {
                provider_id: None,
                system_prompt: "host system",
                input: "stdin-only prompt",
                json_schema: &schema,
                model: "provider/model",
                effort,
                timeout: std::time::Duration::from_secs(1),
            };
            for supports_effort in [true, false] {
                let env = std::collections::HashMap::from([(
                    "OPENAI_API_KEY".into(),
                    "fixture-only".into(),
                )]);
                let command =
                    isolated_command("fixture-pi", &call, call.model, supports_effort, &env)
                        .unwrap();
                let args: Vec<_> = command
                    .as_std()
                    .get_args()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect();
                for flag in [
                    "--no-tools",
                    "--no-session",
                    "--no-extensions",
                    "--no-skills",
                    "--no-prompt-templates",
                    "--no-context-files",
                    "--no-themes",
                    "--no-approve",
                    "--offline",
                    "--print",
                ] {
                    assert!(args.iter().any(|arg| arg == flag), "{flag}");
                }
                let thinking = args.iter().position(|arg| arg == "--thinking").unwrap();
                assert_eq!(
                    args[thinking + 1],
                    if supports_effort { effort } else { "off" }
                );
                assert!(!args.iter().any(|arg| arg.contains(call.input)));
                assert!(command
                    .as_std()
                    .get_envs()
                    .any(|(key, value)| key == "OPENAI_API_KEY"
                        && value == Some(std::ffi::OsStr::new("fixture-only"))));
            }
        }
        for effort in ["ultra", "bogus", ""] {
            let call = StructuredCall {
                provider_id: None,
                system_prompt: "host system",
                input: "fixture",
                json_schema: &schema,
                model: "provider/model",
                effort,
                timeout: std::time::Duration::from_secs(1),
            };
            assert!(matches!(
                isolated_command("fixture-pi", &call, call.model, true, &Default::default()),
                Err(SideCallError::Unavailable)
            ));
        }
    }
}
