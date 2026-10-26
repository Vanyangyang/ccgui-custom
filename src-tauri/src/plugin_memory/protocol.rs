use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const MODEL: &str = "gemini-4-argon";
pub const SOURCE_BYTES: usize = 24 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub kind: SourceKind,
    pub id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Conversation,
    Coordination,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRef {
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cursor {
    pub session_id: String,
    pub seq: i64,
    pub offset: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_digest: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub id: String,
    pub revision: u64,
    pub kind: String,
    pub title: String,
    pub text: String,
    pub conditions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Relation {
    pub kind: String,
    pub target_id: String,
    pub target_revision: u64,
    pub reason: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub seq: i64,
    pub role: String,
    pub quote: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Note {
    pub kind: String,
    pub title: String,
    pub text: String,
    pub conditions: Vec<String>,
    pub related_ids: Vec<String>,
    pub evidence: Vec<Evidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relations: Option<Vec<Relation>>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Notes {
    pub notes: Vec<Note>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointRequest {
    pub project_id: String,
    pub source: Source,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest {
    pub project_id: String,
    pub source: Source,
    #[serde(default)]
    pub cursor: Option<Cursor>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractRequest {
    pub request_id: String,
    pub project_id: String,
    pub source: Source,
    #[serde(default)]
    pub cursor: Option<Cursor>,
    #[serde(default)]
    pub context: Vec<Context>,
    #[serde(default)]
    pub format_version: Option<u8>,
    #[serde(default)]
    pub expected_source_digest: Option<String>,
}
impl ExtractRequest {
    pub fn version(&self) -> u8 {
        self.format_version.unwrap_or(1)
    }
    pub fn validate_version(&self) -> Result<(), String> {
        if !matches!(self.version(), 1 | 2) {
            return Err("invalid_format_version".into());
        }
        if self
            .expected_source_digest
            .as_ref()
            .is_some_and(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
            || self.version() == 2 && self.expected_source_digest.is_none()
        {
            return Err("invalid_source_digest".into());
        }
        Ok(())
    }
    pub fn source_request(&self) -> PrepareRequest {
        PrepareRequest {
            project_id: self.project_id.clone(),
            source: self.source.clone(),
            cursor: self.cursor.clone(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Slice {
    pub seq: i64,
    pub role: String,
    pub text: String,
}
#[derive(Clone, Debug)]
pub struct Row {
    pub seq: i64,
    pub role: String,
    pub text: String,
    pub display_text: Option<String>,
}
impl Row {
    pub fn digest(&self) -> String {
        digest(&serde_json::json!([self.seq, self.role, self.text, self.display_text]).to_string())
    }
    pub fn cursor(&self, session: &str, offset: usize) -> Cursor {
        Cursor {
            session_id: session.into(),
            seq: self.seq,
            offset,
            row_digest: Some(self.digest()),
        }
    }
}
pub fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}
fn bounded(s: &str, max: usize) -> bool {
    !s.trim().is_empty()
        && s.chars().count() <= max
        && !s
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}
pub fn validate_context(context: &[Context]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    if context.len() > 6
        || serde_json::to_vec(context)
            .map_err(|_| "invalid_context")?
            .len()
            > 6 * 1024
    {
        return Err("context_limit".into());
    }
    for c in context {
        if !bounded(&c.id, 180)
            || !ids.insert(&c.id)
            || c.revision == 0
            || !matches!(
                c.kind.as_str(),
                "decision" | "idea" | "observation" | "hypothesis" | "handoff"
            )
            || !bounded(&c.title, 160)
            || !bounded(&c.text, 1600)
            || c.conditions.len() > 4
            || c.conditions.iter().any(|s| !bounded(s, 300))
            || c.authority.as_ref().is_some_and(|s| !bounded(s, 64))
            || c.updated_at.as_ref().is_some_and(|s| !bounded(s, 64))
        {
            return Err("invalid_context".into());
        }
    }
    Ok(())
}
/// Parse only the final JSON user envelope. Policy and carried quotations are never evidence.
pub fn user_text(text: &str) -> Result<String, String> {
    const START: &str = "<workbench-collaboration version=\"1\" mode=\"";
    const POLICY: &str = "\n</workbench-collaboration>";
    const INPUT: &str = "\n\n<workbench-user-message>\n";
    const END: &str = "\n</workbench-user-message>";
    if !text.contains("<workbench-collaboration") && !text.contains("<workbench-user-message") {
        return Ok(text.into());
    }
    let rest = text.strip_prefix(START).ok_or("malformed_user_wrapper")?;
    let (mode, _) = rest.split_once("\">\n").ok_or("malformed_user_wrapper")?;
    if !matches!(mode, "chat" | "coordinate") {
        return Err("malformed_user_wrapper".into());
    }
    let policy_end = text.find(POLICY).ok_or("malformed_user_wrapper")? + POLICY.len();
    let input = text.rfind(INPUT).ok_or("malformed_user_wrapper")?;
    if input < policy_end {
        return Err("malformed_user_wrapper".into());
    }
    let raw = text[input + INPUT.len()..]
        .strip_suffix(END)
        .ok_or("malformed_user_wrapper")?;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct User {
        text: String,
    }
    serde_json::from_str::<User>(raw)
        .map(|v| v.text)
        .map_err(|_| "malformed_user_wrapper".into())
}
pub fn validate_rows(rows: &[Row]) -> Result<(), String> {
    let mut prev = -1;
    for r in rows {
        if r.seq <= prev {
            return Err("nonmonotonic_history".into());
        }
        prev = r.seq;
    }
    Ok(())
}
pub struct Selection {
    pub slices: Vec<Slice>,
    pub next: Cursor,
    pub partial: bool,
    pub has_more: bool,
}
#[cfg(test)]
pub fn select(
    rows: &[Row],
    session: &str,
    cursor: Option<&Cursor>,
    later_pages: bool,
) -> Result<Selection, String> {
    select_after(rows, session, cursor, later_pages, -1)
}
pub fn select_after(
    rows: &[Row],
    session: &str,
    cursor: Option<&Cursor>,
    later_pages: bool,
    floor_seq: i64,
) -> Result<Selection, String> {
    validate_rows(rows)?;
    if let Some(c) = cursor {
        if c.session_id != session
            || c.seq < -1
            || (c.seq == -1 && (c.offset != 0 || c.row_digest.is_some()))
        {
            return Err("cursor_identity_changed".into());
        }
        if c.seq >= 0 {
            let row = rows
                .iter()
                .find(|r| r.seq == c.seq)
                .ok_or("cursor_missing")?;
            if c.row_digest.as_deref() != Some(row.digest().as_str()) {
                return Err("cursor_history_changed".into());
            }
        }
    }
    let mut result = Selection {
        slices: Vec::new(),
        next: cursor.cloned().unwrap_or(Cursor {
            session_id: session.into(),
            seq: -1,
            offset: 0,
            row_digest: None,
        }),
        partial: cursor.is_some_and(|c| c.offset > 0),
        has_more: later_pages,
    };
    let mut bytes = 0;
    for row in rows {
        if cursor.is_some_and(|c| row.seq < c.seq || (row.seq == c.seq && c.offset == 0)) {
            continue;
        }
        if row.seq <= floor_seq {
            result.next = row.cursor(session, 0);
            result.partial = true;
            continue;
        }
        if result.slices.len() == 24 || bytes >= SOURCE_BYTES {
            result.has_more = true;
            break;
        }
        if !matches!(row.role.as_str(), "user" | "assistant") {
            if cursor.is_some_and(|c| c.seq == row.seq && c.offset > 0) {
                return Err("invalid_cursor_offset".into());
            }
            result.next = row.cursor(session, 0);
            continue;
        }
        let text = if row.role == "user" {
            user_text(row.display_text.as_deref().unwrap_or(&row.text))?
        } else {
            row.text.clone()
        };
        let offset = cursor.filter(|c| c.seq == row.seq).map_or(0, |c| c.offset);
        let count = text.chars().count();
        if offset > count || (offset > 0 && offset == count) {
            return Err("invalid_cursor_offset".into());
        }
        let mut part = String::new();
        let mut consumed = 0;
        for ch in text.chars().skip(offset) {
            if bytes + part.len() + ch.len_utf8() > SOURCE_BYTES {
                break;
            }
            part.push(ch);
            consumed += 1;
        }
        if consumed + offset < count {
            result.partial = true;
            result.has_more = true;
            if consumed == 0 {
                break;
            }
            result.next = row.cursor(session, offset + consumed);
        } else {
            result.next = row.cursor(session, 0);
        }
        bytes += part.len();
        if !part.trim().is_empty() {
            result.slices.push(Slice {
                seq: row.seq,
                role: row.role.clone(),
                text: part,
            });
        }
        if consumed + offset < count {
            break;
        }
    }
    Ok(result)
}
pub fn validate_output(
    raw: &str,
    slices: &[Slice],
    context: &[Context],
) -> Result<Vec<Note>, String> {
    validate_output_version(raw, slices, context, 1)
}
pub fn validate_output_version(
    raw: &str,
    slices: &[Slice],
    context: &[Context],
    version: u8,
) -> Result<Vec<Note>, String> {
    if !matches!(version, 1 | 2) {
        return Err("invalid_format_version".into());
    }
    let mut value: Value = serde_json::from_str(raw).map_err(|_| "invalid_model_json")?;
    // Older clients must retain exactly their original shape even if the model
    // emits relation metadata. All other unknown fields remain errors.
    if version == 1 {
        if let Some(notes) = value.get_mut("notes").and_then(Value::as_array_mut) {
            for note in notes {
                if let Some(object) = note.as_object_mut() {
                    object.remove("relations");
                }
            }
        }
    }
    let parsed: Notes = serde_json::from_value(value).map_err(|_| "invalid_model_json")?;
    if parsed.notes.len() > 3 {
        return Err("too_many_notes".into());
    }
    for n in &parsed.notes {
        if !matches!(
            n.kind.as_str(),
            "decision" | "idea" | "observation" | "hypothesis" | "handoff"
        ) || !bounded(&n.title, 120)
            || !bounded(&n.text, 1600)
            || n.conditions.len() > 4
            || n.conditions.iter().any(|s| !bounded(s, 300))
            || n.related_ids.len() > 6
            || n.related_ids
                .iter()
                .any(|id| !context.iter().any(|c| c.id == *id))
            || !(1..=3).contains(&n.evidence.len())
        {
            return Err("invalid_note".into());
        }
        for e in &n.evidence {
            if !bounded(&e.quote, 400)
                || !matches!(e.role.as_str(), "user" | "assistant")
                || !slices
                    .iter()
                    .any(|s| s.seq == e.seq && s.role == e.role && s.text.contains(&e.quote))
            {
                return Err("unproven_evidence".into());
            }
        }
        if n.kind == "decision" && !n.evidence.iter().any(|e| e.role == "user") {
            return Err("decision_without_user_evidence".into());
        }
        if version == 2 {
            let relations = n.relations.as_ref().ok_or("missing_relations")?;
            if relations.len() > 3 {
                return Err("too_many_relations".into());
            }
            let mut targets = std::collections::HashSet::new();
            for relation in relations {
                let target = context
                    .iter()
                    .find(|c| {
                        c.id == relation.target_id
                            && c.revision == relation.target_revision
                            && relation.target_revision > 0
                    })
                    .ok_or("unproven_relation_target")?;
                if !matches!(relation.kind.as_str(), "supersedes" | "conflicts")
                    || !bounded(&relation.reason, 300)
                    || !targets.insert(&relation.target_id)
                {
                    return Err("invalid_relation".into());
                }
                if relation.kind == "supersedes" {
                    let mut current = n.conditions.clone();
                    current.sort();
                    let mut previous = target.conditions.clone();
                    previous.sort();
                    if n.kind != "decision"
                        || target.kind != "decision"
                        || current != previous
                        || !n.evidence.iter().any(|e| e.role == "user")
                        || matches!(
                            target.authority.as_deref(),
                            Some("user_confirmed" | "user_recorded")
                        )
                    {
                        return Err("ineligible_supersedes".into());
                    }
                }
            }
        }
    }
    Ok(parsed.notes)
}
pub fn response_text(value: &Value) -> Result<String, String> {
    let candidates = value
        .get("candidates")
        .and_then(Value::as_array)
        .ok_or("missing_candidate")?;
    if candidates.len() != 1
        || candidates[0].get("finishReason").and_then(Value::as_str) != Some("STOP")
    {
        return Err("incomplete_candidate".into());
    }
    let parts = candidates[0]
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .ok_or("missing_text")?;
    let mut text = String::new();
    for part in parts {
        let fields = part.as_object().ok_or("non_text_candidate")?;
        if fields
            .keys()
            .any(|key| !matches!(key.as_str(), "text" | "thought" | "thoughtSignature"))
            || fields
                .get("thought")
                .is_some_and(|value| !value.is_boolean())
            || fields
                .get("thoughtSignature")
                .is_some_and(|value| !value.is_string())
        {
            return Err("non_text_candidate".into());
        }
        // Provider reasoning/signature metadata is never stored as a note.
        let part_text = part["text"].as_str().ok_or("missing_text")?;
        if part["thought"] == true {
            continue;
        }
        text.push_str(part_text);
        if text.len() > 48 * 1024 {
            return Err("model_text_limit".into());
        }
    }
    if text.trim().is_empty() {
        return Err("missing_text".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(seq: i64, role: &str, text: &str) -> Row {
        Row {
            seq,
            role: role.into(),
            text: text.into(),
            display_text: None,
        }
    }
    #[test]
    fn wrapper_excludes_references_and_rejects_malformed() {
        let wrapped = "<workbench-collaboration version=\"1\" mode=\"chat\">\npolicy\n</workbench-collaboration>\n\nexternal secret\n\n<workbench-user-message>\n{\"text\":\"用户😀\"}\n</workbench-user-message>";
        assert_eq!(user_text(wrapped).unwrap(), "用户😀");
        assert!(user_text(&wrapped.replace("{\"text\"", "{bad\"text\"")).is_err());
        assert!(user_text("<workbench-user-message>unsafe").is_err());
    }
    #[test]
    fn unicode_cursor_retains_remainder_and_rejects_rewrite() {
        let rows = [row(0, "user", &"😀中文".repeat(4000))];
        let a = select(&rows, "s", None, false).unwrap();
        assert!(a.partial && a.has_more);
        let b = select(&rows, "s", Some(&a.next), false).unwrap();
        assert!(!b.has_more);
        assert_eq!(
            format!("{}{}", a.slices[0].text, b.slices[0].text),
            rows[0].text
        );
        assert!(select(&[row(0, "user", "changed")], "s", Some(&a.next), false).is_err());
        assert!(select(&rows, "other", Some(&a.next), false).is_err());
        assert!(select(
            &[row(1, "user", "x"), row(1, "assistant", "y")],
            "s",
            None,
            false
        )
        .is_err());
    }
    #[test]
    fn non_fact_rows_and_full_cursor_digest() {
        let rows = [
            row(0, "tool", "secret"),
            row(1, "thinking", "secret"),
            row(2, "narration", "secret"),
            row(3, "assistant", "hello"),
        ];
        let a = select(&rows, "s", None, false).unwrap();
        assert_eq!(a.slices.len(), 1);
        assert!(a.next.row_digest.is_some());
        assert!(select(&rows, "s", Some(&a.next), false)
            .unwrap()
            .slices
            .is_empty());
    }
    #[test]
    fn strict_notes_evidence_and_related_ids() {
        let slices = vec![Slice {
            seq: 1,
            role: "user".into(),
            text: "Use fog".into(),
        }];
        assert!(validate_output(r#"{"notes":[]}"#, &slices, &[])
            .unwrap()
            .is_empty());
        let valid = serde_json::json!({"notes":[{"kind":"decision","title":"Fog","text":"Use fog","conditions":[],"relatedIds":[],"evidence":[{"seq":1,"role":"user","quote":"Use fog"}]}]});
        assert!(validate_output(&valid.to_string(), &slices, &[]).is_ok());
        let mut forged = valid.clone();
        forged["notes"][0]["evidence"][0]["quote"] = "invented".into();
        assert!(validate_output(&forged.to_string(), &slices, &[]).is_err());
        let mut forged = valid.clone();
        forged["notes"][0]["relatedIds"] = serde_json::json!(["foreign"]);
        assert!(validate_output(&forged.to_string(), &slices, &[]).is_err());
        let mut forged = valid.clone();
        forged["notes"][0]["authority"] = "user_confirmed".into();
        assert!(validate_output(&forged.to_string(), &slices, &[]).is_err());
        assert!(validate_output("{\"notes\":[],\"extra\":true}", &slices, &[]).is_err());
    }
    #[test]
    fn transport_requires_single_stop_text() {
        let good = serde_json::json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"{\"notes\":[]}"}]}}]});
        assert!(response_text(&good).is_ok());
        let mut v = good.clone();
        v["candidates"][0]["finishReason"] = "MAX_TOKENS".into();
        assert!(response_text(&v).is_err());
        let mut v = good;
        v["candidates"][0]["content"]["parts"][0]["functionCall"] = serde_json::json!({});
        assert!(response_text(&v).is_err());
    }
    #[test]
    fn provider_metadata_is_not_part_of_the_structured_notes() {
        let response = serde_json::json!({"candidates":[{"finishReason":"STOP","content":{"parts":[
            {"text":"reasoning must not become evidence","thought":true,"thoughtSignature":"opaque"},
            {"text":"{\"notes\":","thoughtSignature":"opaque"}, {"text":"[]}"}
        ]}}]});
        assert_eq!(response_text(&response).unwrap(), "{\"notes\":[]}");
        let mut action = response;
        action["candidates"][0]["content"]["parts"][0]["functionCall"] =
            serde_json::json!({"name":"forged"});
        assert!(response_text(&action).is_err());
    }
    #[test]
    fn resumed_tail_is_still_partial_and_old_context_matches_sdk_limits() {
        let rows = [
            row(0, "user", &"中".repeat(9000)),
            row(1, "assistant", "later complete row"),
        ];
        let first = select(&rows, "s", None, false).unwrap();
        let tail = select(&rows, "s", Some(&first.next), false).unwrap();
        assert!(tail.partial);
        assert!(!tail.has_more);
        assert_eq!(tail.next.seq, 1);
        let mut context = Context {
            id: "m".into(),
            revision: 1,
            kind: "idea".into(),
            title: "t".repeat(160),
            text: "whole old text".into(),
            conditions: vec![],
            authority: None,
            updated_at: None,
        };
        assert!(validate_context(&[context.clone()]).is_ok());
        context.revision = 0;
        assert!(validate_context(&[context.clone()]).is_err());
        context.revision = 1;
        context.kind = "invented".into();
        assert!(validate_context(&[context]).is_err());
    }
    #[test]
    fn completion_floor_excludes_cancelled_prefix_without_rewriting_cursor_identity() {
        let rows = [
            row(0, "user", "old request"),
            row(1, "assistant", "unfinished proposal"),
            row(2, "user", "new decision"),
            row(3, "assistant", "complete"),
        ];
        let old = rows[0].cursor("s", 0);
        let selected = select_after(&rows, "s", Some(&old), false, 1).unwrap();
        assert!(selected.partial);
        assert_eq!(selected.next.seq, 3);
        assert_eq!(
            selected.slices.iter().map(|s| s.seq).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(select_after(&rows, "s", Some(&selected.next), false, 1)
            .unwrap()
            .slices
            .is_empty());
    }
}
