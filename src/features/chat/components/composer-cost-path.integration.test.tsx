import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import type { SessionMeta, Workspace } from "@/lib/ipc";
import { invoke } from "@/lib/transport";
import i18n from "@/lib/i18n";
import { sessionKey, useChatStore, type ActiveSession } from "../store";
import { EMPTY_SESSION, runRouting } from "../store/stream";
import { useSessionSendCostGuardStore } from "../cross-session-cost";
import { ChatConversation } from "./ChatConversation";
import { SessionSendCostApproval } from "./CrossSessionCostApproval";

vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(), listen: vi.fn(async () => () => {}), webToken: null }));
vi.mock("@/features/agents/selected-agent", () => ({ getSelectedAgent: () => null, clearSelectedAgent: vi.fn(), migrateSelectedAgent: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/application/ai-chat/cli-menu", () => ({ CliMenu: () => null }));
vi.mock("@/components/application/ai-chat/add-menu", () => ({ AddMenu: () => null }));
vi.mock("@/components/application/ai-chat/permission-menu", () => ({ PermissionMenu: () => null }));
vi.mock("./use-branch-switcher", () => ({ useBranchSwitcher: () => ({}) }));
vi.mock("./use-engine-models", () => ({ useEngineModels: () => ({ catalogs: {}, modelsByEngine: {}, channelsByEngine: {}, pendingEngines: {}, refresh: vi.fn() }) }));
vi.mock("./MessageTimeline", () => ({ MessageTimeline: () => null }));
// As in composer-draft.test.tsx, replace only footer chrome. The conversation,
// composer hooks, messaging store and displayed cost approval remain real.
vi.mock("./ConversationFooter", () => ({ ConversationFooter: (props: {
  active: ActiveSession | null; onSubmit: (value: string) => void;
}) => {
  const key = props.active ? sessionKey(props.active.engine, props.active.sessionId, props.active.workspacePath) : "";
  const draft = useChatStore(s => s.drafts[key] ?? "");
  return <div>
    <textarea aria-label="draft" value={draft} readOnly />
    <button onClick={() => props.onSubmit(draft)}>submit</button>
    <SessionSendCostApproval active={props.active} />
  </div>;
} }));

const prompt = "Continue the user task";
const workspace: Workspace = { id: "cost-path", path: "G:\\project", name: "project", lastOpenedAt: null, sortOrder: null, groupId: null };
let node: HTMLDivElement;
let root: Root;
const nativeSends = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "send_message" || cmd === "send_leader_message");
const approval = () => node.querySelector('[data-testid="session-send-cost-approval"]');

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); localStorage.clear(); runRouting.clear();
  useSessionSendCostGuardStore.getState().reset();
  await i18n.changeLanguage("en");
  vi.mocked(invoke).mockImplementation(async (cmd, args) =>
    cmd === "send_message" || cmd === "send_leader_message" ? { runId: args!.runId, sessionId: "cost-session" }
      : cmd === "read_file" ? { kind: "other" }
        : cmd === "load_session_page" ? { messages: [], nextBefore: null, subagentHistory: [] } : undefined);
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount()); node.remove();
  useSessionSendCostGuardStore.getState().reset();
  vi.restoreAllMocks();
});

async function submit({ engine = "claude", used = 50_000, metadataPath = "G:/project", cache = "cold" }: {
  engine?: "claude" | "codex"; used?: number; metadataPath?: string | null; cache?: "cold" | "unknown";
} = {}) {
  const model = engine === "codex" ? "gpt-6-astra" : "claude-sonnet-4-6";
  const active: ActiveSession = { engine, sessionId: "cost-session", workspacePath: workspace.path, model };
  const key = sessionKey(engine, active.sessionId, active.workspacePath);
  const usage = { input_tokens: used };
  const meta = { engine, sessionId: active.sessionId, workspacePath: metadataPath, model,
    updatedAt: Date.now() - 7_200_000,
    promptCache: cache === "unknown" ? null : {
      startedAt: Date.now() - 7_200_000, observedAt: Date.now() - 7_100_000,
      ttlSeconds: 300, source: "anthropic-usage",
    },
  } as SessionMeta;
  useChatStore.setState({ initialized: true, active, openTabs: [active], activeEngine: engine,
    workspaces: [workspace], sessions: metadataPath === null ? [] : [meta], drafts: { [key]: prompt },
    bySession: { [key]: { ...EMPTY_SESSION, usage, messages: [{ seq: 1, role: "assistant", text: "Prior answer", ts: null, model, usage }] } },
    streamingByKey: {}, retryingByKey: {}, archivedSessionKeys: {}, unseen: {}, models: { [engine]: model },
    efforts: {}, providers: {}, permission: "manual",
    engines: [{ id: engine, available: true, enabled: true, supportsImages: true, permissions: ["manual"] }],
  });
  const state = useChatStore.getState();
  await act(async () => root.render(<ChatConversation active={active} engines={state.engines}
    workspaces={state.workspaces} startNewChat={state.startNewChat} composerInputRef={createRef<ComposerInputHandle>()} />));
  await act(async () => node.querySelector<HTMLButtonElement>("button")!.click());
  return key;
}

function expectSent() {
  expect(nativeSends()).toHaveLength(1);
  expect(nativeSends()[0][1]).toMatchObject({ prompt, workspacePath: workspace.path });
  expect(approval()).toBeNull();
  expect(useSessionSendCostGuardStore.getState().bySessionKey).toEqual({});
  expect(node.querySelector("textarea")!.value).toBe("");
}

describe("ordinary composer cost review across Windows path spellings", () => {
  it("holds measured Claude 50k with cold cache and displays review without sending", async () => {
    const key = await submit();
    expect(nativeSends()).toHaveLength(0);
    expect(useSessionSendCostGuardStore.getState().bySessionKey[key]).toMatchObject({
      prompt, workspacePath: workspace.path, mode: "send",
      review: { cacheHeat: "cold", context: { used: 50_000, modelMismatch: false } },
    });
    expect(approval()).not.toBeNull();
    expect(node.textContent).toContain(i18n.t("crossSession.selfCostApprovalPending"));
    expect(node.querySelector("textarea")!.value).toBe(prompt);
  });

  it("sends measured Claude 49,999 with the same cold aliased metadata", async () => {
    await submit({ used: 49_999 }); expectSent();
  });

  it.each(["unknown", "cold"] as const)("sends Codex GPT with %s cache across path aliases", async cache => {
    await submit({ engine: "codex", cache }); expectSent();
  });

  it("does not borrow cold metadata from another workspace with the same engine/session id", async () => {
    await submit({ metadataPath: "G:/other" }); expectSent();
  });

  it("preserves the existing send behavior when session metadata is absent", async () => {
    await submit({ metadataPath: null }); expectSent();
  });
});
