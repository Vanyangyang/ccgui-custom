import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import i18n from "@/lib/i18n";
import { sessionKey, useChatStore } from "./store";
import { EMPTY_SESSION } from "./store/stream";
import { HANDOFF_PREFERENCES_KEY } from "./handoff-preferences";
import { replaceHandoffDraftSummary, useHandoffStore } from "./session-cleanup";
import { HandoffOverlayCard } from "./components/HandoffOverlayCard";

vi.mock("./components/HandoffCompressionControls", () => ({ HandoffCompressionControls: () => null }));
vi.mock("./components/HandoffWorkspaceControl", () => ({ HandoffWorkspaceControl: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const original = useChatStore.getState();
const workspacePath = "/handoff-retry";
const key = sessionKey("codex", null, workspacePath);
const args = {
  workspacePath, sourceEngine: "codex", sourceSessionId: "source-session", sourceTitle: "Source",
  initialMode: "grok" as const,
  sourceState: { ...EMPTY_SESSION, messages: [{ seq: 1, ts: "1", role: "assistant" as const, text: "本地结论 😀" }] },
};
const diagnostic = "codex handoff summary failed [stage=auth_snapshot; diagnostic_id=retry-fixture]";
const entry = () => useHandoffStore.getState().byWorkspace[workspacePath];
const draft = () => useChatStore.getState().drafts[key];
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  localStorage.removeItem(HANDOFF_PREFERENCES_KEY);
  useHandoffStore.setState({ byWorkspace: {} });
  useChatStore.setState({ ...original, activeEngine: "codex", active: null, openTabs: [], drafts: {},
    sessions: [], bySession: {}, streamingByKey: {}, retryingByKey: {} });
  vi.spyOn(ipc, "taskSnapshot").mockResolvedValue({ leaders: [], branches: [] });
  vi.spyOn(ipc, "handoffFullHistorySupported").mockResolvedValue(true);
  vi.spyOn(ipc, "summarizeSessionHandoff").mockRejectedValueOnce(new Error(diagnostic));
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container.remove();
  useHandoffStore.setState({ byWorkspace: {} });
  useChatStore.setState(original);
  vi.restoreAllMocks();
  localStorage.removeItem(HANDOFF_PREFERENCES_KEY);
});

async function mountFailedHandoff() {
  useHandoffStore.getState().startHandoff(args);
  await vi.waitFor(() => expect(entry()).toMatchObject({ grokStatus: "error", compressionRunning: false }));
  root = createRoot(container);
  await act(async () => root!.render(<HandoffOverlayCard active={useChatStore.getState().active} />));
}

it.each(["\n", "\r\n"])("retries from the card after editing the next-task line without a colon (%j)", async newline => {
  await mountFailedHandoff();
  const nextTask = `接下来请继续完成剩余任务 😀${newline}保留这一行`;
  const edited = draft().replace("接下来请继续：", nextTask).replace(/\r?\n/g, newline);
  await act(async () => useChatStore.getState().setDraft(key, edited));
  let resolve!: (value: string) => void;
  vi.mocked(ipc.summarizeSessionHandoff).mockReturnValueOnce(new Promise<string>(yes => { resolve = yes; }));
  try {
    await act(async () => (container.querySelector('[data-testid="handoff-grok-retry-btn"]') as HTMLButtonElement).click());
    expect(ipc.summarizeSessionHandoff).toHaveBeenCalledTimes(2);
    expect(entry().grokStatus).toBe("running");
    expect(container.querySelector('[data-testid="handoff-grok-stop-btn"]')).not.toBeNull();
    await act(async () => { resolve("完整提炼结果"); });
    expect(entry()).toMatchObject({ grokStatus: "done", compressionRunning: false, grokError: null });
    expect(draft()).toContain("> 完整提炼结果");
    expect(draft()).not.toContain("本地结论");
    expect(draft().endsWith(nextTask)).toBe(true);
  } finally {
    await act(async () => { resolve("cleanup"); });
  }
});

it("shows failure details without requiring a hover", async () => {
  await mountFailedHandoff();
  expect(container.querySelector('[data-testid="handoff-compression-error"]')?.textContent).toBe(diagnostic);
});

it("explains why retry cannot start after the handoff structure is removed", async () => {
  await mountFailedHandoff();
  await act(async () => useChatStore.getState().setDraft(key, "用户已替换整份草稿 😀"));
  await act(async () => (container.querySelector('[data-testid="handoff-grok-retry-btn"]') as HTMLButtonElement).click());
  expect(ipc.summarizeSessionHandoff).toHaveBeenCalledTimes(1);
  expect(entry()).toMatchObject({ grokStatus: "error", compressionRunning: false });
  expect(container.querySelector('[data-testid="handoff-compression-error"]')?.textContent).toBe(i18n.t("chat.handoffDraftStructureChanged"));
  expect(draft()).toBe("用户已替换整份草稿 😀");
});

it("does not mistake a quoted next-task phrase for the editable footer", () => {
  const text = "承接上一会话「Source」（codex/source-s）：\n\n上一会话最后结论摘要：\n> 接下来请继续处理旧任务\n> 本地结论\n\n接下来请继续完成剩余任务";
  expect(replaceHandoffDraftSummary(text, "完整提炼结果")).toBe(
    "承接上一会话「Source」（codex/source-s）：\n\n上一会话交接摘要（模型提炼）：\n> 完整提炼结果\n\n接下来请继续完成剩余任务",
  );
});
