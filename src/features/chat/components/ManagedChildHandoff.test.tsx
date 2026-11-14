import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import i18n from "@/lib/i18n";
import { ipc, type SessionMeta } from "@/lib/ipc";
import { ManagedChildHandoff } from "./ManagedChildHandoff";
import type { CrossSessionCommunicationRecord } from "../cross-session";
import type { ActiveSession } from "../store";
import { sessionKey } from "../store/persistence";
import { confirmHost as confirm } from "@/features/host-confirmation/request";
import { webcrypto } from "node:crypto";
import { createManagedChildSummaryService, type ManagedChildSummaryService } from "../managed-child-summary";
import type { HandoffModelPickerProps } from "./HandoffCompressionControls";
import type { ManagedChildTargetPickerProps } from "./ManagedChildTargetPicker";
import { invoke } from "@/lib/transport";
import { resolveHandoffTargetSelection } from "@/features/leader/cost-approval";
import type { HostTaskSelection } from "@ccgui/plugin-sdk";

vi.mock("@/lib/transport", () => ({ invoke: vi.fn(), isWeb: false, listen: vi.fn(async () => () => {}) }));
vi.mock("@/features/leader/cost-approval", () => ({ resolveHandoffTargetSelection: vi.fn() }));
vi.mock("./ManagedChildTargetPicker", () => ({ ManagedChildTargetPicker: ({ disabled, supported, onChange }: ManagedChildTargetPickerProps) => <button
  data-testid="target-picker" disabled={disabled || !supported} onClick={() => onChange({ engine: "codex", model: "new-child", providerId: "relay", effort: "high" })}>target</button> }));
vi.mock("@/features/host-confirmation/request", async (original) => ({ ...await original<typeof import("@/features/host-confirmation/request")>(), confirmHost: vi.fn() }));
vi.mock("./HandoffCompressionControls", () => ({ HandoffModelPicker: ({ selection, onSelectionChange, disabled }: HandoffModelPickerProps) => <button disabled={disabled}
  data-testid="compression-picker" onClick={() => onSelectionChange({ engine: "claude", model: selection.model === "chosen-summary-model" ? "another-summary-model" : "chosen-summary-model", providerId: "relay", effort: "high" })}>{selection.model}</button> }));
const chat = vi.hoisted(() => ({ sessions: [] as SessionMeta[], openTabs: [] as ActiveSession[], archivedSessionKeys: {} as Record<string, boolean> }));
vi.mock("../store", async () => ({
  useChatStore: Object.assign((selector: (state: typeof chat) => unknown) => selector(chat), { getState: () => chat }),
  sessionKey: (await import("../store/persistence")).sessionKey,
}));
const target = { engine: "claude", sessionId: "child", workspacePath: "/project", title: "Child" };
const record = (): CrossSessionCommunicationRecord => ({
  scopedId: "held-1", requestId: "request-1", sender: { ...target, sessionId: "parent" }, target,
  message: "完整待发原文🙂\n" + "x".repeat(1400), status: "awaiting_cost_approval", acceptedAt: 1, updatedAt: 1,
  leaderCostApproval: { branchId: "branch", requestId: "approval", model: "source-model" },
});
const page = () => ({ messages: [{ role: "user", text: "已核对接口" }, { role: "assistant", text: "继续实现测试🙂" }], hasMore: false }) as unknown as Awaited<ReturnType<typeof ipc.loadSessionPage>>;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
let node: HTMLDivElement, root: Root;
let load: MockInstance<typeof ipc.loadSessionPage>;
let compress: MockInstance<typeof ipc.summarizeSessionHandoff>;
let service: ManagedChildSummaryService;
let currentRecord: CrossSessionCommunicationRecord;
const compressed = "继续实现测试🙂，压缩后的子会话摘要";
const onSubmit = vi.fn<(summary: string, selection?: HostTaskSelection) => Promise<void>>(), onCancel = vi.fn();
const button = (key: string) => [...node.querySelectorAll("button")].find(item => item.textContent === i18n.t(`crossSession.${key}`))!;
const editor = () => node.querySelector("textarea")!;
async function render(value = record(), generate = true) {
  currentRecord = value;
  await act(async () => root.render(<ManagedChildHandoff record={value} onSubmit={onSubmit} onCancel={onCancel} summaryService={service} />));
  if (generate && button("managedHandoffGenerate")) await act(async () => button("managedHandoffGenerate").click());
}
async function status(value: string) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(node.textContent).toContain(i18n.t(`crossSession.managedHandoffCompression_${value}`));
  });
}
async function edit(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), value);
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  vi.mocked(invoke).mockResolvedValue(true);
  vi.mocked(resolveHandoffTargetSelection).mockImplementation(async value => ({ ...value }));
  vi.stubGlobal("crypto", webcrypto);
  chat.sessions = [{ ...target, remote: false, filePath: "/history", fileSize: 10, fileMtimeMs: 1, updatedAt: 1 } as unknown as SessionMeta];
  chat.openTabs = []; chat.archivedSessionKeys = {};
  load = vi.spyOn(ipc, "loadSessionPage").mockResolvedValue(page());
  compress = vi.spyOn(ipc, "summarizeSessionHandoff").mockResolvedValue(compressed);
  const records = new Map<string, string>();
  service = createManagedChildSummaryService({
    storage: { getItem: key => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value); } },
    currentRecord: () => currentRecord, summarize: ipc.summarizeSessionHandoff, fullHistorySupported: async () => true,
    preferences: () => ({ enabled: false, model: "compress-model", selection: { engine: "cursor", model: "compress-model" } }),
    checkpoint: { assertAllowed: vi.fn(), registerBlocker: () => () => {} },
  });
  onSubmit.mockResolvedValue(undefined);
  vi.mocked(confirm).mockResolvedValue(true);
  await i18n.changeLanguage("en");
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("managed child handoff draft", () => {
  it("selects the replacement model independently and preserves generated summary and source approval", async () => {
    const original = record();
    await render(original); await status("completed");
    await act(async () => (node.querySelector('[data-testid="target-picker"]') as HTMLButtonElement).click());
    expect(editor().value).toBe(compressed);
    expect(compress).toHaveBeenCalledOnce();
    await act(async () => button("managedHandoffSubmit").click());
    const selected = { engine: "codex", model: "new-child", providerId: "relay", effort: "high" };
    expect(resolveHandoffTargetSelection).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(compressed, selected);
    expect(original.leaderCostApproval?.model).toBe("source-model");
  });
  it("blocks a target that resolves differently after confirmation while keeping the summary editable", async () => {
    await render(); await status("completed");
    await act(async () => (node.querySelector('[data-testid="target-picker"]') as HTMLButtonElement).click());
    vi.mocked(resolveHandoffTargetSelection).mockResolvedValueOnce({ engine: "codex", model: "new-child", providerId: "relay", effort: "high" })
      .mockResolvedValueOnce({ engine: "codex", model: "changed", providerId: "relay", effort: "high" });
    await act(async () => button("managedHandoffSubmit").click());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor().value).toBe(compressed); expect(editor().disabled).toBe(false);
  });
  it("disables target changes on an older host while allowing inherited submission", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("unknown command"));
    await render(); await status("completed");
    expect((node.querySelector('[data-testid="target-picker"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => button("managedHandoffSubmit").click());
    expect(resolveHandoffTargetSelection).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(compressed);
  });
  it("freezes the replacement target after an uncertain submission and rejects changed resolution on retry", async () => {
    await render(); await status("completed");
    await act(async () => (node.querySelector('[data-testid="target-picker"]') as HTMLButtonElement).click());
    onSubmit.mockRejectedValueOnce(new Error("transport outcome unknown"));
    await act(async () => button("managedHandoffSubmit").click());
    expect(editor().disabled).toBe(true);
    expect((node.querySelector('[data-testid="target-picker"]') as HTMLButtonElement).disabled).toBe(true);
    vi.mocked(resolveHandoffTargetSelection).mockResolvedValue({ engine: "codex", model: "changed", providerId: "relay", effort: "high" });
    await act(async () => button("managedHandoffSubmit").click());
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(editor().value).toBe(compressed);
  });
  it("shows original image count in both preparation and native confirmation without exposing image references", async () => {
    const original = { ...record(), imageRefs: [`task-image:${"a".repeat(64)}`, `task-image:${"b".repeat(64)}`] };
    await render(original); await status("completed");
    expect(node.textContent).toContain(i18n.t("crossSession.managedHandoffImages", { count: 2 }));
    await act(async () => button("managedHandoffSubmit").click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(vi.mocked(confirm).mock.calls[0][0].fields).toContainEqual({ label: "Pending images", value: "2 · sent with the original assignment" });
    expect(vi.mocked(confirm).mock.calls[0][0].sections[0].body).toBe(original.message);
    expect(vi.mocked(confirm).mock.calls[0][0].sections[1].body).toBe(compressed);
    expect(node.textContent).not.toContain(original.imageRefs[0]);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(compressed);
  });
  it("prepares without a paid call and uses the chosen summary model only after generation", async () => {
    const prepare = vi.spyOn(service, "prepare");
    await render(record(), false);
    expect(prepare).not.toHaveBeenCalled();
    expect(compress).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => (node.querySelector('[data-testid="compression-picker"]') as HTMLButtonElement).click());
    expect(compress).not.toHaveBeenCalled();
    await act(async () => button("managedHandoffGenerate").click());
    await status("completed");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(compress).toHaveBeenCalledWith(expect.objectContaining({ historyScope: "full", compressionSelection: {
      engine: "claude", model: "chosen-summary-model", providerId: "relay", effort: "high",
    } }));
    expect(node.textContent).toContain("source-model");
    await act(async () => (node.querySelector('[data-testid="compression-picker"]') as HTMLButtonElement).click());
    expect(compress).toHaveBeenCalledTimes(1); expect(editor().value).toBe(compressed);
    expect(node.textContent).toContain(i18n.t("crossSession.managedHandoffSelectionChanged"));
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("generates full-history compression beyond the editor limit and keeps the complete new task separate", async () => {
    load.mockResolvedValue({ ...page(), messages: [{ seq: 1, ts: null, role: "assistant", text: "旧历史".repeat(6000) + "最新约束仍需保留🙂" }] });
    const original = record(); await render(original); await status("completed");
    expect(compress).toHaveBeenCalledOnce();
    expect(compress.mock.calls[0][0]).toMatchObject({ historyScope: "full" });
    expect(compress.mock.calls[0][0]).not.toHaveProperty("transcriptExcerpt");
    expect(editor().value).toBe(compressed);
    expect(node.querySelector("pre")!.textContent).toBe(original.message);
    expect(onSubmit).not.toHaveBeenCalled(); expect(onCancel).not.toHaveBeenCalled();
  });
  it("keeps preparation unsent while permitting manual edits", async () => {
    const gate = deferred<void>();
    const prepare = service.prepare.bind(service);
    vi.spyOn(service, "prepare").mockImplementation(async (...args) => { await gate.promise; return prepare(...args); });
    await render(); await edit("准备期间手改");
    expect(editor().disabled).toBe(false);
    expect(button("managedHandoffSubmit").disabled).toBe(true);
    await act(async () => button("managedHandoffSubmit").click());
    expect(confirm).not.toHaveBeenCalled(); expect(onSubmit).not.toHaveBeenCalled();
    expect(compress).not.toHaveBeenCalled();
    await act(async () => gate.resolve()); await status("completed");
    expect(editor().value).toBe("准备期间手改");
  });

  it("lets manual edits survive running compression and explicit result discard", async () => {
    const gate = deferred<string>(); compress.mockReturnValue(gate.promise);
    const held = record(); await render(held); await status("running");
    expect((node.querySelector('[data-testid="compression-picker"]') as HTMLButtonElement).disabled).toBe(true);
    await edit("保留人工摘要🙂");
    expect(editor().disabled).toBe(false); expect(button("managedHandoffSubmit").disabled).toBe(true);
    await act(async () => button("managedHandoffSubmit").click());
    expect(confirm).not.toHaveBeenCalled(); expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => button("managedHandoffCompressionDiscard").click());
    await status("discarded");
    await act(async () => gate.resolve("不应采用的晚到结果"));
    expect(editor().value).toBe("保留人工摘要🙂");
    expect(node.querySelector("pre")!.textContent).toBe(held.message);
    expect(button("managedHandoffSubmit").disabled).toBe(false);
    await act(async () => button("managedHandoffSubmit").click());
    expect(confirm).toHaveBeenCalledOnce(); expect(onSubmit).toHaveBeenCalledExactlyOnceWith("保留人工摘要🙂");
  });

  it("blocks unknown compression until explicit discard without blocking editing", async () => {
    vi.spyOn(service, "prepare").mockResolvedValue({ handoffId: "unknown-child", requestId: "unknown-request", revision: 2,
      status: "unknown", selection: { engine: "cursor", model: "compress-model" } });
    vi.spyOn(service, "discard").mockResolvedValue({ handoffId: "unknown-child", requestId: "unknown-request", revision: 3,
      status: "discarded", selection: { engine: "cursor", model: "compress-model" } });
    await render(); await status("unknown"); await edit("手工恢复摘要");
    expect((node.querySelector('[data-testid="compression-picker"]') as HTMLButtonElement).disabled).toBe(true);
    expect(editor().disabled).toBe(false); expect(button("managedHandoffSubmit").disabled).toBe(true);
    await act(async () => button("managedHandoffSubmit").click());
    expect(onSubmit).not.toHaveBeenCalled(); expect(compress).not.toHaveBeenCalled();
    await act(async () => button("managedHandoffCompressionDiscard").click());
    await status("discarded"); expect(editor().value).toBe("手工恢复摘要");
    expect(button("managedHandoffSubmit").disabled).toBe(false);
  });

  it("ignores compression completion after closing an otherwise mounted editor", async () => {
    const gate = deferred<string>(); compress.mockReturnValue(gate.promise);
    await render(); await status("running"); await edit("关闭时的文本");
    await act(async () => button("managedHandoffClose").click());
    await act(async () => gate.resolve("晚到的摘要"));
    expect(editor().value).toBe("关闭时的文本"); expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["", "bad\0summary", "🙂".repeat(4001)])("reports invalid compression as a failure (%#)", async result => {
    compress.mockResolvedValue(result);
    await render(); await status("failed");
    expect(editor().value).toBe(""); expect(button("managedHandoffSubmit").disabled).toBe(true);
    expect(node.textContent).not.toContain(i18n.t("crossSession.managedHandoffCompression_completed"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("requires native system confirmation and leaves the draft editable on dismissal", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false);
    await render(); await status("completed"); await edit("明确的人工摘要");
    await act(async () => button("managedHandoffSubmit").click());
    expect(confirm).toHaveBeenCalledOnce(); expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled(); expect(editor().value).toBe("明确的人工摘要");
    expect(editor().disabled).toBe(false);
    await act(async () => button("managedHandoffSubmit").click());
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("明确的人工摘要");
  });
  it("reads local history, preserves the complete original and requires explicit submission", async () => {
    const held = record();
    await render(held);
    await status("completed");
    expect(load).toHaveBeenCalledExactlyOnceWith("claude", "child", 40);
    expect(editor().value).toContain("继续实现测试🙂");
    expect(node.querySelector("pre")!.textContent).toBe(held.message);
    expect(node.textContent).toContain("source-model");
    expect(node.textContent).toContain("compress-model");
    expect(editor().value).toBe(compressed);
    expect(compress).toHaveBeenCalledExactlyOnceWith({ engine: "claude", sessionId: "child", title: "Child",
      historyScope: "full", compressionSelection: { engine: "cursor", model: "compress-model" } });
    expect(compress.mock.calls[0][0]).not.toHaveProperty("transcriptExcerpt");
    expect(onSubmit).not.toHaveBeenCalled(); expect(onCancel).not.toHaveBeenCalled();
    await act(async () => button("managedHandoffSubmit").click());
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(editor().value);
  });

  it("does not overwrite manual edits with delayed local history", async () => {
    const gate = deferred<Awaited<ReturnType<typeof ipc.loadSessionPage>>>(); load.mockReturnValue(gate.promise);
    await render();
    expect(node.textContent).toContain(i18n.t("crossSession.managedHandoffLoading"));
    await edit("人工摘要🙂");
    await act(async () => gate.resolve(page()));
    await act(async () => button("managedHandoffGenerate").click());
    await status("completed");
    expect(editor().value).toBe("人工摘要🙂");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ignores history arriving after close even if the caller has not unmounted", async () => {
    const gate = deferred<Awaited<ReturnType<typeof ipc.loadSessionPage>>>(); load.mockReturnValue(gate.promise);
    await render();
    await act(async () => button("managedHandoffClose").click());
    await act(async () => gate.resolve(page()));
    expect(editor().value).toBe(""); expect(onCancel).toHaveBeenCalledOnce();
    await edit("closed");
    await act(async () => button("managedHandoffSubmit").click());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "workspace", "tab", "archived", "remote", "missing"])("does not read ambiguous or unavailable history: %s", async condition => {
    if (condition === "duplicate") chat.sessions.push({ ...chat.sessions[0] });
    if (condition === "workspace") chat.sessions[0] = { ...chat.sessions[0], workspacePath: "/other" };
    if (condition === "tab") chat.openTabs = [{ ...target, workspacePath: "/other" }];
    if (condition === "archived") chat.archivedSessionKeys[sessionKey(target.engine, target.sessionId, target.workspacePath)] = true;
    if (condition === "remote") chat.sessions[0] = { ...chat.sessions[0], remote: true };
    if (condition === "missing") chat.sessions = [];
    await render();
    expect(load).not.toHaveBeenCalled();
    expect(compress).not.toHaveBeenCalled();
    expect(node.textContent).toContain(i18n.t("crossSession.managedHandoffUnavailable"));
    await edit("人工补充");
    expect(button("managedHandoffSubmit").disabled).toBe(false);
  });

  it("rechecks identity after the asynchronous history read", async () => {
    const gate = deferred<Awaited<ReturnType<typeof ipc.loadSessionPage>>>(); load.mockReturnValue(gate.promise);
    await render(); chat.openTabs = [{ ...target, workspacePath: "/other" }];
    await act(async () => gate.resolve(page()));
    expect(editor().value).toBe("");
    expect(node.textContent).toContain(i18n.t("crossSession.managedHandoffUnavailable"));
  });

  it.each(["G:\\target", "g:/target"])("accepts Windows separator and drive-letter aliases in metadata and open tabs: %s", async workspacePath => {
    const held = { ...record(), target: { ...target, workspacePath: "G:/target" } };
    chat.sessions = [{ ...chat.sessions[0], workspacePath }];
    chat.openTabs = [{ ...target, workspacePath }];
    await render(held);
    await status("completed");
    expect(load).toHaveBeenCalledExactlyOnceWith("claude", "child", 40);
    expect(editor().value).toContain("继续实现测试🙂");
  });

  it.each(["g:/Target", "G:/Target", "G:/target/"])("rejects directory-case or trailing-separator metadata differences: %s", async workspacePath => {
    chat.sessions = [{ ...chat.sessions[0], workspacePath }];
    await render({ ...record(), target: { ...target, workspacePath: "G:/target" } });
    expect(load).not.toHaveBeenCalled();
    expect(node.textContent).toContain(i18n.t("crossSession.managedHandoffUnavailable"));
  });

  it.each(["g:/Target", "G:/Target", "G:/target/"])("rejects directory-case or trailing-separator tab differences: %s", async workspacePath => {
    chat.sessions = [{ ...chat.sessions[0], workspacePath: "G:\\target" }];
    chat.openTabs = [{ ...target, workspacePath }];
    await render({ ...record(), target: { ...target, workspacePath: "G:/target" } });
    expect(load).not.toHaveBeenCalled();
    expect(node.textContent).toContain(i18n.t("crossSession.managedHandoffUnavailable"));
  });

  it.each(["failed", "empty"])("asks for manual text when history is %s", async outcome => {
    if (outcome === "failed") load.mockRejectedValue(new Error("read failed"));
    else load.mockResolvedValue({ ...page(), messages: [] });
    await render();
    expect(editor().value).toBe("");
    expect(node.textContent).toContain(i18n.t("crossSession.managedHandoffUnavailable"));
    expect(button("managedHandoffSubmit").disabled).toBe(true);
  });

  it("locks duplicate submission and retains edited text after a native failure", async () => {
    const gate = deferred<void>(); onSubmit.mockReturnValueOnce(gate.promise);
    await render(); await status("completed"); await edit("人工摘要");
    const submit = button("managedHandoffSubmit");
    await act(async () => { submit.click(); submit.click(); });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("人工摘要");
    expect(editor().disabled).toBe(true); expect(button("managedHandoffClose").disabled).toBe(true);
    await act(async () => gate.reject(new Error("source changed")));
    expect(node.querySelector('[role="alert"]')!.textContent).toContain("source changed");
    expect(editor().value).toBe("人工摘要"); expect(editor().disabled).toBe(true);
    expect(node.textContent).toContain(i18n.t("crossSession.managedHandoffRetryHint"));
    await act(async () => button("managedHandoffSubmit").click());
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("enforces the UTF-16 length and NUL constraints without truncating edits", async () => {
    await render();
    await status("completed");
    for (const text of ["  ", "bad\0text", "🙂".repeat(4001)]) {
      await edit(text); expect(editor().value).toBe(text);
      expect(button("managedHandoffSubmit").disabled).toBe(true);
    }
    await edit("🙂".repeat(4000));
    expect(button("managedHandoffSubmit").disabled).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
