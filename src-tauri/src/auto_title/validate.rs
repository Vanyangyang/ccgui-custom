//! The model proposes, this file decides: a candidate reaches the sidebar
//! only in the exact 「emoji 对象｜目标」 shape and with nothing private in it.

use serde_json::Value;

/// Category emoji, in naming.md order. ⚙️ is also accepted without its
/// variation selector and normalized back to it.
const CATEGORIES: &[&str] = &["🎬", "🧩", "🔎", "🎨", "📝", "📅", "⚙️", "💬"];
const SEPARATOR: char = '｜';
pub(super) const MAX_TITLE_CHARS: usize = 48;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Decision {
    Keep,
    Rename(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Invalid(pub &'static str);

/// Interpret the namer's structured answer against the title it was shown.
/// A rename to the same text is a keep.
pub(super) fn decide(answer: &Value, current: &str) -> Result<Decision, Invalid> {
    let action = answer.get("action").and_then(Value::as_str);
    let title = answer.get("title").and_then(Value::as_str);
    match (action, title) {
        (Some("keep"), _) => Ok(Decision::Keep),
        (Some("rename"), Some(title)) => {
            let title = normalize(title)?;
            if title == current.trim() {
                Ok(Decision::Keep)
            } else {
                Ok(Decision::Rename(title))
            }
        }
        _ => Err(Invalid("unexpected answer shape")),
    }
}

pub(super) fn normalize(raw: &str) -> Result<String, Invalid> {
    let raw = raw.trim();
    if raw.chars().any(char::is_control) {
        return Err(Invalid("control characters"));
    }
    let (emoji, rest) = CATEGORIES
        .iter()
        .find_map(|e| raw.strip_prefix(e).map(|rest| (*e, rest)))
        .or_else(|| raw.strip_prefix('⚙').map(|rest| ("⚙️", rest)))
        .ok_or(Invalid("missing category emoji"))?;
    let body = rest.trim();
    if body.is_empty() || !rest.starts_with(' ') {
        return Err(Invalid("emoji must be followed by one space"));
    }
    if body.contains('|') || body.matches(SEPARATOR).count() != 1 {
        return Err(Invalid("needs exactly one 「｜」"));
    }
    let (object, goal) = body.split_once(SEPARATOR).expect("one separator");
    let (object, goal) = (object.trim(), goal.trim());
    if object.is_empty() || goal.is_empty() {
        return Err(Invalid("empty object or goal"));
    }
    if body.chars().any(is_pictographic) {
        return Err(Invalid("more than one emoji"));
    }
    if looks_private_or_markup(body) {
        return Err(Invalid("markup, link, path or contact data"));
    }
    let title = format!("{emoji} {object}{SEPARATOR}{goal}");
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(Invalid("too long"));
    }
    Ok(title)
}

/// Emoji-range code points; CJK, kana and full-width punctuation are outside
/// these blocks.
fn is_pictographic(c: char) -> bool {
    matches!(c as u32,
        0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0xFE0F | 0x200D)
}

fn looks_private_or_markup(body: &str) -> bool {
    const FRAGMENTS: &[&str] = &[
        "`", "**", "http://", "https://", "://", "\\", "@", "/Users/", "/home/", "sk-",
    ];
    if FRAGMENTS.iter().any(|f| body.contains(f)) {
        return true;
    }
    if has_unix_absolute_path(body) || has_phone_number(body) {
        return true;
    }
    // Windows drive paths (`C:/…`, `D:\…`).
    let chars: Vec<char> = body.chars().collect();
    chars
        .windows(3)
        .any(|w| w[0].is_ascii_alphabetic() && w[1] == ':' && matches!(w[2], '/' | '\\'))
        || matches!(chars.first(), Some('"' | '\'' | '「' | '“' | '#'))
}

fn has_unix_absolute_path(body: &str) -> bool {
    let mut previous = None;
    for (offset, c) in body.char_indices() {
        if c == '/' {
            let boundary = previous.is_none_or(|c: char| {
                c.is_whitespace()
                    || matches!(c, '｜' | '(' | '[' | '{' | '<' | '"' | '\'' | ':' | '：')
            });
            let tail = &body[offset + c.len_utf8()..];
            // A lone separator ("A / B") is ordinary prose. A slash-led
            // component at a word boundary is an absolute path, including
            // roots outside the previously listed /home and /Users trees.
            if boundary
                && tail
                    .chars()
                    .next()
                    .is_some_and(|c| !c.is_whitespace() && c != '｜')
            {
                return true;
            }
        }
        previous = Some(c);
    }
    false
}

fn has_phone_number(body: &str) -> bool {
    let chars: Vec<char> = body.chars().collect();
    let mut offset = 0;
    while offset < chars.len() {
        if chars[offset] == '+' && chars.get(offset + 1).is_some_and(char::is_ascii_digit) {
            let digits = chars[offset + 1..]
                .iter()
                .take_while(|c| c.is_ascii_digit() || matches!(**c, ' ' | '-' | '(' | ')' | '.'))
                .filter(|c| c.is_ascii_digit())
                .count();
            if (7..=15).contains(&digits) {
                return true;
            }
        }
        if chars[offset].is_ascii_digit() {
            let start = offset;
            while offset < chars.len() && chars[offset].is_ascii_digit() {
                offset += 1;
            }
            // Mainland mobile numbers: preserve arbitrary numeric identifiers,
            // versions and dates rather than rejecting every long digit run.
            if offset - start == 11
                && chars[start] == '1'
                && ('3'..='9').contains(&chars[start + 1])
            {
                return true;
            }
        } else {
            offset += 1;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_and_normalizes_the_titled_shape() {
        assert_eq!(
            normalize("🧩 邮箱验证码｜过期修复").unwrap(),
            "🧩 邮箱验证码｜过期修复"
        );
        assert_eq!(
            normalize("  🎨 登录表单 ｜ 布局优化 ").unwrap(),
            "🎨 登录表单｜布局优化"
        );
        assert_eq!(
            normalize("⚙ Claude CLI｜代理配置").unwrap(),
            "⚙️ Claude CLI｜代理配置"
        );
        assert_eq!(
            normalize("🧩 Email verification｜Fix expiry").unwrap(),
            "🧩 Email verification｜Fix expiry"
        );
    }

    #[test]
    fn rejects_everything_outside_it() {
        for bad in [
            "邮箱验证码｜过期修复",
            "🛠️ 邮箱验证码｜过期修复",
            "🧩邮箱验证码｜过期修复",
            "🧩 邮箱验证码 | 过期修复",
            "🧩 邮箱验证码过期修复",
            "🧩 邮箱｜验证码｜修复",
            "🧩 ｜过期修复",
            "🧩 邮箱验证码｜",
            "🧩 邮箱验证码｜过期修复 ✅",
            "🧩 `auth.rs`｜修复",
            "🧩 D:\\work｜修复",
            "🧩 user@example.com｜回复",
            "🧩 文档｜见 https://x.y",
            "🧩 一\n二｜三",
        ] {
            assert!(normalize(bad).is_err(), "{bad:?} should be rejected");
        }
        let long = format!("🧩 {}｜{}", "长".repeat(30), "目".repeat(20));
        assert_eq!(normalize(&long), Err(Invalid("too long")));
    }

    #[test]
    fn decisions_follow_action_and_collapse_no_op_renames() {
        let current = "🧩 登录表单｜修复";
        assert_eq!(
            decide(&json!({"action":"keep","title":"x","reason":""}), current),
            Ok(Decision::Keep)
        );
        assert_eq!(
            decide(
                &json!({"action":"rename","title":"🧩 登录表单｜修复","reason":""}),
                current
            ),
            Ok(Decision::Keep)
        );
        assert_eq!(
            decide(
                &json!({"action":"rename","title":"🧩 登录表单｜报错样式","reason":""}),
                current
            ),
            Ok(Decision::Rename("🧩 登录表单｜报错样式".into()))
        );
        assert!(decide(&json!({"action":"rename","title":"登录表单"}), current).is_err());
        assert!(decide(&json!({"title":"🧩 a｜b"}), current).is_err());
    }

    #[test]
    fn private_paths_and_phone_numbers_are_rejected_without_banning_versions_or_dates() {
        for bad in [
            "⚙️ /etc/secret｜配置排查",
            "📝 配置｜读取 /var/private/token",
            "🧩 客户13800138000｜联系安排",
            "🧩 客户+8613800138000｜联系安排",
            "📅 联系人+1 (415) 555-0123｜安排通话",
        ] {
            assert!(normalize(bad).is_err(), "{bad:?} should be rejected");
        }
        for good in [
            "⚙️ Node 22.19.0｜版本升级",
            "📅 2026-10-04｜行程安排",
            "📅 2026/10/04｜行程安排",
            "🧩 HTTP/2｜连接修复",
            "🧩 构建12345678901｜错误排查",
        ] {
            assert!(normalize(good).is_ok(), "{good:?} should be accepted");
        }
    }
}
