//! What the namer sees of a conversation: the typed user requests and the
//! final reply of each turn, trimmed so a long paste or a code-heavy answer
//! cannot crowd out the other turns. Tool rows and thinking never leave the
//! machine for naming.

use crate::history::Message;
use serde::Serialize;

/// Turns sent to the namer (oil-codex-title's default as well): enough to see
/// the thread's mainline, few enough that a stray last request cannot win.
pub(super) const RECENT_TURNS: usize = 5;
const USER_CHARS: usize = 500;
const ASSISTANT_CHARS: usize = 300;
const GOAL_CHARS: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct Turn {
    pub user: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant: Option<String>,
}

/// User-led turns in transcript order. A user row whose cleaned body is
/// empty is injected context, not a request, and does not open a turn.
pub(super) fn turns(messages: &[Message]) -> Vec<Turn> {
    let mut out: Vec<Turn> = Vec::new();
    for message in messages {
        match message.role.as_str() {
            "user" => {
                let body = crate::history::strip_title_noise(&message.text);
                let body = body.trim();
                if body.is_empty() || is_cli_envelope(body) {
                    continue;
                }
                out.push(Turn {
                    user: body.to_string(),
                    assistant: None,
                });
            }
            // The last reply of a turn is its answer; earlier ones narrate
            // tool use.
            "assistant" => {
                if let Some(turn) = out.last_mut() {
                    let text = message.text.trim();
                    if !text.is_empty() {
                        turn.assistant = Some(text.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// CLI-generated user rows (background task notices, local command output)
/// that survive the title cleanup.
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

#[derive(Debug, Clone, Serialize)]
pub(super) struct Excerpt {
    /// First request when it has already scrolled out of the recent window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_goal: Option<String>,
    pub recent_turns: Vec<Turn>,
    #[serde(skip)]
    pub user_turns: i64,
    #[serde(skip)]
    pub fingerprint: String,
}

pub(super) fn build(turns: &[Turn], policy_version: i64) -> Excerpt {
    let start = turns.len().saturating_sub(RECENT_TURNS);
    let recent_turns: Vec<Turn> = turns[start..]
        .iter()
        .map(|turn| Turn {
            user: compact(&turn.user, USER_CHARS),
            assistant: turn
                .assistant
                .as_deref()
                .map(|a| compact(a, ASSISTANT_CHARS)),
        })
        .collect();
    let original_goal = (start > 0)
        .then(|| turns.first())
        .flatten()
        .map(|turn| compact(&turn.user, GOAL_CHARS));
    let fingerprint = fingerprint(policy_version, &original_goal, &recent_turns);
    Excerpt {
        original_goal,
        recent_turns,
        user_turns: turns.len() as i64,
        fingerprint,
    }
}

fn fingerprint(policy_version: i64, goal: &Option<String>, recent: &[Turn]) -> String {
    use sha2::{Digest, Sha256};
    let basis = serde_json::json!({ "v": policy_version, "goal": goal, "recent": recent });
    format!("{:x}", Sha256::digest(basis.to_string().as_bytes()))
}

/// Fenced code collapses to a marker, whitespace runs to one space, then a
/// char-boundary cut with an ellipsis.
pub(super) fn compact(text: &str, max_chars: usize) -> String {
    let mut prose = String::with_capacity(text.len().min(max_chars * 4));
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
    let collapsed = prose.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max_chars {
        return collapsed;
    }
    let mut cut: String = collapsed.chars().take(max_chars).collect();
    cut.push('…');
    cut
}

const ACKS: &[&str] = &[
    "好",
    "好的",
    "好滴",
    "好嘞",
    "嗯",
    "嗯嗯",
    "行",
    "可以",
    "没问题",
    "收到",
    "明白",
    "了解",
    "谢谢",
    "多谢",
    "继续",
    "是",
    "是的",
    "对",
    "对的",
    "ok",
    "okay",
    "k",
    "yes",
    "y",
    "yep",
    "sure",
    "thanks",
    "thank you",
    "thx",
    "go on",
    "continue",
    "got it",
    "👍",
];
const GREETINGS: &[&str] = &[
    "你好",
    "您好",
    "嗨",
    "哈喽",
    "在吗",
    "在不在",
    "早",
    "早上好",
    "晚上好",
    "hi",
    "hello",
    "hey",
];

fn normalized(text: &str) -> String {
    text.trim()
        .trim_matches(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '。' | '！' | '!' | '.' | '~' | '～' | ',' | '，' | '?' | '？' | '…' | '、'
                )
        })
        .to_lowercase()
}

/// A bare acknowledgement: it continues the mainline, it never names one.
/// Action words ("推送", "修复") are deliberately absent — they can carry a
/// new goal.
pub(super) fn is_ack(text: &str) -> bool {
    ACKS.contains(&normalized(text).as_str())
}

fn is_greeting(text: &str) -> bool {
    GREETINGS.contains(&normalized(text).as_str())
}

/// At least one request that is neither a greeting nor an acknowledgement.
pub(super) fn has_substance(turns: &[Turn]) -> bool {
    turns
        .iter()
        .any(|turn| !is_ack(&turn.user) && !is_greeting(&turn.user))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, text: &str) -> Message {
        Message {
            seq: 0,
            role: role.into(),
            text: text.into(),
            ts: None,
            path: None,
            args: None,
            result: None,
            todos: None,
            usage: None,
            model: None,
            effort: None,
            duration_ms: None,
            images: Vec::new(),
        }
    }

    #[test]
    fn turns_keep_typed_requests_and_each_final_reply() {
        let messages = vec![
            message("user", "<system-reminder>ctx</system-reminder>"),
            message("user", "修复登录表单报错"),
            message("assistant", "我先看看"),
            message("tool", "read"),
            message("thinking", "..."),
            message("assistant", "已修复"),
            message("user", "<task-notification>done</task-notification>"),
            message("user", "再补测试"),
        ];
        let turns = turns(&messages);
        assert_eq!(
            turns,
            vec![
                Turn {
                    user: "修复登录表单报错".into(),
                    assistant: Some("已修复".into())
                },
                Turn {
                    user: "再补测试".into(),
                    assistant: None
                },
            ]
        );
    }

    #[test]
    fn excerpt_keeps_the_original_goal_once_it_leaves_the_window() {
        let turns: Vec<Turn> = (0..7)
            .map(|i| Turn {
                user: format!("请求{i}"),
                assistant: None,
            })
            .collect();
        let short = build(&turns[..3], 1);
        assert_eq!(short.original_goal, None, "still inside the window");
        assert_eq!(short.user_turns, 3);
        let long = build(&turns, 1);
        assert_eq!(long.recent_turns.len(), RECENT_TURNS);
        assert_eq!(long.recent_turns[0].user, "请求2");
        assert_eq!(long.original_goal.as_deref(), Some("请求0"));
        assert_ne!(
            build(&turns, 2).fingerprint,
            long.fingerprint,
            "policy bumps re-evaluate"
        );
        assert_eq!(
            build(&turns, 1).fingerprint,
            long.fingerprint,
            "stable for equal input"
        );
    }

    #[test]
    fn compact_drops_code_and_cuts_on_char_boundaries() {
        let text = "看这个\n```rust\nfn main() {}\n```\n报错了   怎么办";
        assert_eq!(compact(text, 100), "看这个 [代码] 报错了 怎么办");
        assert_eq!(compact("一二三四五", 3), "一二三…");
        assert_eq!(compact("🧩🧩🧩", 2), "🧩🧩…");
    }

    #[test]
    fn acks_and_greetings_are_not_substance() {
        assert!(is_ack("好的！"));
        assert!(is_ack(" OK. "));
        assert!(is_ack("继续"));
        assert!(!is_ack("推送"));
        assert!(!is_ack("好的，再加一个导出按钮"));
        let greet = vec![Turn {
            user: "你好".into(),
            assistant: Some("你好！".into()),
        }];
        assert!(!has_substance(&greet));
        let real = vec![
            greet[0].clone(),
            Turn {
                user: "帮我修复登录".into(),
                assistant: None,
            },
        ];
        assert!(has_substance(&real));
    }
}
