//! Unified post-turn next-prompt prediction powered by Codex GPT.
//!
//! After an assistant turn settles across any CCGUI chat engine, the frontend
//! sends the recent user/assistant turns here. We sanitize and compact the
//! transcript excerpt, run an isolated stateless Codex `side_call::structured`
//! completion (no thread/turn on disk, no tools/MCP/hooks), and validate the
//! returned single-line suggestion before handing it back for ghost-text
//! display in the empty composer.

use crate::engine::side_call::{self, StructuredCall};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::Semaphore;

const RECENT_TURNS: usize = 5;
const EARLY_USER_CHARS: usize = 400;
const EARLY_ASSISTANT_CHARS: usize = 300;
const LATEST_USER_CHARS: usize = 600;
const LATEST_ASSISTANT_HEAD_CHARS: usize = 400;
const LATEST_ASSISTANT_TAIL_CHARS: usize = 800;
const GOAL_CHARS: usize = 400;
const MAX_SUGGESTION_CHARS: usize = 120;
const MIN_SUGGESTION_CHARS: usize = 2;
const TIMEOUT: Duration = Duration::from_secs(30);

static PERMITS: Semaphore = Semaphore::const_new(2);

const SYSTEM_PROMPT: &str = "\
You predict the single most likely next message the user will send in a software engineering chat.
Input is JSON with `recent_turns` (ordered oldest to newest) and optional `original_goal`.

Return JSON matching the schema `{\"suggestion\": string | null}`:
- Predict what the user will naturally type next to continue the workflow (e.g., confirming a proposed plan, asking to run tests/build, requesting the next concrete step, or answering a choice the assistant just presented).
- Write in the EXACT same language as the user's messages (Chinese if the user writes in Chinese, English if English).
- Keep it concise, natural, and directly sendable as a user prompt: one single line, no line breaks, no surrounding quotes, no markdown fences, typically 4–40 Chinese characters or 3–18 English words.
- Ground the suggestion strictly in the latest assistant reply and the thread's goal. Never invent unrelated files, commands, or requirements.
- Return `{\"suggestion\": null}` when the task is completely finished with no natural follow-up, when the assistant only acknowledged a closing remark, or when the next step is too open-ended to guess usefully.";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PredictionTurn {
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant: Option<String>,
}

#[derive(Debug, Serialize)]
struct PredictionInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    original_goal: Option<String>,
    recent_turns: Vec<PredictionTurn>,
}

fn valid_model_selector(model: &str) -> Option<String> {
    let trimmed = model.trim();
    if trimmed.is_empty()
        || trimmed.len() > 256
        || trimmed.starts_with('-')
        || trimmed.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return None;
    }
    Some(trimmed.to_string())
}

pub(crate) fn resolve_codex_model_from(
    config_toml: Option<&str>,
    settings_model: Option<&str>,
) -> String {
    if let Some(content) = config_toml {
        if let Ok(config) = toml::from_str::<toml::Value>(content) {
            if let Some(model) = config
                .get("model")
                .and_then(toml::Value::as_str)
                .and_then(valid_model_selector)
            {
                return model;
            }
        }
    }
    settings_model
        .and_then(valid_model_selector)
        .unwrap_or_default()
}

fn resolve_codex_model() -> String {
    let home = crate::engine::codex_home();
    let config_toml = std::fs::read_to_string(home.join("config.toml")).ok();
    let settings_model = crate::settings::read_settings()
        .ok()
        .and_then(|s| s.default_models.get("codex").cloned());
    resolve_codex_model_from(config_toml.as_deref(), settings_model.as_deref())
}

#[tauri::command]
pub async fn predict_next_prompt(turns: Vec<PredictionTurn>) -> Result<Option<String>, String> {
    let Some((input, latest_user)) = prepare_input(&turns) else {
        return Ok(None);
    };
    let Ok(_permit) = PERMITS.acquire().await else {
        return Ok(None);
    };
    let model = resolve_codex_model();
    let schema = prediction_schema();
    let call = StructuredCall {
        system_prompt: SYSTEM_PROMPT,
        input: &input,
        json_schema: &schema,
        model: &model,
        provider_id: None,
        effort: "low",
        timeout: TIMEOUT,
    };
    match side_call::structured("codex", call).await {
        Ok(output) => Ok(validate_suggestion(&output.structured, &latest_user)),
        Err(err) => {
            eprintln!("[composer-prediction] codex side_call failed: {err:?}");
            Ok(None)
        }
    }
}

fn prediction_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "suggestion": {
                "type": ["string", "null"]
            }
        },
        "required": ["suggestion"],
        "additionalProperties": false
    })
}

fn is_cli_envelope(body: &str) -> bool {
    [
        "<task-notification",
        "<local-command",
        "<bash-input",
        "<bash-stdout",
        "<command-",
    ]
    .iter()
    .any(|tag| body.starts_with(tag))
}

fn collapse_prose(text: &str) -> String {
    let mut prose = String::with_capacity(text.len().min(4096));
    let mut in_fence = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            if !in_fence {
                prose.push_str(" [代码] ");
            }
            in_fence = !in_fence;
            continue;
        }
        if !in_fence {
            prose.push_str(line);
            prose.push(' ');
        }
    }
    prose.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn compact_head(text: &str, max_chars: usize) -> String {
    let collapsed = collapse_prose(text);
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    let mut cut: String = collapsed.chars().take(max_chars).collect();
    cut.push('…');
    cut
}

/// Preserves both the opening summary and the closing conclusion/follow-up
/// question of the latest assistant reply.
fn compact_head_and_tail(text: &str, head_chars: usize, tail_chars: usize) -> String {
    let collapsed = collapse_prose(text);
    let chars: Vec<char> = collapsed.chars().collect();
    let max_total = head_chars + tail_chars;
    if chars.len() <= max_total {
        return collapsed;
    }
    let head: String = chars[..head_chars].iter().collect();
    let tail: String = chars[chars.len() - tail_chars..].iter().collect();
    format!("{head} … {tail}")
}

pub(crate) fn prepare_input(turns: &[PredictionTurn]) -> Option<(String, String)> {
    let mut cleaned: Vec<PredictionTurn> = Vec::new();
    for turn in turns {
        let user = crate::history::strip_title_noise(&turn.user);
        let user = user.trim();
        if user.is_empty() || is_cli_envelope(user) || user.starts_with('/') {
            continue;
        }
        let assistant = turn
            .assistant
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        cleaned.push(PredictionTurn {
            user: user.to_string(),
            assistant,
        });
    }
    let last = cleaned.last()?;
    if last.assistant.as_deref().unwrap_or_default().is_empty() {
        return None;
    }
    let latest_user = last.user.clone();
    let start = cleaned.len().saturating_sub(RECENT_TURNS);
    let slice = &cleaned[start..];
    let last_idx = slice.len() - 1;
    let recent_turns: Vec<PredictionTurn> = slice
        .iter()
        .enumerate()
        .map(|(idx, turn)| {
            if idx == last_idx {
                PredictionTurn {
                    user: compact_head(&turn.user, LATEST_USER_CHARS),
                    assistant: turn.assistant.as_deref().map(|a| {
                        compact_head_and_tail(a, LATEST_ASSISTANT_HEAD_CHARS, LATEST_ASSISTANT_TAIL_CHARS)
                    }),
                }
            } else {
                PredictionTurn {
                    user: compact_head(&turn.user, EARLY_USER_CHARS),
                    assistant: turn
                        .assistant
                        .as_deref()
                        .map(|a| compact_head(a, EARLY_ASSISTANT_CHARS)),
                }
            }
        })
        .collect();
    let original_goal = (start > 0)
        .then(|| cleaned.first())
        .flatten()
        .map(|turn| compact_head(&turn.user, GOAL_CHARS));
    let payload = serde_json::to_string(&PredictionInput {
        original_goal,
        recent_turns,
    })
    .ok()?;
    Some((payload, latest_user))
}

const NON_ACTIONABLE_ACKS: &[&str] = &[
    "谢谢",
    "多谢",
    "好的谢谢",
    "辛苦了",
    "thanks",
    "thank you",
    "thx",
    "ty",
    "null",
    "none",
    "n/a",
];

fn normalize_compare(text: &str) -> String {
    text.trim()
        .trim_matches(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '。' | '！' | '!' | '.' | '~' | '～' | ',' | '，' | '?' | '？' | '…' | '、'
                        | '"' | '\'' | '“' | '”' | '‘' | '’' | '「' | '」' | '`'
                )
        })
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub(crate) fn validate_suggestion(structured: &Value, latest_user: &str) -> Option<String> {
    let raw = structured.get("suggestion")?.as_str()?;
    if raw.contains("```")
        || raw.contains("<system-reminder")
        || raw.contains("<task-notification")
    {
        return None;
    }
    let single_line = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = single_line
        .trim()
        .trim_start_matches(|c: char| matches!(c, '>' | '-' | '*' | '•'))
        .trim()
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '“' | '”' | '「' | '」' | '`'))
        .trim();
    let count = trimmed.chars().count();
    if !(MIN_SUGGESTION_CHARS..=MAX_SUGGESTION_CHARS).contains(&count) {
        return None;
    }
    let norm = normalize_compare(trimmed);
    if norm.is_empty()
        || NON_ACTIONABLE_ACKS.contains(&norm.as_str())
        || norm == normalize_compare(latest_user)
    {
        return None;
    }
    Some(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_input_keeps_recent_turns_and_latest_assistant_tail() {
        let long_tail = format!(
            "{} {}",
            "头部说明。".repeat(120),
            "最后请问：是否需要我现在运行测试并提交变更？"
        );
        let turns = vec![
            PredictionTurn {
                user: "<system-reminder>ignore</system-reminder>".into(),
                assistant: None,
            },
            PredictionTurn {
                user: "修复登录接口超时问题".into(),
                assistant: Some(long_tail),
            },
        ];
        let (input, latest_user) = prepare_input(&turns).expect("prepared input");
        assert_eq!(latest_user, "修复登录接口超时问题");
        assert!(input.contains("修复登录接口超时问题"));
        assert!(input.contains("是否需要我现在运行测试并提交变更？"));
    }

    #[test]
    fn prepare_input_rejects_missing_assistant_reply_or_slash_only() {
        assert!(prepare_input(&[]).is_none());
        assert!(prepare_input(&[PredictionTurn {
            user: "/compact".into(),
            assistant: Some("done".into()),
        }])
        .is_none());
        assert!(prepare_input(&[PredictionTurn {
            user: "检查构建".into(),
            assistant: Some("   ".into()),
        }])
        .is_none());
    }

    #[test]
    fn validate_suggestion_accepts_actionable_prompts_and_rejects_noise() {
        assert_eq!(
            validate_suggestion(
                &json!({"suggestion": "  \"运行单元测试并检查构建\"  "}),
                "修复登录接口超时问题"
            ),
            Some("运行单元测试并检查构建".into())
        );
        assert_eq!(
            validate_suggestion(&json!({"suggestion": null}), "修复登录接口超时问题"),
            None
        );
        assert_eq!(
            validate_suggestion(&json!({"suggestion": "谢谢！"}), "修复登录接口超时问题"),
            None
        );
        assert_eq!(
            validate_suggestion(
                &json!({"suggestion": "修复登录接口超时问题"}),
                "修复登录接口超时问题"
            ),
            None
        );
        assert_eq!(
            validate_suggestion(
                &json!({"suggestion": "```bash\npnpm test\n```"}),
                "修复登录接口超时问题"
            ),
            None
        );
    }

    #[test]
    fn resolve_codex_model_prefers_config_toml_then_settings() {
        assert_eq!(
            resolve_codex_model_from(
                Some("model = \"gpt-6.1-sol\"\nmodel_reasoning_effort = \"xhigh\""),
                Some("gpt-6-astra")
            ),
            "gpt-6.1-sol"
        );
        assert_eq!(
            resolve_codex_model_from(Some("model_reasoning_effort = \"xhigh\""), Some("gpt-6-astra")),
            "gpt-6-astra"
        );
        assert_eq!(resolve_codex_model_from(None, Some("   ")), "");
    }
}
