//! Bounded reconciliation: native provenance is reread before and after inference.
use super::{protocol::*, *};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordSource {
    pub kind: String,
    pub role: String,
    pub complete: bool,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordState {
    #[default]
    Active,
    Withdrawn,
}
impl RecordState {
    fn is_active(&self) -> bool {
        *self == Self::Active
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub id: String,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "RecordState::is_active")]
    pub state: RecordState,
    pub kind: String,
    pub title: String,
    pub text: String,
    pub conditions: Vec<String>,
    pub authority: String,
    pub source: RecordSource,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
    pub project_id: String,
    pub batch_id: String,
    pub root: Record,
    pub candidates: Vec<Record>,
    #[serde(default)]
    pub reconcile_only: bool,
}
fn bounded(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.chars().count() <= max
}
impl Request {
    pub fn records(&self) -> Vec<&Record> {
        std::iter::once(&self.root)
            .chain(self.candidates.iter())
            .collect()
    }
    pub fn validate(&self) -> Result<(), String> {
        if !valid_id(&self.request_id)
            || !valid_id(&self.project_id)
            || !valid_id(&self.batch_id)
            || self.candidates.len() > 6
        {
            return Err("invalid_review_request".into());
        }
        if serde_json::to_vec(self)
            .map_err(|_| "invalid_review_request")?
            .len()
            > 32768
        {
            return Err("review_request_budget_exceeded".into());
        }
        let mut ids = HashSet::new();
        for r in self.records() {
            if !bounded(&r.id, 180)
                || !ids.insert(&r.id)
                || r.revision == 0
                || r.revision > 9_007_199_254_740_991
                || !matches!(
                    r.kind.as_str(),
                    "decision" | "idea" | "observation" | "hypothesis" | "handoff"
                )
                || !bounded(&r.title, 160)
                || !bounded(&r.text, 1600)
                || r.conditions.len() > 4
                || r.conditions.iter().any(|c| !bounded(c, 300))
                || !bounded(&r.authority, 64)
            {
                return Err("review_record_not_reviewable".into());
            }
            let s = &r.source;
            if !bounded(&s.kind, 80)
                || !bounded(&s.role, 80)
                || s.text.chars().count() > 8192
                || [
                    &s.engine,
                    &s.session_id,
                    &s.message_id,
                    &s.host_project_id,
                    &s.source_kind,
                    &s.source_id,
                ]
                .iter()
                .any(|v| v.as_ref().is_some_and(|s| !bounded(s, 300)))
                || s.workspace_path.as_ref().is_some_and(|s| !bounded(s, 4096))
            {
                return Err("review_source_budget_exceeded".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Provenance {
    pub version: u8,
    pub scope: String,
    pub host_project_id: String,
    pub memory_project_id: String,
    pub source: Source,
    pub session_ref: SessionRef,
    pub from_cursor: Option<Cursor>,
    pub next_cursor: Cursor,
    pub input_digest: String,
    pub source_digest: Option<String>,
    pub partial: bool,
    pub model: String,
    pub evidence: Vec<Evidence>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VerifiedEvidence {
    pub seq: i64,
    pub role: String,
    pub quote: String,
    pub event_ms: Option<i64>,
    /// Entire bounded native-visible row, so a quote cannot hide its negation.
    pub context: String,
    pub previous_seq: Option<i64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Proof {
    pub evidence: Vec<VerifiedEvidence>,
    pub fence: String,
    pub reason: Option<String>,
    pub replay: Option<source::ReviewReplay>,
}
impl Proof {
    fn unknown(reason: &str) -> Self {
        Self {
            evidence: vec![],
            fence: reason.into(),
            reason: Some(reason.into()),
            replay: None,
        }
    }
}
fn provenance(r: &Record, project: &str) -> Result<Option<Provenance>, String> {
    if r.source.kind != "ai_background_extract" {
        return Ok(None);
    }
    let value: Value =
        serde_json::from_str(&r.source.text).map_err(|_| "invalid_review_provenance")?;
    if value.get("fromCursor").is_none() || value.get("sourceDigest").is_some_and(Value::is_null) {
        return Err("invalid_review_provenance".into());
    }
    let p: Provenance =
        serde_json::from_str(&r.source.text).map_err(|_| "invalid_review_provenance")?;
    if !matches!(p.version, 1 | 2)
        || p.scope != "game_project"
        || p.host_project_id != project
        || p.memory_project_id.trim().is_empty()
        || p.model != MODEL
        || !valid_id(&p.source.id)
        || r.source.engine.as_deref() != Some(p.session_ref.engine.as_str())
        || r.source.session_id.as_deref() != Some(p.session_ref.session_id.as_str())
        || r.source.workspace_path.as_deref() != Some(p.session_ref.workspace_path.as_str())
        || r.source.host_project_id.as_deref() != Some(project)
        || r.source.source_id.as_deref() != Some(p.source.id.as_str())
        || r.source.source_kind.as_deref()
            != Some(match p.source.kind {
                SourceKind::Conversation => "conversation",
                SourceKind::Coordination => "coordination",
            })
        || p.input_digest.len() != 64
        || !p.input_digest.bytes().all(|b| b.is_ascii_hexdigit())
        || p.source_digest
            .as_ref()
            .is_some_and(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
        || p.evidence.is_empty()
        || p.evidence.len() > 3
        || p.evidence.iter().any(|e| {
            e.seq < 0 || !matches!(e.role.as_str(), "user" | "assistant") || !bounded(&e.quote, 400)
        })
    {
        return Err("invalid_review_provenance".into());
    }
    let mut evidence = HashSet::new();
    if p.evidence
        .iter()
        .any(|e| !evidence.insert((e.seq, e.role.as_str(), e.quote.as_str())))
    {
        return Err("duplicate_review_provenance_evidence".into());
    }
    Ok(Some(p))
}
fn prepare_review(
    db: &crate::db::Db,
    owner: &str,
    request: &Request,
    epoch: u64,
) -> Result<Vec<Proof>, String> {
    permission(owner, None)?;
    // Even an entirely unproven batch must belong to a registered, plugin-owned project.
    source::authorize_review_project(db, owner, &request.project_id)?;
    request
        .records()
        .into_iter()
        .map(|r| {
            let Some(p) = provenance(r, &request.project_id)? else {
                return Ok(Proof::unknown("source_provenance_unavailable"));
            };
            permission(owner, Some(&p.source.kind))?;
            match source::load_review(db, owner, &request.project_id, &p, &gate::GATE, epoch) {
                Ok(proof) => Ok(proof),
                Err(e)
                    if matches!(
                        e.as_str(),
                        "source_not_owned_or_oversized"
                            | "source_not_exclusively_owned"
                            | "native_history_unavailable"
                            | "native_session_identity_unproven"
                            | "native_header_unavailable"
                            | "native_header_identity_unproven"
                            | "native_header_unsupported"
                            | "archived_source"
                            | "source_not_successfully_completed"
                            | "cursor_identity_changed"
                            | "history_page_bound_exceeded"
                    ) =>
                {
                    Ok(Proof::unknown(&e))
                }
                Err(e) => Err(e),
            }
        })
        .collect()
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quote {
    pub record_id: String,
    pub quote: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Preserve {
    pub title: String,
    pub text: String,
    pub conditions: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Judgment {
    pub target_id: String,
    pub target_revision: u64,
    pub outcome: String,
    pub reason: String,
    // Value rather than Option makes an explicit null mandatory on the wire.
    pub successor_id: Value,
    pub scope: String,
    pub evidence: Vec<Quote>,
    pub depends_on: Vec<String>,
    pub preserve: Vec<Preserve>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Output {
    judgments: Vec<Judgment>,
}
fn downgrade(j: &mut Judgment, reason: &str) {
    j.outcome = "needs_review".into();
    j.reason = reason.into();
    j.successor_id = Value::Null;
    j.preserve.clear();
    j.depends_on.clear();
}
fn cyclic(edges: &HashMap<String, Vec<String>>) -> bool {
    fn walk(
        node: &str,
        edges: &HashMap<String, Vec<String>>,
        visiting: &mut HashSet<String>,
        done: &mut HashSet<String>,
    ) -> bool {
        if done.contains(node) {
            return false;
        }
        if !visiting.insert(node.into()) {
            return true;
        }
        if edges
            .get(node)
            .is_some_and(|next| next.iter().any(|n| walk(n, edges, visiting, done)))
        {
            return true;
        }
        visiting.remove(node);
        done.insert(node.into());
        false
    }
    let mut done = HashSet::new();
    edges
        .keys()
        .any(|n| walk(n, edges, &mut HashSet::new(), &mut done))
}
pub(super) fn validate_output(
    raw: &str,
    request: &Request,
    proofs: &[Proof],
) -> Result<Vec<Judgment>, String> {
    if raw.len() > 32768 {
        return Err("review_output_budget_exceeded".into());
    }
    let mut output: Output = serde_json::from_str(raw).map_err(|_| "invalid_review_output")?;
    let records = request.records();
    if output.judgments.len() != records.len() || proofs.len() != records.len() {
        return Err("review_target_set_mismatch".into());
    }
    let index: HashMap<_, _> = records
        .iter()
        .enumerate()
        .map(|(i, r)| (r.id.as_str(), i))
        .collect();
    let mut seen = HashSet::new();
    let mut edges = HashMap::new();
    for j in &mut output.judgments {
        let Some(&i) = index.get(j.target_id.as_str()) else {
            return Err("invalid_review_target".into());
        };
        let target = records[i];
        if !seen.insert(&j.target_id)
            || j.target_revision != target.revision
            || !matches!(
                j.outcome.as_str(),
                "keep" | "superseded" | "needs_review" | "conflicted"
            )
            || !matches!(
                j.scope.as_str(),
                "same" | "overlap" | "disjoint" | "unknown"
            )
            || !bounded(&j.reason, 600)
            || j.evidence.len() > 12
            || j.depends_on.len() > 6
            || j.preserve.len() > 4
        {
            return Err("invalid_review_judgment".into());
        }
        let mut quotes = HashSet::new();
        for e in &j.evidence {
            let Some(&n) = index.get(e.record_id.as_str()) else {
                return Err("invalid_review_evidence".into());
            };
            if !bounded(&e.quote, 1600)
                || !quotes.insert((&e.record_id, &e.quote))
                || !(records[n].text.contains(&e.quote)
                    || records[n]
                        .conditions
                        .iter()
                        .any(|condition| condition.contains(&e.quote))
                    || proofs[n]
                        .evidence
                        .iter()
                        .any(|p| p.quote.contains(&e.quote)))
            {
                return Err("invalid_review_quote".into());
            }
        }
        let mut deps = HashSet::new();
        for dependency in &j.depends_on {
            if dependency == &j.target_id
                || !index.contains_key(dependency.as_str())
                || !deps.insert(dependency)
                || !j.reason.contains(dependency)
                || !j.evidence.iter().any(|e| &e.record_id == dependency)
                || !j.evidence.iter().any(|e| e.record_id == j.target_id)
            {
                return Err("unsupported_review_dependency".into());
            }
        }
        let mut preserved = HashSet::new();
        for p in &j.preserve {
            if p.title != target.title
                || !bounded(&p.text, 1600)
                || !target.text.contains(&p.text)
                || p.conditions != target.conditions
                || !preserved.insert(&p.text)
            {
                return Err("non_verbatim_preservation".into());
            }
        }
        let successor = if j.successor_id.is_null() {
            None
        } else {
            Some(j.successor_id.as_str().ok_or("invalid_review_successor")?)
        };
        if (j.outcome == "superseded") != successor.is_some()
            || (j.outcome != "superseded" && !j.preserve.is_empty())
        {
            return Err("invalid_review_successor".into());
        }
        let mut next = j.depends_on.clone();
        if let Some(s) = successor {
            if s == j.target_id || !index.contains_key(s) {
                return Err("invalid_review_successor".into());
            }
            next.push(s.to_string());
        }
        edges.insert(j.target_id.clone(), next);
    }
    if cyclic(&edges) {
        return Err("cyclic_review_relations".into());
    }
    for j in &mut output.judgments {
        let i = index[j.target_id.as_str()];
        // Withdrawn records can explain history, but cannot establish a current
        // record, a successor or a live premise. An old withdrawn target may
        // still be compared with a separately proven active successor.
        let withdrawn_support = j
            .depends_on
            .iter()
            .any(|id| !records[index[id.as_str()]].state.is_active())
            || matches!(j.outcome.as_str(), "keep" | "superseded")
                && j.evidence.iter().any(|e| {
                    e.record_id != j.target_id
                        && !records[index[e.record_id.as_str()]].state.is_active()
                })
            || j.outcome == "keep" && !records[i].state.is_active()
            || j.outcome == "superseded"
                && !records[index[j.successor_id.as_str().unwrap()]]
                    .state
                    .is_active();
        if withdrawn_support {
            downgrade(j, "withdrawn_record_cannot_support_current");
            continue;
        }
        if let Some(reason) = &proofs[i].reason {
            downgrade(j, reason);
            continue;
        }
        let native_citation = |record_index: usize| {
            j.evidence.iter().any(|e| {
                e.record_id == records[record_index].id
                    && proofs[record_index]
                        .evidence
                        .iter()
                        .any(|p| p.quote == e.quote)
            })
        };
        if !j.depends_on.is_empty()
            && (!native_citation(i)
                || j.depends_on.iter().any(|id| {
                    let n = index[id.as_str()];
                    proofs[n].reason.is_some() || !native_citation(n)
                }))
        {
            downgrade(j, "dependency_original_evidence_unproven");
            continue;
        }
        if j.outcome != "superseded" {
            continue;
        }
        let n = index[j.successor_id.as_str().unwrap()];
        if let Some(reason) = &proofs[n].reason {
            downgrade(j, reason);
            continue;
        }
        let target = records[i];
        let successor = records[n];
        let kind_ok = target.kind == successor.kind
            && matches!(target.kind.as_str(), "decision" | "observation" | "handoff");
        let cited = |idx: usize| -> Vec<&VerifiedEvidence> {
            proofs[idx]
                .evidence
                .iter()
                .filter(|p| {
                    j.evidence
                        .iter()
                        .any(|e| e.record_id == records[idx].id && e.quote == p.quote)
                })
                .collect()
        };
        let old = cited(i);
        let new = cited(n);
        let times_known = !old.is_empty()
            && !new.is_empty()
            && old.iter().chain(new.iter()).all(|p| p.event_ms.is_some());
        let latest_old = proofs[i]
            .evidence
            .iter()
            .map(|p| p.event_ms)
            .collect::<Option<Vec<_>>>()
            .and_then(|v| v.into_iter().max());
        let earliest_new = new
            .iter()
            .map(|p| p.event_ms)
            .collect::<Option<Vec<_>>>()
            .and_then(|v| v.into_iter().min());
        let later = times_known
            && earliest_new
                .zip(latest_old)
                .is_some_and(|(new, old)| new > old);
        let user_decision = target.kind != "decision"
            || new
                .iter()
                .any(|p| p.role == "user" && explicit_decision(p, &new));
        // Conditions can be explicitly refined by later user evidence. Their
        // literal equality is not the semantic scope test; changed conditions
        // must all be cited as inspected material, separately from native proof.
        let conditions_cited = |record: &Record| {
            record.conditions.iter().all(|condition| {
                j.evidence
                    .iter()
                    .any(|e| e.record_id == record.id && e.quote.contains(condition))
            })
        };
        let scope_ok = (j.scope == "same" || j.scope == "overlap" && !j.preserve.is_empty())
            && (target.conditions == successor.conditions
                || conditions_cited(target) && conditions_cited(successor));
        if !kind_ok || !later || !user_decision || !scope_ok {
            downgrade(j, "replacement_evidence_order_scope_or_adoption_unproven");
        } else if !lossless_coverage(&target.text, &j.target_id, &j.evidence, &old, &j.preserve) {
            downgrade(j, "target_text_lossless_coverage_unproven");
        }
    }
    Ok(output.judgments)
}
fn lossless_coverage(
    text: &str,
    target_id: &str,
    citations: &[Quote],
    replaced: &[&VerifiedEvidence],
    preserve: &[Preserve],
) -> bool {
    // Target-body quotations establish the scope inspected, not user authority.
    // Original, independently verified Proof remains mandatory above. This
    // literal coverage check does not prove the model's semantic interpretation.
    let mut covered = vec![false; text.len()];
    for span in replaced
        .iter()
        .map(|e| e.quote.as_str())
        .chain(
            citations
                .iter()
                .filter(|e| e.record_id == target_id && text.contains(&e.quote))
                .map(|e| e.quote.as_str()),
        )
        .chain(preserve.iter().map(|p| p.text.as_str()))
    {
        if span.contains(text) {
            return true;
        }
        for (start, matched) in text.match_indices(span) {
            covered[start..start + matched.len()].fill(true);
        }
    }
    text.char_indices()
        .all(|(offset, ch)| covered[offset] || ch.is_whitespace() || ",.;:，。；：".contains(ch))
}
fn explicit_decision(user: &VerifiedEvidence, evidence: &[&VerifiedEvidence]) -> bool {
    let q = user.context.trim().trim_end_matches(['。', '.', '!', '！']);
    if q.contains('?')
        || q.contains('？')
        || ["也许", "是否", "假设", "如果", "可能", "maybe", "perhaps"]
            .iter()
            .any(|s| q.to_lowercase().contains(s))
    {
        return false;
    }
    let normalized = q.to_lowercase();
    if matches!(
        normalized.as_str(),
        "不行"
            | "别改"
            | "不同意"
            | "不要改"
            | "不要修改"
            | "先别改"
            | "我不同意这个方案"
            | "我不采纳这个建议"
            | "不要按推荐方案"
            | "no"
            | "no thanks"
            | "i disagree"
            | "do not change"
            | "don't change"
            | "not approved"
    ) {
        return false;
    }
    let short = q.chars().count() <= 8
        || q.is_ascii() && q.split_whitespace().count() <= 4
        || ["按推荐方案", "as recommended", "sounds good"]
            .iter()
            .any(|s| q.to_lowercase().contains(s));
    if short {
        let affirmative = matches!(
            q.to_lowercase().as_str(),
            "好" | "好的"
                | "行"
                | "可以"
                | "同意"
                | "确认"
                | "采纳"
                | "按推荐方案"
                | "就按推荐方案"
                | "采用推荐方案"
                | "按这个方案"
                | "就按这个方案"
                | "采用这个方案"
                | "yes"
                | "ok"
                | "okay"
                | "agreed"
                | "approved"
                | "sounds good"
                | "as recommended"
        );
        return affirmative
            && evidence
                .iter()
                .filter(|p| {
                    p.role == "assistant"
                        && p.quote.chars().count() > 20
                        && user.previous_seq == Some(p.seq)
                        && p.event_ms
                            .zip(user.event_ms)
                            .is_some_and(|(proposal, approval)| proposal < approval)
                })
                .count()
                == 1
            && evidence.iter().filter(|p| p.role == "user").count() == 1;
    }
    true
}
fn input(request: &Request, proofs: &[Proof]) -> Value {
    json!({"records":request.records().iter().zip(proofs).map(|(r,p)| json!({"id":r.id,"revision":r.revision,"state":r.state,"kind":r.kind,"title":r.title,"text":r.text,"conditions":r.conditions,"nativeEvidence":p.evidence,"sourceReason":p.reason})).collect::<Vec<_>>()})
}
fn unknown_judgments(request: &Request, proofs: &[Proof]) -> Vec<Judgment> {
    request
        .records()
        .iter()
        .zip(proofs)
        .map(|(r, p)| Judgment {
            target_id: r.id.clone(),
            target_revision: r.revision,
            outcome: "needs_review".into(),
            reason: p
                .reason
                .clone()
                .unwrap_or_else(|| "source_provenance_unavailable".into()),
            successor_id: Value::Null,
            scope: "unknown".into(),
            evidence: vec![],
            depends_on: vec![],
            preserve: vec![],
        })
        .collect()
}
fn validate_cached_review(
    db: &crate::db::Db,
    owner: &str,
    request: &Request,
    snapshot: Value,
    epoch: u64,
) -> Result<(), String> {
    permission(owner, None)?;
    source::authorize_review_project(db, owner, &request.project_id)?;
    let replay: Vec<Option<source::ReviewReplay>> =
        serde_json::from_value(snapshot).map_err(|_| "cached_source_changed")?;
    let records = request.records();
    if replay.len() != records.len() {
        return Err("cached_source_changed".into());
    }
    for (record, saved) in records.iter().zip(replay) {
        match (provenance(record, &request.project_id)?, saved) {
            (Some(p), Some(saved)) => {
                permission(owner, Some(&p.source.kind))?;
                source::verify_review_replay(
                    db,
                    owner,
                    &request.project_id,
                    &p,
                    &saved,
                    &gate::GATE,
                    epoch,
                )?;
                permission(owner, Some(&p.source.kind))?;
            }
            // Unproven manual/imported records cannot establish any native
            // conclusion; their exact payload is already bound by request ID.
            (None, None) => {}
            _ => return Err("cached_source_changed".into()),
        }
    }
    source::authorize_review_project(db, owner, &request.project_id)?;
    permission(owner, None)
}
#[tauri::command]
pub(crate) async fn plugin_memory_review(
    window: WebviewWindow,
    state: State<'_, crate::AppState>,
    plugin_id: String,
    request: Value,
) -> Result<Value, String> {
    require(window.label(), &plugin_id, None)?;
    if request.to_string().len() > 32768 {
        return Ok(source_error("review_request_budget_exceeded"));
    }
    // Optional metadata may be omitted, but explicit null is not part of the SDK.
    let sources = std::iter::once(&request["root"])
        .chain(request["candidates"].as_array().into_iter().flatten());
    if sources.into_iter().any(|r| {
        [
            "engine",
            "sessionId",
            "messageId",
            "workspacePath",
            "hostProjectId",
            "sourceKind",
            "sourceId",
        ]
        .iter()
        .any(|key| r["source"].get(*key).is_some_and(Value::is_null))
    }) {
        return Ok(source_error("invalid_review_request"));
    }
    let request: Request = match serde_json::from_value(request) {
        Ok(r) => r,
        Err(_) => return Ok(source_error("invalid_review_request")),
    };
    if let Err(reason) = request.validate() {
        return Ok(source_error(&reason));
    }
    let mut sources = vec![];
    for record in request.records() {
        if let Some(provenance) = provenance(record, &request.project_id)? {
            permission(&plugin_id, Some(&provenance.source.kind))?;
            sources.push(provenance.source.kind);
        }
    }
    let identity = automation::Identity::new(
        &plugin_id,
        &request.project_id,
        "review",
        &request.request_id,
        serde_json::to_value(&request).map_err(|_| "invalid_review_request")?,
    );
    if let Some(cached) = automation::lookup(&state.db, &identity, || {
        permission(&plugin_id, None)?;
        for source in &sources {
            permission(&plugin_id, Some(source))?;
        }
        source::authorize_review_project(&state.db, &plugin_id, &request.project_id)
    })? {
        let db = state.db.clone();
        let owner = plugin_id.clone();
        let req = request.clone();
        return Ok(replay_cached(cached, |snapshot| {
            validate_cache_read(&state, move |epoch| {
                validate_cached_review(&db, &owner, &req, snapshot, epoch)
            })
        })
        .await);
    }
    if request.reconcile_only {
        return Ok(automation::response("request_not_started", 0));
    }
    let mut lease = match gate::GATE.admit(
        &plugin_id,
        &request.request_id,
        || state.processes.active_run_count() > 0,
        crate::worker_host::paused(),
    ) {
        Ok(l) => l,
        Err(ms) => return Ok(disposition("deferred", "foreground_or_cooldown", ms)),
    };
    lease.sources = sources;
    if let Some(result) = automation::begin(&state.db, &identity)? {
        return Ok(result);
    }
    let result = review_admitted(&state, &plugin_id, &request, &identity, &mut lease).await;
    let stored = result.as_ref().cloned().unwrap_or_else(|_| {
        if lease.sent() {
            automation::response("request_outcome_unknown", 60_000)
        } else {
            disposition("unavailable", "automation_operation_failed", 60_000)
        }
    });
    automation::complete(&state.db, &identity, &stored)?;
    if result.is_err() && lease.sent() {
        Ok(stored)
    } else {
        result
    }
}
async fn review_admitted(
    state: &crate::AppState,
    plugin_id: &str,
    request: &Request,
    identity: &automation::Identity,
    lease: &mut gate::Lease,
) -> Result<Value, String> {
    let epoch = lease.epoch;
    let read = || {
        let db = state.db.clone();
        let owner = plugin_id.to_owned();
        let req = request.clone();
        tauri::async_runtime::spawn_blocking(move || prepare_review(&db, &owner, &req, epoch))
    };
    let proofs = match cancellable(lease, &state.processes, read()).await {
        Ok(Ok(Ok(p))) => p,
        Ok(Ok(Err(e))) => return Ok(source_error(&e)),
        Ok(Err(_)) => {
            return Ok(disposition(
                "unavailable",
                "memory_source_task_failed",
                60000,
            ))
        }
        Err(()) => return Ok(disposition("deferred", "preempted", 30000)),
    };
    let judgments = if proofs.iter().all(|p| p.reason.is_some()) {
        unknown_judgments(&request, &proofs)
    } else {
        let provider_input = input(&request, &proofs);
        if provider_input.to_string().len() > 65536 {
            return Ok(source_error("review_native_context_budget_exceeded"));
        }
        let raw = match model_call(
            state,
            lease,
            identity,
            memory::review_request_body(&provider_input),
            async {
                let checked = read()
                    .await
                    .map_err(|_| "memory_source_task_failed".to_string())??;
                if serde_json::to_value(&checked).ok() != serde_json::to_value(&proofs).ok() {
                    return Err("source_changed".into());
                }
                Ok(())
            },
        )
        .await?
        {
            Ok(raw) => raw,
            Err(result) => return Ok(result),
        };
        match validate_output(&raw, &request, &proofs) {
            Ok(v) => v,
            Err(_) => return Ok(disposition("unavailable", "invalid_model_response", 0)),
        }
    };
    let rechecked = match cancellable(lease, &state.processes, read()).await {
        Ok(Ok(Ok(p))) => p,
        Err(()) => return Ok(interrupted(lease)),
        _ => return Ok(disposition("deferred", "source_changed", 60000)),
    };
    if !gate::GATE.valid(epoch)
        || (!lease.sent() && state.processes.active_run_count() > 0)
        || crate::worker_host::paused()
    {
        return Ok(interrupted(lease));
    }
    if permission(&plugin_id, None).is_err() {
        return Ok(disposition(
            "unavailable",
            "memory_permission_required",
            60000,
        ));
    }
    if serde_json::to_value(&proofs).ok() != serde_json::to_value(&rechecked).ok() {
        return Ok(disposition("deferred", "source_changed", 60000));
    }
    gate::GATE.success();
    automation::save_replay(
        &state.db,
        identity,
        serde_json::to_value(proofs.iter().map(|p| &p.replay).collect::<Vec<_>>())
            .map_err(|_| "automation_storage_unavailable")?,
    )?;
    Ok(
        json!({"status":"completed","batch":{"version":1,"requestId":request.request_id,"projectId":request.project_id,"batchId":request.batch_id,"model":MODEL,"records":request.records().iter().map(|r| json!({"id":r.id,"revision":r.revision})).collect::<Vec<_>>(),"judgments":judgments}}),
    )
}

#[cfg(test)]
#[path = "review_tests.rs"]
mod tests;
