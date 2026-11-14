import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionHandoffDraft,
  buildSessionHandoffExcerpt,
  cacheHeatChipStyle,
  cacheHeatRingStroke,
  cacheHeatTextColor,
  classifySessionForCleanup,
  CLEANUP_IDLE_RECOMMEND_MS,
  getSessionCacheHeat,
  replaceHandoffDraftSummary,
  upgradeHandoffDraftWithGrok,
} from "./session-cleanup";
import { getPromptCacheHeatRatio } from "./prompt-cache";
import { EMPTY_SESSION } from "./store/stream";
import { ipc, type SessionMeta } from "@/lib/ipc";
import { StatusBar } from "@/components/application/ai-chat/ai-chat-composer";
import { DEFAULT_HANDOFF_COMPRESSION_MODEL, HANDOFF_PREFERENCES_KEY } from "./handoff-preferences";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  vi.spyOn(ipc, "taskSnapshot").mockResolvedValue({ leaders: [], branches: [] });
  vi.spyOn(ipc, "handoffFullHistorySupported").mockResolvedValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = 1_900_000_000_000;

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    engine: "codex",
    sessionId: "sess-12345678",
    workspacePath: "/ws/app",
    filePath: "/tmp/sess.jsonl",
    fileSize: 100,
    fileMtimeMs: NOW - 1000,
    title: "Implement feature X",
    preview: "",
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - CLEANUP_IDLE_RECOMMEND_MS - 60_000,
    messageCount: 4,
    pinned: false,
    customTitle: null,
    ...overrides,
  };
}

describe("session-cleanup & evidence-based cache window", () => {
  it("keeps the ordinary handoff draft untouched on timeout and reports failure", async () => {
    const raw = "Full handoff segment 1/2: codex handoff summary timed out [stage=completion; http_status=200; diagnostic_id=ordinary]";
    const submit = vi.spyOn(ipc, "summarizeSessionHandoff").mockRejectedValue(Error(raw));
    const applyDraft = vi.fn();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const selection = { engine: "codex" as const, model: "gpt-6.1-sol", effort: "max" };
    expect(await upgradeHandoffDraftWithGrok({
      engine: "codex", sessionId: "session-timeout", title: "Handoff",
      compressionSelection: selection, getCurrentDraft: () => "original draft🙂",
      applyDraft, onSuccess, onError,
    })).toBe(false);
    expect(applyDraft).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("[handoff-timeout]"));
    expect(onError.mock.calls[0][0].endsWith(raw)).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ compressionSelection: selection, historyScope: "full" }));
  });

  it("does not infer cache warmth from session activity, while computing continuous 0..1 gradient ratios", () => {
    expect(getSessionCacheHeat(undefined, NOW)).toBe("unknown");
    expect(classifySessionForCleanup({ session: makeSession({ updatedAt: NOW }), streaming: true, now: NOW }).heat).toBe("unknown");

    // Activity and streaming cannot create cache evidence for the gradient.
    expect(getPromptCacheHeatRatio(undefined, NOW, true, NOW)).toBe(0);
    expect(classifySessionForCleanup({ session: makeSession({ engine: "claude", updatedAt: NOW }), streaming: true, now: NOW }).heatRatio).toBe(0);

    const cache = {
      startedAt: NOW - 120_000,
      observedAt: NOW - 120_000,
      ttlSeconds: 300,
      source: "anthropic-usage" as const,
    };
    expect(getPromptCacheHeatRatio(cache, undefined, false, NOW)).toBe(0.6);

    expect(cacheHeatTextColor(1)).toBe("var(--color-text-error-primary)");
    expect(cacheHeatTextColor(0)).toBe("var(--color-text-tertiary)");
    expect(cacheHeatTextColor(0.64)).toBe(
      "color-mix(in oklab, var(--color-text-error-primary) 64%, var(--color-text-tertiary))",
    );
    expect(cacheHeatRingStroke(0.64)).toBe(
      "color-mix(in oklab, var(--color-text-error-primary) 64%, var(--color-foreground-icon-tertiary))",
    );
    expect(cacheHeatChipStyle(0.64)).toEqual({
      color: "color-mix(in oklab, var(--color-text-error-primary) 64%, var(--color-text-tertiary))",
      backgroundColor:
        "color-mix(in oklab, var(--color-background-tertiary-error) 64%, var(--color-background-tertiary-default))",
    });
  });

  it("keeps Codex cleanup colors permanently red without inventing cache-hit evidence", () => {
    for (const now of [NOW, NOW + 365 * 24 * 60 * 60_000]) {
      const item = classifySessionForCleanup({ session: makeSession(), now });
      expect(item.heatRatio).toBe(1);
      expect(item.heat).toBe("unknown");
    }
  });

  it("pre-selects long-idle settled sessions and protects drafts, errors, approvals, pins, and Leader groups", () => {
    const settledIdle = classifySessionForCleanup({
      session: makeSession(),
      now: NOW,
    });
    expect(settledIdle.category).toBe("recommend");
    expect(settledIdle.reason).toBe("settled_idle");
    expect(settledIdle.defaultSelected).toBe(true);
    expect(settledIdle.selectable).toBe(true);

    const settledRecent = classifySessionForCleanup({
      session: makeSession({ updatedAt: NOW - 120_000 }),
      now: NOW,
    });
    expect(settledRecent.category).toBe("recommend");
    expect(settledRecent.reason).toBe("settled_recent");
    expect(settledRecent.heat).toBe("unknown");
    expect(settledRecent.defaultSelected).toBe(false);

    const withDraft = classifySessionForCleanup({
      session: makeSession(),
      draftText: "wait, one more thing",
      now: NOW,
    });
    expect(withDraft.category).toBe("attention");
    expect(withDraft.reason).toBe("unsent_draft");
    expect(withDraft.defaultSelected).toBe(false);

    const running = classifySessionForCleanup({
      session: makeSession(),
      streaming: true,
      now: NOW,
    });
    expect(running.category).toBe("attention");
    expect(running.reason).toBe("running");
    expect(running.selectable).toBe(false);

    const pinned = classifySessionForCleanup({
      session: makeSession({ pinned: true }),
      now: NOW,
    });
    expect(pinned.category).toBe("protected");
    expect(pinned.reason).toBe("pinned");
    expect(pinned.defaultSelected).toBe(false);

    const legacyLeader = classifySessionForCleanup({
      session: makeSession(),
      leaderSnapshot: {
        leaders: [{ engine: "codex", sessionId: "sess-12345678", workspacePath: "/ws/app" }],
        branches: [],
      },
      now: NOW,
    });
    expect(legacyLeader.category).toBe("recommend");
    expect(legacyLeader.selectable).toBe(true);
    const leaderGroup = classifySessionForCleanup({
      session: makeSession(),
      leaderSnapshot: { leaders: [], branches: [], archivedGroups: [{
        root: { engine: "codex", sessionId: "sess-12345678", workspacePath: "/ws/app" },
        title: "Archived task", archivedAt: 1, members: [], branchIds: [],
      }] },
      now: NOW,
    });
    expect(leaderGroup.category).toBe("protected");
    expect(leaderGroup.reason).toBe("leader_group");
    expect(leaderGroup.selectable).toBe(false);
  });

  it("does not infer long idleness from an absent or invalid activity timestamp", () => {
    for (const updatedAt of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const item = classifySessionForCleanup({ session: makeSession({ updatedAt }), now: NOW });
      expect(item.category).toBe("attention");
      expect(item.reason).toBe("unknown_activity");
      expect(item.defaultSelected).toBe(false);
    }
    expect(classifySessionForCleanup({
      session: makeSession({ updatedAt: NOW - CLEANUP_IDLE_RECOMMEND_MS }), now: NOW,
    }).defaultSelected).toBe(true);
  });

  it("never makes a running pinned session selectable", () => {
    const item = classifySessionForCleanup({ session: makeSession({ pinned: true }), streaming: true, now: NOW });
    expect(item.reason).toBe("running");
    expect(item.selectable).toBe(false);
  });

  it("builds a zero-token local handoff draft with touched files, folded code fences, and nextTask", () => {
    const longCode = Array.from({ length: 12 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const draft = buildSessionHandoffDraft({
      title: "Fix Vertex credits",
      engine: "agy",
      sessionId: "17139666-576b-4710-893b-88e62faee1a8",
      nextTask: "继续用 Codex 验证边界用例",
      state: {
        ...EMPTY_SESSION,
        messages: [
          { seq: 1, ts: "1", role: "user", text: "Why are credits gone?" },
          { seq: 2, ts: "2", role: "tool", text: "Edit", path: "src/features/chat/agy-quota.ts" },
          { seq: 3, ts: "3", role: "tool", text: "Write", path: "src/features/chat/agy-quota.test.ts" },
          {
            seq: 4,
            ts: "4",
            role: "assistant",
            text: `${"前言说明段落。".repeat(60)}\n\n\`\`\`ts\n${longCode}\n\`\`\`\n\nRestored Free Trial $370.64 and GDP $51.13.`,
          },
        ],
      },
    });
    expect(draft).toContain("Fix Vertex credits");
    expect(draft).toContain("agy/17139666");
    expect(draft).toContain("涉及文件：`src/features/chat/agy-quota.test.ts`、`src/features/chat/agy-quota.ts`");
    expect(draft).toContain("[ts: 12 lines]");
    expect(draft).toContain("Restored Free Trial $370.64 and GDP $51.13.");
    expect(draft).toContain("接下来请继续：继续用 Codex 验证边界用例");
  });

  it("preserves the handoff draft when switching engine/provider on the new tab", async () => {
    const { useChatStore, sessionKey } = await import("./store");
    const { parseAppCommand } = await import("@/components/application/ai-chat/app-commands");
    expect(parseAppCommand("/handoff", "/ws/app")).toEqual({ command: "handoff", arg: "" });
    expect(parseAppCommand("/handoff 切到 codex 跑测试", "/ws/app")).toEqual({
      command: "handoff",
      arg: "切到 codex 跑测试",
    });

    const claudeNewKey = sessionKey("claude", null, "/ws/app");
    const codexNewKey = sessionKey("codex", null, "/ws/app");
    useChatStore.setState({
      activeEngine: "claude",
      active: { engine: "claude", sessionId: null, workspacePath: "/ws/app" },
      openTabs: [{ engine: "claude", sessionId: null, workspacePath: "/ws/app" }],
      drafts: {
        [claudeNewKey]: "承接上一会话「Fix」（claude/12345678）：\n\n接下来请继续：",
        [codexNewKey]: "",
      },
    });

    useChatStore.getState().setActiveEngine("codex");
    const after = useChatStore.getState();
    expect(after.active?.engine).toBe("codex");
    expect(after.drafts[codexNewKey]).toContain("承接上一会话「Fix」");
  });

  it("upgrades the handoff draft asynchronously with Cursor Grok 4.7 while preserving user-typed text", async () => {
    const state = {
      ...EMPTY_SESSION,
      messages: [
        { seq: 1, ts: "1", role: "user" as const, text: "Add /handoff command" },
        { seq: 2, ts: "2", role: "tool" as const, text: "Edit", path: "src/components/application/ai-chat/cli-menu.tsx" },
        { seq: 3, ts: "3", role: "assistant" as const, text: "Added /handoff and synced CliMenu." },
      ],
    };
    const excerpt = buildSessionHandoffExcerpt(state);
    expect(excerpt).toContain("src/components/application/ai-chat/cli-menu.tsx");
    expect(excerpt).toContain("[用户]: Add /handoff command");
    expect(excerpt).toContain("[AI]: Added /handoff and synced CliMenu.");

    let currentDraft =
      buildSessionHandoffDraft({
        title: "Handoff",
        engine: "claude",
        sessionId: "12345678-aaaa",
        state,
      }) + "请接着加上缓存清理";

    const spy = vi
      .spyOn(ipc, "summarizeSessionHandoff")
      .mockResolvedValue("- **目标与背景**：实现 /handoff\n- **已完成改动与结论**：同步了 CliMenu 面板");

    const ok = await upgradeHandoffDraftWithGrok({
      engine: "claude",
      sessionId: "12345678-aaaa",
      title: "Handoff",
      state,
      getCurrentDraft: () => currentDraft,
      applyDraft: (next) => {
        currentDraft = next;
      },
    });
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledExactlyOnceWith({ engine: "claude", sessionId: "12345678-aaaa", title: "Handoff", historyScope: "full" });
    expect(spy.mock.calls[0][0]).not.toHaveProperty("transcriptExcerpt");
    expect(currentDraft).toContain("涉及文件：`src/components/application/ai-chat/cli-menu.tsx`");
    expect(currentDraft).toContain("上一会话交接摘要（模型提炼）：");
    expect(currentDraft).toContain("> - **目标与背景**：实现 /handoff");
    expect(currentDraft).toContain("接下来请继续：请接着加上缓存清理");

    // If user already replaced the draft completely, replaceHandoffDraftSummary returns null
    expect(replaceHandoffDraftSummary("completely custom prompt", "- bullet")).toBeNull();
    spy.mockRestore();
  });
});

describe("StatusBar cacheHeat & Archive and Handoff", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.removeItem(HANDOFF_PREFERENCES_KEY);
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders scarlet red when hot and exposes Archive & Handoff button when cold", async () => {
    const onHandoff = vi.fn();
    await act(async () => {
      root.render(
        <StatusBar
          usagePct={42}
          contextMax={200_000}
          contextMaxKnown
          contextOccupancyKnown
          cacheHeat="hot"
          onArchiveAndHandoff={onHandoff}
        />,
      );
    });
    const triggerHot = container.querySelector<HTMLButtonElement>("button[data-cache-heat='hot']");
    expect(triggerHot).not.toBeNull();
    expect(triggerHot!.innerHTML).toContain("text-text-error-primary");

    await act(async () => {
      root.render(
        <StatusBar
          usagePct={42}
          contextMax={200_000}
          contextMaxKnown
          contextOccupancyKnown
          cacheHeat="cold"
          onArchiveAndHandoff={onHandoff}
        />,
      );
    });
    const triggerCold = container.querySelector<HTMLButtonElement>("button[data-cache-heat='cold']");
    expect(triggerCold).not.toBeNull();
    expect(triggerCold!.innerHTML).toContain("text-text-tertiary");

    await act(async () => triggerCold!.click());
    const handoffBtn = document.querySelector<HTMLButtonElement>("[data-testid='archive-handoff-btn']");
    expect(handoffBtn).not.toBeNull();
    await act(async () => handoffBtn!.click());
    expect(onHandoff).toHaveBeenCalledOnce();
  });

  it("populates the new chat draft with correct (key, text) order, keeps source session intact, renders HandoffOverlayCard, and switches compression modes", async () => {
    const { useChatStore, sessionKey } = await import("./store");
    const { useHandoffStore } = await import("./session-cleanup");
    const { HandoffOverlayCard } = await import("./components/HandoffOverlayCard");
    const archiveSpy = vi.spyOn(ipc, "archiveSession").mockResolvedValue();
    const enginesSpy = vi.spyOn(ipc, "listEngines").mockResolvedValue([
      { id: "cursor", enabled: true, available: true, supportsImages: false, permissions: [] },
    ]);
    const configSpy = vi.spyOn(ipc, "getCliConfig").mockResolvedValue({} as Awaited<ReturnType<typeof ipc.getCliConfig>>);
    const settingsSpy = vi.spyOn(ipc, "getAppSettings").mockResolvedValue({} as Awaited<ReturnType<typeof ipc.getAppSettings>>);
    const catalogSpy = vi.spyOn(ipc, "listEngineModels").mockResolvedValue({
      authoritative: true,
      models: [{ id: DEFAULT_HANDOFF_COMPRESSION_MODEL, name: "Grok compression", provider: "cursor" }],
    });

    let resolveGrok!: (val: string) => void;
    const grokPromise = new Promise<string>((r) => {
      resolveGrok = r;
    });
    const grokSpy = vi.spyOn(ipc, "summarizeSessionHandoff").mockReturnValue(grokPromise);

    const sourceMeta = makeSession({
      engine: "agy",
      sessionId: "17139666-576b-4710-893b-88e62faee1a8",
      workspacePath: "/ws/app",
      title: "Fix Vertex credits",
    });
    const sourceState = {
      ...EMPTY_SESSION,
      messages: [
        { seq: 1, ts: "1", role: "user" as const, text: "Why are credits gone?" },
        { seq: 2, ts: "2", role: "tool" as const, text: "Edit", path: "src/features/chat/agy-quota.ts" },
        { seq: 3, ts: "3", role: "assistant" as const, text: "Restored Free Trial $370.64 and GDP $51.13." },
      ],
    };

    useChatStore.setState({
      activeEngine: "codex",
      active: { engine: "agy", sessionId: sourceMeta.sessionId, workspacePath: "/ws/app" },
      openTabs: [{ engine: "agy", sessionId: sourceMeta.sessionId, workspacePath: "/ws/app" }],
      sessions: [sourceMeta],
      bySession: {
        [sessionKey("agy", sourceMeta.sessionId, "/ws/app")]: sourceState,
      },
      drafts: {},
    });

    await act(async () => {
      useHandoffStore.getState().startHandoff({
        workspacePath: "/ws/app",
        sourceEngine: "agy",
        sourceSessionId: sourceMeta.sessionId,
        sourceTitle: sourceMeta.title,
        sourceMeta,
        sourceState,
        nextTask: "继续跑边界测试",
        archiveSourceOnSend: false,
      });
    });

    // 1. Source session is NOT deleted/archived upfront
    expect(archiveSpy).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions.map((s) => s.sessionId)).toContain(sourceMeta.sessionId);

    // 2. Target pending tab is focused and its draft has the handoff text under the right key
    const targetDraftKey = sessionKey("codex", null, "/ws/app");
    expect(useChatStore.getState().active).toEqual({
      engine: "codex",
      sessionId: null,
      workspacePath: "/ws/app",
    });
    expect(useChatStore.getState().drafts[targetDraftKey]).toContain(
      "承接上一会话「Fix Vertex credits」（agy/17139666）：",
    );
    expect(useChatStore.getState().drafts[targetDraftKey]).toContain(
      "接下来请继续：继续跑边界测试",
    );

    // 3. Opening handoff stays local until the user explicitly enables compression.
    await act(async () => {
      root.render(
        <HandoffOverlayCard
          active={useChatStore.getState().active}
          model="gpt-5.4"
        />,
      );
    });
    const card = container.querySelector("[data-testid='handoff-overlay-card']");
    expect(card).not.toBeNull();
    const grokStatus = container.querySelector("[data-testid='handoff-grok-status']");
    expect(grokStatus?.getAttribute("data-grok-status")).toBe("idle");
    expect(grokSpy).not.toHaveBeenCalled();
    const compressionSwitch = container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    await act(async () => compressionSwitch.click());
    await vi.waitFor(() => expect(grokSpy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ compressionModel: DEFAULT_HANDOFF_COMPRESSION_MODEL, historyScope: "full" })));
    expect(grokSpy.mock.calls[0][0]).not.toHaveProperty("transcriptExcerpt");
    expect(grokStatus?.getAttribute("data-grok-status")).toBe("running");

    // 4. Complete Grok 4.7 distillation in background and verify draft + status update
    await act(async () => {
      resolveGrok("- **目标与背景**：恢复 Vertex 点数\n- **已完成改动与结论**：修复 `agy-quota.ts`");
      await grokPromise;
    });
    expect(grokStatus?.getAttribute("data-grok-status")).toBe("done");
    expect(useChatStore.getState().drafts[targetDraftKey]).toContain(
      "上一会话交接摘要（模型提炼）：",
    );
    expect(useChatStore.getState().drafts[targetDraftKey]).toContain(
      "> - **目标与背景**：恢复 Vertex 点数",
    );

    // 5. Switch compression mode to `detailed` and `local` and verify in-place draft update
    await act(async () => compressionSwitch.click());
    const detailedBtn = container.querySelector<HTMLButtonElement>("[data-testid='handoff-mode-detailed']")!;
    await act(async () => {
      detailedBtn.click();
    });
    expect(useChatStore.getState().drafts[targetDraftKey]).toContain("上一会话多轮对话摘录：");
    expect(useChatStore.getState().drafts[targetDraftKey]).toContain("> **[用户]**：Why are credits gone?");
    expect(useChatStore.getState().drafts[targetDraftKey]).toContain("接下来请继续：继续跑边界测试");

    const localBtn = container.querySelector<HTMLButtonElement>("[data-testid='handoff-mode-local']")!;
    await act(async () => {
      localBtn.click();
    });
    expect(useChatStore.getState().drafts[targetDraftKey]).toContain("上一会话最后结论摘要：");
    expect(useChatStore.getState().drafts[targetDraftKey]).toContain("> Restored Free Trial $370.64 and GDP $51.13.");

    await act(async () => {
      compressionSwitch.click();
    });
    expect(useChatStore.getState().drafts[targetDraftKey]).toContain("上一会话交接摘要（模型提炼）：");

    // 6. Toggle archiveSourceOnSend and complete handoff on send
    const checkbox = container.querySelector<HTMLInputElement>("[data-testid='handoff-archive-on-send-checkbox']")!;
    expect(checkbox.checked).toBe(false);
    await act(async () => {
      checkbox.click();
    });
    expect(useHandoffStore.getState().byWorkspace["/ws/app"]?.archiveSourceOnSend).toBe(true);

    await act(async () => {
      useHandoffStore.getState().completeHandoffOnSend("/ws/app", useHandoffStore.getState().byWorkspace["/ws/app"].id);
    });
    expect(useHandoffStore.getState().byWorkspace["/ws/app"]).toBeUndefined();
    expect(archiveSpy).toHaveBeenCalledWith(sourceMeta);

    grokSpy.mockRestore();
    archiveSpy.mockRestore();
    catalogSpy.mockRestore();
    enginesSpy.mockRestore();
    configSpy.mockRestore();
    settingsSpy.mockRestore();
  });
});

describe("SessionCleanupDialog batch archive & undo", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("opens from sidebar cleanup button, batch-archives settled sessions, and undoes while preserving drafts", async () => {
    const { useChatStore } = await import("./store");
    const { ipc } = await import("@/lib/ipc");
    const archiveSpy = vi.spyOn(ipc, "archiveSession").mockResolvedValue();
    const restoreSpy = vi.spyOn(ipc, "restoreSession").mockResolvedValue();

    const idleSession = makeSession({
      sessionId: "idle-old",
      title: "Old finished task",
      updatedAt: Date.now() - CLEANUP_IDLE_RECOMMEND_MS - 10_000,
    });
    const draftSession = makeSession({
      sessionId: "has-draft",
      title: "Task with draft",
      updatedAt: Date.now() - CLEANUP_IDLE_RECOMMEND_MS - 10_000,
    });
    useChatStore.setState({
      workspaces: [{ id: "ws1", name: "app", path: "/ws/app", sortOrder: 0, lastOpenedAt: 1, groupId: null }],
      sessions: [idleSession, draftSession],
      drafts: { "codex/has-draft": "keep this draft" },
      archivedSessionKeys: {},
    });

    const { SessionCleanupDialog } = await import(
      "@/components/application/ai-chat/session-cleanup-dialog"
    );
    const onClose = vi.fn();
    await act(async () => {
      root.render(<SessionCleanupDialog open onClose={onClose} />);
    });

    const rows = document.body.querySelectorAll<HTMLElement>("[data-testid='cleanup-session-row']");
    expect(rows.length).toBe(2);
    // Only the idle settled session without unsent draft is pre-selected
    const checkboxes = document.body.querySelectorAll<HTMLInputElement>(
      "[data-testid='cleanup-session-row'] input[type='checkbox']",
    );
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(false);

    // Click Archive selected
    const archiveBtn = document.body.querySelector<HTMLButtonElement>(
      "[data-testid='cleanup-archive-selected-btn']",
    );
    expect(archiveBtn).not.toBeNull();
    await act(async () => {
      archiveBtn!.click();
    });

    expect(archiveSpy).toHaveBeenCalledWith(idleSession);
    expect(useChatStore.getState().sessions.map((s) => s.sessionId)).toEqual(["has-draft"]);

    // Undo banner appears and restores the archived session
    const undoBanner = document.body.querySelector("[data-testid='cleanup-undo-banner']");
    expect(undoBanner).not.toBeNull();
    const undoBtn = undoBanner!.querySelector("button")!;
    await act(async () => {
      undoBtn.click();
    });
    expect(restoreSpy).toHaveBeenCalledWith("codex", "idle-old");
    expect(useChatStore.getState().sessions.map((s) => s.sessionId)).toContain("idle-old");

    archiveSpy.mockRestore();
    restoreSpy.mockRestore();
  });

  it("rechecks each later session against current running state, draft, pin, and task-group membership", async () => {
    const { useChatStore, sessionKey } = await import("./store");
    const { useLeaderStore } = await import("@/features/leader/store");
    const { SessionCleanupDialog } = await import("@/components/application/ai-chat/session-cleanup-dialog");
    const lastUpdate = Date.now() - CLEANUP_IDLE_RECOMMEND_MS - 10_000;
    const first = makeSession({ sessionId: "first", updatedAt: lastUpdate });
    const running = makeSession({ sessionId: "later-running", updatedAt: lastUpdate - 1 });
    const group = makeSession({ sessionId: "later-group", updatedAt: lastUpdate - 2 });
    const draft = makeSession({ sessionId: "later-draft", updatedAt: lastUpdate - 3 });
    const pinned = makeSession({ sessionId: "later-pinned", updatedAt: lastUpdate - 4 });
    const previousSnapshot = useLeaderStore.getState().snapshot;
    useLeaderStore.setState({ snapshot: { leaders: [], branches: [] } });
    useChatStore.setState({
      workspaces: [{ id: "ws1", name: "app", path: "/ws/app", sortOrder: 0, lastOpenedAt: 1, groupId: null }],
      archivedWorkspaces: [], sessions: [first, running, group, draft, pinned], drafts: {}, unseen: {}, bySession: {},
      streamingByKey: {}, archivedSessionKeys: {},
    });
    const archiveSpy = vi.spyOn(ipc, "archiveSession").mockImplementation(async (session) => {
      if (session.sessionId === first.sessionId) {
        useChatStore.setState({
          streamingByKey: { [sessionKey(running.engine, running.sessionId, running.workspacePath)]: true },
          drafts: { [sessionKey(draft.engine, draft.sessionId, draft.workspacePath)]: "new draft" },
          sessions: useChatStore.getState().sessions.map((session) => session.sessionId === pinned.sessionId ? { ...session, pinned: true } : session),
        });
        useLeaderStore.setState({ snapshot: { leaders: [], branches: [{
          id: "new-child", parentEngine: group.engine, parentSessionId: group.sessionId,
          workspacePath: group.workspacePath, engine: "codex", sessionId: "child", title: "Child", task: "Work",
          model: null, effort: null, runId: null, state: "completed", createdAt: Date.now(), updatedAt: Date.now(),
          lastActivityAt: Date.now(), deadlineAt: Date.now(), expired: false, result: "done", resultTruncated: false, error: null,
        }] } });
      }
    });
    try {
      await act(async () => root.render(<SessionCleanupDialog open onClose={() => {}} />));
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>("[data-testid='cleanup-archive-selected-btn']")!.click();
      });
      expect(archiveSpy).toHaveBeenCalledTimes(1);
      expect(archiveSpy).toHaveBeenCalledWith(first);
      expect(useChatStore.getState().sessions.map((session) => session.sessionId)).toEqual([running.sessionId, group.sessionId, draft.sessionId, pinned.sessionId]);
    } finally {
      await act(async () => useLeaderStore.setState({ snapshot: previousSnapshot }));
    }
  });

  it("recomputes the idle threshold when the dialog is reopened", async () => {
    const { useChatStore } = await import("./store");
    const { useLeaderStore } = await import("@/features/leader/store");
    const { SessionCleanupDialog } = await import("@/components/application/ai-chat/session-cleanup-dialog");
    const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const session = makeSession({ sessionId: "crosses-threshold", updatedAt: NOW - CLEANUP_IDLE_RECOMMEND_MS + 1 });
    const previousSnapshot = useLeaderStore.getState().snapshot;
    useLeaderStore.setState({ snapshot: { leaders: [], branches: [] } });
    useChatStore.setState({
      workspaces: [{ id: "ws1", name: "app", path: "/ws/app", sortOrder: 0, lastOpenedAt: 1, groupId: null }],
      archivedWorkspaces: [], sessions: [session], drafts: {}, unseen: {}, bySession: {}, streamingByKey: {}, archivedSessionKeys: {},
    });
    try {
      await act(async () => root.render(<SessionCleanupDialog open onClose={() => {}} />));
      expect(document.body.querySelector<HTMLInputElement>("[data-testid='cleanup-session-row'] input")!.checked).toBe(false);
      await act(async () => root.render(<SessionCleanupDialog open={false} onClose={() => {}} />));
      now.mockReturnValue(NOW + 1);
      await act(async () => root.render(<SessionCleanupDialog open onClose={() => {}} />));
      expect(document.body.querySelector<HTMLInputElement>("[data-testid='cleanup-session-row'] input")!.checked).toBe(true);
    } finally {
      await act(async () => useLeaderStore.setState({ snapshot: previousSnapshot }));
    }
  });

  it("still archives a draft session the user deliberately selects", async () => {
    const { useChatStore, sessionKey } = await import("./store");
    const { useLeaderStore } = await import("@/features/leader/store");
    const { SessionCleanupDialog } = await import("@/components/application/ai-chat/session-cleanup-dialog");
    const session = makeSession({ sessionId: "selected-draft", updatedAt: Date.now() - CLEANUP_IDLE_RECOMMEND_MS });
    const draftKey = sessionKey(session.engine, session.sessionId, session.workspacePath);
    const previousSnapshot = useLeaderStore.getState().snapshot;
    useLeaderStore.setState({ snapshot: { leaders: [], branches: [] } });
    useChatStore.setState({
      workspaces: [{ id: "ws1", name: "app", path: "/ws/app", sortOrder: 0, lastOpenedAt: 1, groupId: null }],
      archivedWorkspaces: [], sessions: [session], drafts: { [draftKey]: "keep this draft" }, unseen: {}, bySession: {}, streamingByKey: {}, archivedSessionKeys: {},
    });
    const archiveSpy = vi.spyOn(ipc, "archiveSession").mockResolvedValue();
    try {
      await act(async () => root.render(<SessionCleanupDialog open onClose={() => {}} />));
      const checkbox = document.body.querySelector<HTMLInputElement>("[data-testid='cleanup-session-row'] input")!;
      expect(checkbox.checked).toBe(false);
      await act(async () => checkbox.click());
      await act(async () => document.body.querySelector<HTMLButtonElement>("[data-testid='cleanup-archive-selected-btn']")!.click());
      expect(archiveSpy).toHaveBeenCalledWith(session);
      expect(useChatStore.getState().drafts[draftKey]).toBe("keep this draft");
    } finally {
      await act(async () => useLeaderStore.setState({ snapshot: previousSnapshot }));
    }
  });

  it("archives an idle task group once and undoes it as a whole", async () => {
    const { useChatStore } = await import("./store");
    const { useLeaderStore } = await import("@/features/leader/store");
    const { SessionCleanupDialog } = await import("@/components/application/ai-chat/session-cleanup-dialog");
    const updatedAt = Date.now() - CLEANUP_IDLE_RECOMMEND_MS - 10_000;
    const parent = makeSession({ sessionId: "group-root", updatedAt });
    const child = makeSession({ sessionId: "group-child", updatedAt });
    const rootIdentity = { engine: parent.engine, sessionId: parent.sessionId, workspacePath: parent.workspacePath };
    const snapshot = { leaders: [], branches: [{
      id: "branch-child", parentEngine: parent.engine, parentSessionId: parent.sessionId, workspacePath: child.workspacePath,
      engine: child.engine, sessionId: child.sessionId, title: "Child", task: "Work", model: null, effort: null,
      runId: null, state: "completed" as const, createdAt: updatedAt, updatedAt, lastActivityAt: updatedAt,
      deadlineAt: updatedAt, expired: false, result: "done", resultTruncated: false, error: null,
    }] };
    const previousLeader = useLeaderStore.getState();
    const groupAction = vi.fn(async (_root: Parameters<typeof previousLeader.groupAction>[0], action: Parameters<typeof previousLeader.groupAction>[1], _expected?: Parameters<typeof previousLeader.groupAction>[2]) => {
      if (action === "archive") useChatStore.setState({ sessions: [] });
      else useChatStore.setState({ sessions: [parent, child] });
    });
    const refresh = vi.fn().mockResolvedValue(undefined).mockImplementationOnce(async () => {
      const lastActivityAt = Date.now();
      useLeaderStore.setState({ snapshot: { ...snapshot, branches: [{ ...snapshot.branches[0], updatedAt: lastActivityAt, lastActivityAt }] } });
    });
    useLeaderStore.setState({ snapshot, error: null, refresh, groupAction });
    useChatStore.setState({
      workspaces: [{ id: "ws1", name: "app", path: "/ws/app", sortOrder: 0, lastOpenedAt: 1, groupId: null }],
      archivedWorkspaces: [], sessions: [parent, child], drafts: {}, unseen: {}, bySession: {}, streamingByKey: {}, retryingByKey: {}, archivedSessionKeys: {},
    });
    const archiveSpy = vi.spyOn(ipc, "archiveSession").mockResolvedValue();
    try {
      await act(async () => root.render(<SessionCleanupDialog open onClose={() => {}} />));
      const rootRow = document.body.querySelector<HTMLElement>("[data-cleanup-reason='leader_group_idle']")!;
      const childRow = document.body.querySelector<HTMLElement>("[data-cleanup-reason='leader_child_idle']")!;
      expect(rootRow.querySelector<HTMLInputElement>("input")!.checked).toBe(true);
      expect(rootRow.textContent).toContain("2");
      // The expired child is offered on its own, but the selected group covers it.
      expect(childRow.dataset.cleanupCovered).toBe("true");
      expect(childRow.querySelector<HTMLInputElement>("input")!.checked).toBe(true);
      expect(childRow.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
      expect(document.body.textContent).toContain((await import("@/lib/i18n")).default.t("chat.cleanupSelectedCount", { count: 1 }));
      // An explicit selection must not follow a group into a new activity state.
      await act(async () => rootRow.querySelector<HTMLInputElement>("input")!.click());
      await act(async () => rootRow.querySelector<HTMLInputElement>("input")!.click());
      await act(async () => document.body.querySelector<HTMLButtonElement>("[data-testid='cleanup-archive-selected-btn']")!.click());
      expect(groupAction).not.toHaveBeenCalled();
      const recentRow = document.body.querySelector<HTMLElement>("[data-cleanup-reason='leader_group_recent']")!;
      expect(recentRow.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
      await act(async () => recentRow.querySelector<HTMLInputElement>("input")!.click());
      await act(async () => document.body.querySelector<HTMLButtonElement>("[data-testid='cleanup-archive-selected-btn']")!.click());
      expect(groupAction).toHaveBeenCalledExactlyOnceWith(rootIdentity, "archive", expect.objectContaining({
        branchIds: ["branch-child"], members: [rootIdentity, { engine: child.engine, sessionId: child.sessionId, workspacePath: child.workspacePath }],
        lastActivityAt: expect.any(Number),
      }));
      expect(archiveSpy).not.toHaveBeenCalled();
      const banner = document.body.querySelector<HTMLElement>("[data-testid='cleanup-undo-banner']")!;
      groupAction.mockRejectedValueOnce(new Error("Restore refused"));
      await act(async () => banner.querySelector<HTMLButtonElement>("button")!.click());
      expect(groupAction).toHaveBeenLastCalledWith(rootIdentity, "restore");
      expect(banner.textContent).toContain("Restore refused");
      expect(banner.querySelector("button")).not.toBeNull();
      await act(async () => banner.querySelector<HTMLButtonElement>("button")!.click());
      expect(groupAction).toHaveBeenCalledTimes(3);
      expect(document.body.querySelector("[data-testid='cleanup-undo-banner']")).toBeNull();
    } finally {
      await act(async () => useLeaderStore.setState({ snapshot: previousLeader.snapshot, refresh: previousLeader.refresh, groupAction: previousLeader.groupAction, error: previousLeader.error }));
    }
  });

  it("archives an expired child subtree alone while its recently used parent stays", async () => {
    const { useChatStore } = await import("./store");
    const { useLeaderStore } = await import("@/features/leader/store");
    const { SessionCleanupDialog } = await import("@/components/application/ai-chat/session-cleanup-dialog");
    const idleAt = Date.now() - CLEANUP_IDLE_RECOMMEND_MS - 10_000;
    const parent = makeSession({ sessionId: "live-parent", updatedAt: Date.now() - 60_000 });
    const child = makeSession({ sessionId: "expired-child", updatedAt: idleAt });
    const parentIdentity = { engine: parent.engine, sessionId: parent.sessionId, workspacePath: parent.workspacePath };
    const childIdentity = { engine: child.engine, sessionId: child.sessionId, workspacePath: child.workspacePath };
    const snapshot = { leaders: [], branches: [{
      id: "branch-expired", parentEngine: parent.engine, parentSessionId: parent.sessionId, workspacePath: child.workspacePath,
      engine: child.engine, sessionId: child.sessionId, title: "Child", task: "Work", model: null, effort: null,
      runId: null, state: "failed" as const, createdAt: idleAt, updatedAt: idleAt, lastActivityAt: idleAt,
      deadlineAt: idleAt, expired: true, result: "", resultTruncated: false, error: "quota reached",
    }] };
    const previousLeader = useLeaderStore.getState();
    const archiveSubtree = vi.fn(async () => { useChatStore.setState({ sessions: [parent] }); });
    const groupAction = vi.fn(async () => { useChatStore.setState({ sessions: [parent, child] }); });
    useLeaderStore.setState({ snapshot, error: null, refresh: vi.fn().mockResolvedValue(undefined), archiveSubtree, groupAction });
    useChatStore.setState({
      workspaces: [{ id: "ws1", name: "app", path: "/ws/app", sortOrder: 0, lastOpenedAt: 1, groupId: null }],
      archivedWorkspaces: [], sessions: [parent, child], drafts: {}, unseen: {}, bySession: {}, streamingByKey: {}, retryingByKey: {}, archivedSessionKeys: {},
    });
    try {
      await act(async () => root.render(<SessionCleanupDialog open onClose={() => {}} />));
      const parentRow = document.body.querySelector<HTMLElement>("[data-cleanup-reason='leader_group_recent']")!;
      const childRow = document.body.querySelector<HTMLElement>("[data-cleanup-reason='leader_child_idle']")!;
      expect(parentRow.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
      expect(childRow.querySelector<HTMLInputElement>("input")!.checked).toBe(true);
      expect(childRow.dataset.cleanupCovered).toBeUndefined();
      await act(async () => document.body.querySelector<HTMLButtonElement>("[data-testid='cleanup-archive-selected-btn']")!.click());
      expect(archiveSubtree).toHaveBeenCalledExactlyOnceWith(parentIdentity, "branch-expired", {
        branchIds: ["branch-expired"], members: [childIdentity], lastActivityAt: idleAt,
      });
      expect(groupAction).not.toHaveBeenCalled();
      const banner = document.body.querySelector<HTMLElement>("[data-testid='cleanup-undo-banner']")!;
      await act(async () => banner.querySelector<HTMLButtonElement>("button")!.click());
      expect(groupAction).toHaveBeenCalledExactlyOnceWith(childIdentity, "restore");
    } finally {
      await act(async () => useLeaderStore.setState({ snapshot: previousLeader.snapshot, refresh: previousLeader.refresh,
        groupAction: previousLeader.groupAction, archiveSubtree: previousLeader.archiveSubtree, error: previousLeader.error }));
    }
  });

  it.each([
    ["Native group refused", null],
    ["CLEANUP_GROUP_CHANGED: activity changed", "chat.cleanupGroupChanged"],
    ["Leader group must be idle. Stop active chats", "chat.cleanupGroupChanged"],
    ["Command task_group_archive_checked not found", "chat.cleanupGroupHostUpdateRequired"],
  ])("reports task group archive failure %s without claiming an undoable success", async (message, key) => {
    const { useChatStore } = await import("./store");
    const { useLeaderStore } = await import("@/features/leader/store");
    const { SessionCleanupDialog } = await import("@/components/application/ai-chat/session-cleanup-dialog");
    const updatedAt = Date.now() - CLEANUP_IDLE_RECOMMEND_MS - 10_000;
    const parent = makeSession({ sessionId: "failed-group-root", updatedAt });
    const child = makeSession({ sessionId: "failed-group-child", updatedAt });
    const snapshot = { leaders: [], branches: [{
      id: "branch-failed-child", parentEngine: parent.engine, parentSessionId: parent.sessionId, workspacePath: child.workspacePath,
      engine: child.engine, sessionId: child.sessionId, title: "Child", task: "Work", model: null, effort: null,
      runId: null, state: "completed" as const, createdAt: updatedAt, updatedAt, lastActivityAt: updatedAt,
      deadlineAt: updatedAt, expired: false, result: "done", resultTruncated: false, error: null,
    }] };
    const previousLeader = useLeaderStore.getState();
    useLeaderStore.setState({ snapshot, error: null, refresh: vi.fn().mockResolvedValue(undefined), groupAction: vi.fn().mockRejectedValue(new Error(message)) });
    useChatStore.setState({
      workspaces: [{ id: "ws1", name: "app", path: "/ws/app", sortOrder: 0, lastOpenedAt: 1, groupId: null }],
      archivedWorkspaces: [], sessions: [parent, child], drafts: {}, unseen: {}, bySession: {}, streamingByKey: {}, retryingByKey: {}, archivedSessionKeys: {},
    });
    try {
      await act(async () => root.render(<SessionCleanupDialog open onClose={() => {}} />));
      await act(async () => document.body.querySelector<HTMLButtonElement>("[data-testid='cleanup-archive-selected-btn']")!.click());
      const banner = document.body.querySelector<HTMLElement>("[data-testid='cleanup-undo-banner']")!;
      const { default: i18n } = await import("@/lib/i18n");
      expect(banner.textContent).toContain(key ? i18n.t(key) : message);
      expect(banner.querySelector("button")).toBeNull();
      expect(useChatStore.getState().sessions).toEqual([parent, child]);
    } finally {
      await act(async () => useLeaderStore.setState({ snapshot: previousLeader.snapshot, refresh: previousLeader.refresh, groupAction: previousLeader.groupAction, error: previousLeader.error }));
    }
  });

  it("displays reclaimable local cache in SessionCleanupDialog and prunes on click", async () => {
    const inspectSpy = vi.spyOn(ipc, "inspectAppCache").mockResolvedValue({
      runtimeUpdatesBytes: 850 * 1024 * 1024,
      runtimeUpdatesCount: 16,
      backupsBytes: 100 * 1024 * 1024,
      backupsCount: 1,
      mediaAndRemoteBytes: 0,
      mediaAndRemoteCount: 0,
      stagingBytes: 0,
      stagingCount: 0,
      dbWalBytes: 4 * 1024 * 1024,
      totalReclaimableBytes: 954 * 1024 * 1024,
    });
    const pruneSpy = vi.spyOn(ipc, "pruneAppCache").mockResolvedValue({
      freedBytes: 954 * 1024 * 1024,
      deletedEntries: 17,
      remaining: {
        runtimeUpdatesBytes: 0,
        runtimeUpdatesCount: 0,
        backupsBytes: 0,
        backupsCount: 0,
        mediaAndRemoteBytes: 0,
        mediaAndRemoteCount: 0,
        stagingBytes: 0,
        stagingCount: 0,
        dbWalBytes: 0,
        totalReclaimableBytes: 0,
      },
    });

    const { SessionCleanupDialog } = await import(
      "@/components/application/ai-chat/session-cleanup-dialog"
    );
    await act(async () => {
      root.render(<SessionCleanupDialog open onClose={vi.fn()} />);
    });

    const cacheBar = document.body.querySelector("[data-testid='cleanup-app-cache-bar']");
    expect(cacheBar).not.toBeNull();
    expect(cacheBar!.textContent).toContain("954 MB");

    const pruneBtn = document.body.querySelector<HTMLButtonElement>(
      "[data-testid='cleanup-prune-cache-btn']",
    );
    expect(pruneBtn).not.toBeNull();
    await act(async () => {
      pruneBtn!.click();
    });

    expect(pruneSpy).toHaveBeenCalledOnce();
    expect(cacheBar!.textContent).toContain("954 MB");
    expect(document.body.querySelector("[data-testid='cleanup-prune-cache-btn']")).toBeNull();

    inspectSpy.mockRestore();
    pruneSpy.mockRestore();
  });
});
