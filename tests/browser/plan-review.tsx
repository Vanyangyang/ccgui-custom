// Open /tests/browser/plan-review.html with the Vite dev server running.
// Static visual acceptance for the plan preview & approval UI: timeline
// cards in every lifecycle state, the approval dock over the composer, and
// a long Markdown plan (Chinese / emoji / table / code /超长文) both inline
// and in the full-preview overlay. No model, no IPC, no saved conversation.
import { useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import type { PlanReview } from "../../src/lib/ipc";
import { useChatStore } from "../../src/features/chat/store";
import { EMPTY_SESSION } from "../../src/features/chat/store/stream";
import { sessionKey } from "../../src/features/chat/store/persistence";
import { PlanReviewCard } from "../../src/features/chat/components/PlanReviewCard";
import {
  PlanReviewDock,
  usePendingPlanReview,
} from "../../src/features/chat/components/PlanReviewDock";
import { PlanPreviewOverlay } from "../../src/features/chat/components/PlanReviewCard";
import Markdown from "../../src/features/chat/components/Markdown";

const LONG_PLAN = `# 桌面端计划审批改造方案 🚀

> 目标:五引擎统一的计划预览与人工审批,批准只适用于用户看到的完整版本。

## 背景

当前 OMP 会自动批准计划,需要改为原生等待 + 用户显式决策。涉及事件、持久化、UI 三层。

## 分阶段实施 ✅

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| P1 | 审批主干(plan_review 表 + CAS) | 并发仲裁测试通过 |
| P2 | 统一 UI(卡片 + Dock) | 模拟全生命周期可操作 |
| P3 | OMP ACP 接入 | 实机闭环 |
| P4 | Codex / DSH | 两种生命周期均通过 |

## 关键代码

\`\`\`rust
pub(crate) fn submit_decision(
    db: &Db,
    plan_id: &str,
    expected_revision: i64,
    decision: PlanDecision,
    feedback: Option<&str>,
) -> Result<PlanReview, SubmitError> {
    // 原子抢占:重复点击返回相同结果或明确冲突
    db.cas_submit(plan_id, expected_revision, decision, feedback)
}
\`\`\`

## 风险与防线

1. **等待期不得实施** —— 文件哨兵证明批准前工程无改动。
2. **双击 / 多窗口** —— expectedRevision CAS,只有一个提交者。
3. **恢复误批准** —— 活跃请求核对原生状态,失效即 expired。

详见 [PRD](../.omx/plans/prd-plan-approval-2026-09-22.md)。
`;

// 超长文:重复章节让预览面板真正需要滚动。
const VERY_LONG_PLAN = Array.from(
  { length: 12 },
  (_, i) =>
    `\n## 第 ${i + 1} 阶段:模块 ${String.fromCharCode(65 + i)} 改造\n\n- 子任务 ${i + 1}.1:梳理现状与调用方\n- 子任务 ${i + 1}.2:实现并补测试\n- 子任务 ${i + 1}.3:回归验证 🔍\n\n\`\`\`sh\ncargo test --lib module_${String.fromCharCode(97 + i)}\n\`\`\`\n`,
).join("");

const FULL_CONTENT = LONG_PLAN + VERY_LONG_PLAN;

function recordOf(over: Partial<PlanReview>): PlanReview {
  return {
    planId: "fixture-plan",
    engine: "omp",
    sessionId: "fixture-session",
    workspacePath: "/tmp/fixture",
    runId: "fixture-run",
    revision: 1,
    title: "桌面端计划审批改造",
    content: FULL_CONTENT,
    contentHash: "fixture",
    complete: true,
    reviewKind: "native_request",
    nativePlanId: null,
    execPermission: "manual",
    status: "awaiting_review",
    execution: "not_started",
    decisionIntentAt: null,
    appliedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    supersededBy: null,
    ...over,
    revision: over.revision ?? 1,
  };
}

const AWAITING = recordOf({ revision: 2, status: "awaiting_review" });
const CARDS: PlanReview[] = [
  recordOf({
    revision: 0,
    status: "draft",
    complete: false,
    title: "",
    content: "# 桌面端计划审批改造方案 🚀\n\n> 目标:五引擎统一的计划预览……(规划中,正文持续更新)",
  }),
  AWAITING,
  recordOf({ revision: 1, status: "superseded", supersededBy: 2 }),
  recordOf({ revision: 3, status: "approved", execution: "running" }),
  recordOf({ revision: 4, status: "expired", title: "已失效的旧计划" }),
];

const KEY = sessionKey("claude", "fixture-session", "/tmp/fixture");

// Seed the store so the dock resolves its pending plan exactly like the app.
useChatStore.setState({
  openTabs: [{ engine: "claude", sessionId: "fixture-session", workspacePath: "/tmp/fixture" }],
  active: { engine: "claude", sessionId: "fixture-session", workspacePath: "/tmp/fixture" },
  bySession: {
    [KEY]: {
      ...EMPTY_SESSION,
      streaming: true,
      messages: [
        { seq: 1, role: "user", text: "帮我做计划审批改造", ts: null },
        { seq: 2, role: "plan_review", text: AWAITING.title, ts: null, planReview: AWAITING },
      ],
    },
  },
  streamingByKey: { [KEY]: true },
});

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-body-2-medium text-text-secondary">{title}</h2>
      {children}
    </section>
  );
}

function DockProbe() {
  // Readout proving the dock resolves the same pending record as the app.
  const pending = usePendingPlanReview();
  return (
    <div data-testid="pending-readout" className="text-caption-1-regular text-text-tertiary">
      pending: {pending?.planReview ? `${pending.planReview.planId} v${pending.planReview.revision} (${pending.planReview.status})` : "null"}
    </div>
  );
}

function Fixture() {
  const [overlayOpen, setOverlayOpen] = useState(false);
  return (
    <div className="min-h-dvh bg-background-primary-default px-4 py-8">
      <div className="mx-auto flex max-w-[750px] flex-col gap-8">
        <Section title="时间线卡片(draft / awaiting / superseded / approved / expired)">
          {CARDS.map((record) => (
            <PlanReviewCard
              key={`${record.planId}-${record.revision}-${record.status}`}
              message={{ seq: record.revision + 10, role: "plan_review", text: record.title, ts: null, planReview: record }}
              workspacePath="/tmp/fixture"
            />
          ))}
        </Section>
        <Section title="审批 Dock(覆盖输入区)">
          <PlanReviewDock />
          <DockProbe />
        </Section>
        <Section title="长 Markdown 预览(中文 / emoji / 表格 / 代码块 / 超长文)">
          <div className="max-h-[480px] overflow-y-auto rounded-xl border border-border-secondary px-4 py-3">
            <Markdown text={FULL_CONTENT} workspacePath="/tmp/fixture" />
          </div>
          <div>
            <button
              type="button"
              onClick={() => setOverlayOpen(true)}
              className="cursor-pointer rounded-md border border-border-secondary bg-background-secondary-default px-2.5 py-1 text-caption-1-medium text-text-secondary hover:bg-background-tertiary-hover"
            >
              打开完整预览(侧面板)
            </button>
          </div>
        </Section>
      </div>
      {overlayOpen && (
        <PlanPreviewOverlay
          record={AWAITING}
          workspacePath="/tmp/fixture"
          onClose={() => setOverlayOpen(false)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("fixture")!).render(<Fixture />);
