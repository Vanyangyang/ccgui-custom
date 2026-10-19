//! 计划预览与人工审批的最小类型化契约（PRD §4）。
//!
//! 审批事实源是 `plan_reviews` 表与后端注册表里停住的原生回复上下文；
//! CLI transcript 与 session_messages 搜索索引都不承担审批语义。前端只提交
//! `planId + expectedRevision + decision + 可选反馈`，原生 RPC 方法、路径与
//! 回复上下文永不离开后端。
//!
//! 状态机（审批）：
//! `draft → awaiting_review → submitting → approved | changes_requested | deferred`
//! 另加终态 `cancelled | expired | superseded`。`deferred`（暂不执行）不是
//! 终态：原生等待点仍然停着，用户可以回到同一会话继续审批（deferred 与
//! awaiting_review 都允许提交）。
//!
//! 执行状态另记：`not_started / starting / running / completed / failed /
//! unknown`。approved ≠ 执行成功；写管道成功也不是远端已执行的证据——
//! 失联只许标 unknown 并先核对上游，禁止盲目重发（五引擎均无幂等批准键，
//! 见 p0-evidence-plan-approval-2026-09-24.md §跨引擎约束 6）。

use crate::db::Db;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 计划审批能力声明（PRD §4.1：是否支持、证据、reviewKind、限制说明）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PlanApproval {
    /// 类型化人工审批主干已接通（P3+ 适配器逐引擎声明）。
    Typed {
        #[serde(rename = "reviewKind")]
        review_kind: PlanReviewKind,
        /// transport/version 校验证据（来源 + 版本）。
        evidence: &'static str,
        /// 用户可见的限制说明。
        limitations: &'static str,
    },
    /// 引擎自身的原生计划入口，保持既有行为（claude/kimi/agy/opencode）；
    /// 不经过本审批主干，也不在本轮迁移范围。
    Legacy,
    /// 没有可验证的人工计划审批路径：显式计划请求必须在发送前受控拒绝，
    /// 禁止经 resolve_permission 静默回退或自动批准参数降级启动。
    Unavailable { reason: &'static str },
}

/// 两种原生生命周期（PRD §4.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanReviewKind {
    /// 原生请求真实暂停执行，等待客户端按原生格式回答（OMP/DSH/Grok/Qoder）。
    NativeRequest,
    /// 计划轮次正常结束后由客户端仲裁；批准 = 原子创建一次执行 turn（Codex）。
    NextTurn,
}

impl PlanReviewKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NativeRequest => "native_request",
            Self::NextTurn => "next_turn",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        match s {
            "native_request" => Some(Self::NativeRequest),
            "next_turn" => Some(Self::NextTurn),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Draft,
    AwaitingReview,
    Submitting,
    Approved,
    ChangesRequested,
    Deferred,
    Cancelled,
    Expired,
    Superseded,
}

impl PlanStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::AwaitingReview => "awaiting_review",
            Self::Submitting => "submitting",
            Self::Approved => "approved",
            Self::ChangesRequested => "changes_requested",
            Self::Deferred => "deferred",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
            Self::Superseded => "superseded",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "draft" => Self::Draft,
            "awaiting_review" => Self::AwaitingReview,
            "submitting" => Self::Submitting,
            "approved" => Self::Approved,
            "changes_requested" => Self::ChangesRequested,
            "deferred" => Self::Deferred,
            "cancelled" => Self::Cancelled,
            "expired" => Self::Expired,
            "superseded" => Self::Superseded,
            _ => return None,
        })
    }
    /// 提交决策只允许从这两个状态原子抢占：其余状态（含 submitting、
    /// 一切终态）都是冲突。
    fn accepts_submission(self) -> bool {
        matches!(self, Self::AwaitingReview | Self::Deferred)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanExecution {
    NotStarted,
    Starting,
    Running,
    Completed,
    Failed,
    Unknown,
}

impl PlanExecution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotStarted => "not_started",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "not_started" => Self::NotStarted,
            "starting" => Self::Starting,
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "unknown" => Self::Unknown,
            _ => return None,
        })
    }
}

pub(crate) fn schema_contract_descriptor() -> Value {
    serde_json::json!({
        "reviewKinds": [
            PlanReviewKind::NativeRequest.as_str(),
            PlanReviewKind::NextTurn.as_str(),
        ],
        "statuses": [
            PlanStatus::Draft.as_str(),
            PlanStatus::AwaitingReview.as_str(),
            PlanStatus::Submitting.as_str(),
            PlanStatus::Approved.as_str(),
            PlanStatus::ChangesRequested.as_str(),
            PlanStatus::Deferred.as_str(),
            PlanStatus::Cancelled.as_str(),
            PlanStatus::Expired.as_str(),
            PlanStatus::Superseded.as_str(),
        ],
        "executions": [
            PlanExecution::NotStarted.as_str(),
            PlanExecution::Starting.as_str(),
            PlanExecution::Running.as_str(),
            PlanExecution::Completed.as_str(),
            PlanExecution::Failed.as_str(),
            PlanExecution::Unknown.as_str(),
        ],
    })
}

/// 用户决策。前端只提交这个枚举 + 可选反馈文本；批准不携带任何原生参数。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanDecision {
    Approve,
    RequestChanges,
    Defer,
}

impl PlanDecision {
    /// 决策生效后的审批状态。
    pub fn settled_status(self) -> PlanStatus {
        match self {
            Self::Approve => PlanStatus::Approved,
            Self::RequestChanges => PlanStatus::ChangesRequested,
            Self::Defer => PlanStatus::Deferred,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "approve",
            Self::RequestChanges => "request_changes",
            Self::Defer => "defer",
        }
    }
}

/// 计划审批记录（审批事实源）。身份 = workspace + engine + session +
/// run/turn + planId + revision（PRD §3.3）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReview {
    pub plan_id: String,
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
    pub run_id: Option<String>,
    pub revision: i64,
    pub title: String,
    /// 用户看到并复制的最终 Markdown；必须与原生最终正文逐字一致。
    pub content: String,
    /// 正文变化检测（非安全哈希；submit 前重核，文件型来源 TOCTOU 限制按
    /// PRD §5-OMP.3 记录在能力声明里）。
    pub content_hash: String,
    /// false = 草稿/来源不确定：任何批准路径都必须拒绝。
    pub complete: bool,
    pub review_kind: PlanReviewKind,
    /// 原生 plan/item ID（引擎自己的标识，原样保存）。
    pub native_plan_id: Option<String>,
    /// 批准将沿用的执行权限快照；批准不得改变它（PRD §1 不变量 4）。
    pub exec_permission: String,
    pub status: PlanStatus,
    pub execution: PlanExecution,
    /// 已落盘的决策意图 {decision, feedback?}；写管道失败/失联时留存。
    pub decision: Option<Value>,
    pub decision_intent_at: Option<i64>,
    /// 原生确认/状态变化落账时间；None = 尚未确认（含 unknown）。
    pub applied_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub superseded_by: Option<i64>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 非加密的正文指纹：检测 revision 之间与提交前后的正文变化。不用于安全
/// 绑定（原生文件并发修改的竞态只能由上游不可变 proposal 解决，见 PRD
/// §5-OMP.3），所以标准库 SipHash 足够，不引入新依赖。
pub fn content_hash(content: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.len().hash(&mut hasher);
    content.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// 新计划版本登记：revision = 该 planId 现有最大 revision + 1，旧版本全部
/// 标记 superseded（已批准/已替代版本只有查看与复制，不再提供批准）。
/// 返回新记录的 revision。
pub(crate) fn record_review(db: &Db, review: &PlanReview) -> Result<i64, String> {
    let conn = db.0.lock();
    let next: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(revision), 0) + 1 FROM plan_reviews WHERE plan_id=?1",
            rusqlite::params![review.plan_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let now = now_ms();
    conn.execute(
        "UPDATE plan_reviews SET status=?1, superseded_by=?2, updated_at=?3
         WHERE plan_id=?4 AND status IN (?5, ?6, ?7, ?8)",
        rusqlite::params![
            PlanStatus::Superseded.as_str(),
            next,
            now,
            review.plan_id,
            PlanStatus::Draft.as_str(),
            PlanStatus::AwaitingReview.as_str(),
            PlanStatus::Submitting.as_str(),
            PlanStatus::Deferred.as_str(),
        ],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO plan_reviews
            (plan_id, engine, session_id, workspace_path, run_id, revision,
             title, content, content_hash, complete, review_kind, native_plan_id,
             exec_permission, status, execution, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16)",
        rusqlite::params![
            review.plan_id,
            review.engine,
            review.session_id,
            review.workspace_path,
            review.run_id,
            next,
            review.title,
            review.content,
            review.content_hash,
            review.complete as i64,
            review.review_kind.as_str(),
            review.native_plan_id,
            review.exec_permission,
            review.status.as_str(),
            review.execution.as_str(),
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(next)
}

fn map_review(row: &rusqlite::Row) -> rusqlite::Result<PlanReview> {
    let status: String = row.get(13)?;
    let execution: String = row.get(14)?;
    let review_kind: String = row.get(10)?;
    Ok(PlanReview {
        plan_id: row.get(0)?,
        engine: row.get(1)?,
        session_id: row.get(2)?,
        workspace_path: row.get(3)?,
        run_id: row.get(4)?,
        revision: row.get(5)?,
        title: row.get(6)?,
        content: row.get(7)?,
        content_hash: row.get(8)?,
        complete: row.get::<_, i64>(9)? != 0,
        review_kind: PlanReviewKind::parse(&review_kind).unwrap_or(PlanReviewKind::NativeRequest),
        native_plan_id: row.get(11)?,
        exec_permission: row.get(12)?,
        status: PlanStatus::parse(&status).unwrap_or(PlanStatus::Expired),
        execution: PlanExecution::parse(&execution).unwrap_or(PlanExecution::Unknown),
        decision: row
            .get::<_, Option<String>>(15)?
            .and_then(|raw| serde_json::from_str(&raw).ok()),
        decision_intent_at: row.get(16)?,
        applied_at: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
        superseded_by: row.get(20)?,
    })
}

const REVIEW_COLUMNS: &str = "plan_id, engine, session_id, workspace_path, run_id,
     revision, title, content, content_hash, complete, review_kind, native_plan_id,
     exec_permission, status, execution, decision, decision_intent_at, applied_at,
     created_at, updated_at, superseded_by";

pub(crate) fn get_review(
    db: &Db,
    plan_id: &str,
    revision: i64,
) -> Result<Option<PlanReview>, String> {
    let conn = db.0.lock();
    conn.query_row(
        &format!("SELECT {REVIEW_COLUMNS} FROM plan_reviews WHERE plan_id=?1 AND revision=?2"),
        rusqlite::params![plan_id, revision],
        map_review,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// 会话的全部计划版本（历史页加载；按 planId/revision 主键天然去重）。
pub(crate) fn list_reviews(db: &Db, engine: &str, session_id: &str) -> Result<Vec<PlanReview>, String> {
    let conn = db.0.lock();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {REVIEW_COLUMNS} FROM plan_reviews
             WHERE engine=?1 AND session_id=?2
             ORDER BY plan_id, revision"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![engine, session_id], map_review)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// CAS 结果：要么本次调用抢占了提交权，要么原样返回当前状态供调用方
/// 呈现冲突（重复点击返回相同结果或明确冲突——PRD §4.2）。
#[derive(Debug)]
pub(crate) enum SubmitOutcome {
    /// 抢占成功：记录已进入 submitting，决策意图已落盘。
    Claimed { previous: PlanStatus },
    /// 冲突：当前状态/版本与调用方预期不符。
    Conflict(Box<PlanReview>),
}

/// 原子抢占提交：expectedRevision + 状态条件更新。db 互斥锁内先读再写，
/// 本进程内串行；同一 planId/revision 最多一个提交者（验收规格 §2「双击、
/// 两个窗口、重试」）。
pub(crate) fn submit_decision(
    db: &Db,
    plan_id: &str,
    expected_revision: i64,
    decision: PlanDecision,
    feedback: Option<&str>,
) -> Result<SubmitOutcome, String> {
    if decision == PlanDecision::RequestChanges
        && feedback.map(|f| f.trim().is_empty()).unwrap_or(true)
    {
        return Err("request_changes requires non-empty feedback".to_string());
    }
    let conn = db.0.lock();
    let current = conn
        .query_row(
            &format!("SELECT {REVIEW_COLUMNS} FROM plan_reviews WHERE plan_id=?1 AND revision=?2"),
            rusqlite::params![plan_id, expected_revision],
            map_review,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(current) = current else {
        return Err("plan review not found for this revision".to_string());
    };
    if !current.complete {
        return Err("plan content is incomplete; approval is not allowed yet".to_string());
    }
    if !current.status.accepts_submission() {
        return Ok(SubmitOutcome::Conflict(Box::new(current)));
    }
    let decision_json = serde_json::json!({
        "decision": decision.as_str(),
        "feedback": feedback,
    });
    let now = now_ms();
    conn.execute(
        "UPDATE plan_reviews
         SET status=?1, decision=?2, decision_intent_at=?3, updated_at=?3
         WHERE plan_id=?4 AND revision=?5",
        rusqlite::params![
            PlanStatus::Submitting.as_str(),
            decision_json.to_string(),
            now,
            plan_id,
            expected_revision,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(SubmitOutcome::Claimed {
        previous: current.status,
    })
}

/// 原生确认后落账：submitting → 决策对应终态，applied_at 记录确认时间。
pub(crate) fn mark_applied(
    db: &Db,
    plan_id: &str,
    revision: i64,
    decision: PlanDecision,
) -> Result<(), String> {
    let conn = db.0.lock();
    conn.execute(
        "UPDATE plan_reviews SET status=?1, applied_at=?2, updated_at=?2
         WHERE plan_id=?3 AND revision=?4 AND status=?5",
        rusqlite::params![
            decision.settled_status().as_str(),
            now_ms(),
            plan_id,
            revision,
            PlanStatus::Submitting.as_str(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 写管道失败：决策意图留存（decision/decision_intent_at 不动），状态退回
/// 抢占前状态，批准绝不显示成功（验收规格 §2「写管道失败」）。
pub(crate) fn revert_submission(
    db: &Db,
    plan_id: &str,
    revision: i64,
    previous: PlanStatus,
) -> Result<(), String> {
    let conn = db.0.lock();
    conn.execute(
        "UPDATE plan_reviews SET status=?1, updated_at=?2
         WHERE plan_id=?3 AND revision=?4 AND status=?5",
        rusqlite::params![
            previous.as_str(),
            now_ms(),
            plan_id,
            revision,
            PlanStatus::Submitting.as_str(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 执行状态推进（approved ≠ 执行成功；失联标 unknown，先核对上游）。
pub(crate) fn mark_execution(
    db: &Db,
    plan_id: &str,
    revision: i64,
    execution: PlanExecution,
) -> Result<(), String> {
    let conn = db.0.lock();
    conn.execute(
        "UPDATE plan_reviews SET execution=?1, updated_at=?2
         WHERE plan_id=?3 AND revision=?4",
        rusqlite::params![execution.as_str(), now_ms(), plan_id, revision],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 运行结束时这批停住的计划全部过期：原生请求随进程消失，历史 UI 不得
/// 假装还能批准（PRD §8 防线 3）。next_turn 计划没有停住的上下文，不会
/// 出现在这里。返回 (plan_id, revision, 原状态)。
pub(crate) fn expire_reviews(
    db: &Db,
    parked: &[(String, i64)],
) -> Result<Vec<(String, i64, PlanStatus)>, String> {
    if parked.is_empty() {
        return Ok(Vec::new());
    }
    let conn = db.0.lock();
    let now = now_ms();
    let mut expired = Vec::new();
    for (plan_id, revision) in parked {
        let previous = conn
            .query_row(
                "SELECT status FROM plan_reviews WHERE plan_id=?1 AND revision=?2",
                rusqlite::params![plan_id, revision],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .and_then(|s| PlanStatus::parse(&s));
        let Some(previous) = previous else { continue };
        // 只有仍开放审批的版本会过期；已决策/终态版本保持原状。
        if !matches!(
            previous,
            PlanStatus::Draft
                | PlanStatus::AwaitingReview
                | PlanStatus::Submitting
                | PlanStatus::Deferred
        ) {
            continue;
        }
        conn.execute(
            "UPDATE plan_reviews SET status=?1, updated_at=?2
             WHERE plan_id=?3 AND revision=?4",
            rusqlite::params![PlanStatus::Expired.as_str(), now, plan_id, revision],
        )
        .map_err(|e| e.to_string())?;
        expired.push((plan_id.clone(), *revision, previous));
    }
    Ok(expired)
}

/// 会话删除/工作区移除时随现有生命周期清理（PRD §4.4：删除会话后无幽灵
/// 计划；sessions 行可能晚于计划记录创建，故不用 FK 而由删除点显式清理）。
/// 调用方在既有事务/锁内传入连接（Transaction 解引用为 Connection）。
pub(crate) fn delete_reviews_for_session(
    conn: &rusqlite::Connection,
    engine: &str,
    session_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM plan_reviews WHERE engine=?1 AND session_id=?2",
        rusqlite::params![engine, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn delete_reviews_for_workspace(
    conn: &rusqlite::Connection,
    workspace_path: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM plan_reviews WHERE workspace_path=?1",
        rusqlite::params![workspace_path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(name: &str) -> (Db, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "ccgui-plan-review-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        (Db::open_at(&path).unwrap(), dir)
    }

    fn review(plan_id: &str, session: &str) -> PlanReview {
        PlanReview {
            plan_id: plan_id.into(),
            engine: "dsh".into(),
            session_id: session.into(),
            workspace_path: "/tmp/ws".into(),
            run_id: Some("run-1".into()),
            revision: 1,
            title: "测试计划".into(),
            content: "# 计划\n第一步".into(),
            content_hash: content_hash("# 计划\n第一步"),
            complete: true,
            review_kind: PlanReviewKind::NativeRequest,
            native_plan_id: Some("plan-review".into()),
            exec_permission: "auto".into(),
            status: PlanStatus::AwaitingReview,
            execution: PlanExecution::NotStarted,
            decision: None,
            decision_intent_at: None,
            applied_at: None,
            created_at: 0,
            updated_at: 0,
            superseded_by: None,
        }
    }

    #[test]
    fn new_revision_supersedes_open_versions_only() {
        let (db, dir) = temp_db("supersede");
        let r = review("p1", "s1");
        assert_eq!(record_review(&db, &r).unwrap(), 1);
        // 第二个版本:旧版本 superseded,新版本 revision=2。
        let mut r2 = review("p1", "s1");
        r2.content = "# 计划\n第一步\n第二步".into();
        r2.content_hash = content_hash(&r2.content);
        assert_eq!(record_review(&db, &r2).unwrap(), 2);
        let old = get_review(&db, "p1", 1).unwrap().unwrap();
        assert_eq!(old.status, PlanStatus::Superseded);
        assert_eq!(old.superseded_by, Some(2));
        let new = get_review(&db, "p1", 2).unwrap().unwrap();
        assert_eq!(new.status, PlanStatus::AwaitingReview);
        // 第三个版本:已 superseded 的 r1 保持原状,r2 被取代。
        assert_eq!(record_review(&db, &review("p1", "s1")).unwrap(), 3);
        let r1 = get_review(&db, "p1", 1).unwrap().unwrap();
        assert_eq!(r1.superseded_by, Some(2));
        let r2 = get_review(&db, "p1", 2).unwrap().unwrap();
        assert_eq!(r2.status, PlanStatus::Superseded);
        assert_eq!(r2.superseded_by, Some(3));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cas_claims_exactly_once_and_conflicts_afterwards() {
        let (db, dir) = temp_db("cas");
        record_review(&db, &review("p1", "s1")).unwrap();
        // 第一个提交者抢占成功。
        let first = submit_decision(&db, "p1", 1, PlanDecision::Approve, None).unwrap();
        assert!(matches!(
            first,
            SubmitOutcome::Claimed {
                previous: PlanStatus::AwaitingReview
            }
        ));
        // 双击/第二个窗口:同一 revision 不再可提交,返回冲突与当前状态。
        let second = submit_decision(&db, "p1", 1, PlanDecision::Approve, None).unwrap();
        match second {
            SubmitOutcome::Conflict(current) => {
                assert_eq!(current.status, PlanStatus::Submitting)
            }
            SubmitOutcome::Claimed { .. } => panic!("double submit must conflict"),
        }
        // 过期 revision 不是可提交版本。
        let stale = submit_decision(&db, "p1", 99, PlanDecision::Approve, None);
        assert!(stale.is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn applied_and_revert_follow_the_intent_first_rule() {
        let (db, dir) = temp_db("intent");
        record_review(&db, &review("p1", "s1")).unwrap();
        submit_decision(&db, "p1", 1, PlanDecision::Approve, None).unwrap();
        mark_applied(&db, "p1", 1, PlanDecision::Approve).unwrap();
        let approved = get_review(&db, "p1", 1).unwrap().unwrap();
        assert_eq!(approved.status, PlanStatus::Approved);
        assert!(approved.applied_at.is_some());

        record_review(&db, &review("p2", "s1")).unwrap();
        submit_decision(&db, "p2", 1, PlanDecision::Defer, None).unwrap();
        revert_submission(&db, "p2", 1, PlanStatus::AwaitingReview).unwrap();
        let reverted = get_review(&db, "p2", 1).unwrap().unwrap();
        // 写管道失败:退回待审,决策意图留存,不显示批准成功。
        assert_eq!(reverted.status, PlanStatus::AwaitingReview);
        assert!(reverted.decision_intent_at.is_some());
        assert!(reverted.applied_at.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn request_changes_requires_feedback_and_deferred_can_resubmit() {
        let (db, dir) = temp_db("feedback");
        record_review(&db, &review("p1", "s1")).unwrap();
        assert!(submit_decision(&db, "p1", 1, PlanDecision::RequestChanges, None).is_err());
        assert!(submit_decision(&db, "p1", 1, PlanDecision::RequestChanges, Some("  ")).is_err());
        // 暂不执行后可以回到同一版本继续审批。
        submit_decision(&db, "p1", 1, PlanDecision::Defer, None).unwrap();
        mark_applied(&db, "p1", 1, PlanDecision::Defer).unwrap();
        let deferred = get_review(&db, "p1", 1).unwrap().unwrap();
        assert_eq!(deferred.status, PlanStatus::Deferred);
        let resubmitted = submit_decision(&db, "p1", 1, PlanDecision::Approve, None).unwrap();
        assert!(matches!(resubmitted, SubmitOutcome::Claimed { .. }));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn incomplete_plan_never_accepts_submission() {
        let (db, dir) = temp_db("incomplete");
        let mut draft = review("p1", "s1");
        draft.complete = false;
        draft.status = PlanStatus::Draft;
        record_review(&db, &draft).unwrap();
        assert!(submit_decision(&db, "p1", 1, PlanDecision::Approve, None).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn expire_only_closes_open_versions() {
        let (db, dir) = temp_db("expire");
        record_review(&db, &review("p1", "s1")).unwrap();
        let mut approved = review("p2", "s1");
        record_review(&db, &approved).unwrap();
        submit_decision(&db, "p2", 1, PlanDecision::Approve, None).unwrap();
        mark_applied(&db, "p2", 1, PlanDecision::Approve).unwrap();
        approved.plan_id = "p2".into();
        let expired = expire_reviews(&db, &[("p1".into(), 1), ("p2".into(), 1)]).unwrap();
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].0, "p1");
        assert_eq!(
            get_review(&db, "p1", 1).unwrap().unwrap().status,
            PlanStatus::Expired
        );
        // 已批准版本不过期。
        assert_eq!(
            get_review(&db, "p2", 1).unwrap().unwrap().status,
            PlanStatus::Approved
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_follows_session_and_workspace_lifecycle() {
        let (db, dir) = temp_db("delete");
        record_review(&db, &review("p1", "s1")).unwrap();
        record_review(&db, &review("p2", "s2")).unwrap();
        {
            let conn = db.0.lock();
            delete_reviews_for_session(&conn, "dsh", "s1").unwrap();
            delete_reviews_for_workspace(&conn, "/tmp/ws-empty").unwrap();
        }
        assert!(get_review(&db, "p1", 1).unwrap().is_none());
        assert!(get_review(&db, "p2", 1).unwrap().is_some());
        {
            let conn = db.0.lock();
            delete_reviews_for_workspace(&conn, "/tmp/ws").unwrap();
        }
        assert!(get_review(&db, "p2", 1).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn records_survive_reopen() {
        let (db, dir) = temp_db("reopen");
        let path = dir.join("test.db");
        record_review(&db, &review("p1", "s1")).unwrap();
        drop(db);
        let reopened = Db::open_at(&path).unwrap();
        let loaded = get_review(&reopened, "p1", 1).unwrap().unwrap();
        assert_eq!(loaded.content, "# 计划\n第一步");
        assert_eq!(loaded.status, PlanStatus::AwaitingReview);
        assert_eq!(list_reviews(&reopened, "dsh", "s1").unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
