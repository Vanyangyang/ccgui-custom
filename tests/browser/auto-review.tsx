import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import i18n from "../../src/lib/i18n";
import { AutoReviewCard } from "../../src/features/chat/components/AutoReviewCard";
import { CodexApprovalCard } from "../../src/features/chat/components/CodexApprovalCard";
import { PermissionMenu, type ComposerPermission } from "../../src/components/application/ai-chat/permission-menu";
import { useChatStore } from "../../src/features/chat/store";
import { EMPTY_SESSION } from "../../src/features/chat/store/stream";
import { readPermissionPref } from "../../src/features/chat/store/permissions";
import { SessionScope } from "../../src/features/chat/split/session-scope";
import type { AutoReview } from "../../src/features/chat/store/auto-review";
import type { Message } from "../../src/lib/ipc";

declare global {
  interface Window {
    __autoReviewFixture: { state: { calls: unknown[]; failures: number; completed: number; failNext: boolean; delayMs: number }; notify: () => void };
  }
}

const SESSION = { engine: "codex", sessionId: "fixture-auto-review", workspacePath: "/fixture" };
const KEY = "codex/fixture-auto-review";
const LONG_COMMAND = `printf '%s\\n' '中文审批 🚀 🧪 ${"long-command-segment_".repeat(28)}' > /outside/审查结果.txt`;
const STATES: AutoReview["review"]["status"][] = ["inProgress", "approved", "denied", "timedOut", "aborted"];
const REVIEWS: Message[] = STATES.map((status, index) => ({
  seq: index + 1, role: "auto_review", text: "", ts: null,
  args: { turnId: "fixture-turn", reviewId: `fixture-review-${index}`, targetItemId: null, startedAtMs: 10,
    review: { status, riskLevel: status === "inProgress" ? null : "high", userAuthorization: "low", rationale: "工作区外写入，需要明确授权。保留中文与 emoji：🧪✅。\n此数据仅为浏览器验收样例。" },
    action: { type: "command", source: "agent", command: LONG_COMMAND, cwd: "/fixture/中文目录" } },
}));

function seed() {
  useChatStore.setState({ active: SESSION, openTabs: [SESSION], streamingByKey: { [KEY]: true },
    bySession: { [KEY]: { ...EMPTY_SESSION, streaming: true, messages: [{ seq: 1, role: "question", text: "", ts: null,
      question: { runId: "fixture-run", requestId: "fixture-permissions", status: "pending", questions: [{ question: "placeholder", header: "", options: [] }],
        codexApproval: { kind: "permissions", canApprove: true, grantScope: "turn", reason: "需要写入本次构建输出目录 / Permission for this turn only 🧩",
          details: { reason: "本轮构建输出", permissions: { fileSystem: { write: ["/outside/中文目录/" + "output_".repeat(30)] } } } } } }] } } });
}
seed();

function Fixture() {
  const [permission, setPermission] = useState<ComposerPermission>(readPermissionPref);
  const [language, setLanguage] = useState(i18n.language);
  const [, refresh] = useState(0);
  const message = useChatStore(s => s.bySession[KEY]!.messages[0]);
  const state = window.__autoReviewFixture.state;
  useEffect(() => {
    const change = () => refresh(n => n + 1);
    window.addEventListener("auto-review-fixture:change", change);
    return () => window.removeEventListener("auto-review-fixture:change", change);
  }, []);
  return <main className="min-h-dvh bg-background-primary-default p-3 text-text-primary">
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <header className="space-y-2">
        <h1 className="text-heading-3">Auto-review · 隔离浏览器验收 🧪</h1>
        <p className="text-caption-1-regular">真实组件；IPC、localStorage 与 sessionStorage 仅在本文档内模拟。不调用模型或原生应用。</p>
        <button data-testid="language" className="rounded border p-2" onClick={() => { const next = language === "en" ? "zh" : "en"; void i18n.changeLanguage(next); setLanguage(next); }}>{language === "en" ? "中文" : "English"}</button>
      </header>
      <section data-testid="permission-menu" className="space-y-2">
        <h2>默认权限 / Default permission</h2>
        <PermissionMenu supportsAutoReview value={permission} onChange={setPermission} />
        <output data-testid="permission-value">permission={permission}</output>
      </section>
      <section data-testid="approval" className="space-y-2 rounded-xl border border-border-secondary p-3">
        <h2>本轮权限请求 / Turn permission request</h2>
        <div className="flex flex-wrap gap-2">
          <button data-testid="reset" className="rounded border p-2" onClick={seed}>重置请求 / Reset</button>
          <button data-testid="fail-next" className="rounded border p-2" onClick={() => { state.failNext = true; window.__autoReviewFixture.notify(); }}>下次失败 / Fail next</button>
        </div>
        <SessionScope session={SESSION}><CodexApprovalCard message={message} /></SessionScope>
        <output data-testid="ipc-readout" className="block break-all text-caption-1-regular">
          {JSON.stringify({ calls: state.calls.length, failures: state.failures, completed: state.completed, failNext: state.failNext, status: message.question?.status, submitting: !!message.question?.submitting, decision: message.question?.answers?.decision ?? null })}
        </output>
      </section>
      <section data-testid="review-states" className="flex min-w-0 flex-col gap-3">
        <h2>审查状态 / Review states</h2>
        {REVIEWS.map(message => <div data-testid={`review-${(message.args as AutoReview).review.status}`} key={message.seq}><AutoReviewCard message={message} /></div>)}
      </section>
    </div>
  </main>;
}

createRoot(document.getElementById("fixture")!).render(<Fixture />);
