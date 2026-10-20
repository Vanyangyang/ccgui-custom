import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import {
  clearAllComposerPredictions,
  clearComposerPrediction,
  extractPredictionTurns,
  getComposerPrediction,
  migrateComposerPredictionSessionKey,
  requestComposerPrediction,
  setComposerPredictionEnabled,
} from "./composer-prediction";
import { handleEngineEvents, type EngineEventDeps } from "./store/engine-events";
import { EMPTY_SESSION } from "./store/stream";
import type { ChatStore } from "./store/types";

describe("composer-prediction across channels", () => {
  beforeEach(() => {
    clearAllComposerPredictions();
    setComposerPredictionEnabled(true);
    vi.restoreAllMocks();
  });

  it("extracts user and final assistant turns while ignoring slash commands and incomplete turns", () => {
    expect(
      extractPredictionTurns([
        { seq: 1, ts: "1", role: "user", text: "/compact" },
        { seq: 2, ts: "2", role: "assistant", text: "compacted" },
        { seq: 3, ts: "3", role: "user", text: "重构登录模块" },
        { seq: 4, ts: "4", role: "assistant", text: "先读取相关文件" },
        { seq: 5, ts: "5", role: "tool", text: "read" },
        { seq: 6, ts: "6", role: "assistant", text: "已完成重构，需要运行单元测试吗？" },
      ]),
    ).toEqual([
      {
        user: "重构登录模块",
        assistant: "已完成重构，需要运行单元测试吗？",
      },
    ]);
  });

  it("requests Codex GPT prediction on done across any channel and clears on next turn start", async () => {
    const spy = vi
      .spyOn(ipc, "predictNextPrompt")
      .mockResolvedValue("运行单元测试并验证结果");

    for (const engine of ["claude", "codex", "agy", "cursor", "opencode"]) {
      const sessionId = `sess-${engine}`;
      const workspacePath = "/repo";
      const key = `${workspacePath}::${engine}/${sessionId}`;
      let state = {
        openTabs: [{ engine, sessionId, workspacePath }],
        models: {},
        efforts: {},
        streamingByKey: { [key]: true as const },
        retryingByKey: {},
        archivedSessionKeys: {},
        sessions: [],
        bySession: {
          [key]: {
            ...EMPTY_SESSION,
            streaming: true,
            messages: [
              { seq: 1, role: "user" as const, text: "修复空指针异常" },
              { seq: 2, role: "assistant" as const, text: "已定位并修复，是否运行回归测试？", live: true },
            ],
          },
        },
      } as unknown as ChatStore;

      const deps: EngineEventDeps = {
        set: (fn) => {
          state = { ...state, ...fn(state) };
        },
        get: () => state,
        drainQueue: vi.fn(),
        markUnseenIfBackground: vi.fn(),
        upsertSessionMeta: vi.fn(),
      };

      handleEngineEvents(
        [
          {
            runId: `run-${engine}-1`,
            sessionId,
            engine,
            seq: 3,
            kind: "done",
            data: { usage: null },
          },
        ],
        deps,
      );

      await Promise.resolve();
      expect(spy).toHaveBeenLastCalledWith([
        {
          user: "修复空指针异常",
          assistant: "已定位并修复，是否运行回归测试？",
        },
      ]);
      expect(getComposerPrediction(key)).toBe("运行单元测试并验证结果");

      // Starting the next turn immediately clears the prediction.
      handleEngineEvents(
        [
          {
            runId: `run-${engine}-2`,
            sessionId,
            engine,
            seq: 4,
            kind: "delta",
            data: "好的",
          },
        ],
        deps,
      );
      expect(getComposerPrediction(key)).toBeNull();
    }
  });

  it("preserves prediction across turn_complete followed by done without duplicate IPC calls", async () => {
    const spy = vi
      .spyOn(ipc, "predictNextPrompt")
      .mockResolvedValue("运行测试并提交变更");

    const key = "/repo::codex/s-tc";
    let state = {
      openTabs: [{ engine: "codex", sessionId: "s-tc", workspacePath: "/repo" }],
      models: {},
      efforts: {},
      streamingByKey: { [key]: true as const },
      retryingByKey: {},
      archivedSessionKeys: {},
      sessions: [],
      bySession: {
        [key]: {
          ...EMPTY_SESSION,
          streaming: true,
          messages: [
            { seq: 1, role: "user" as const, text: "实现输入框预测" },
            { seq: 2, role: "assistant" as const, text: "已完成实现，是否运行测试并提交？", live: true },
          ],
        },
      },
    } as unknown as ChatStore;

    const deps: EngineEventDeps = {
      set: (fn) => {
        state = { ...state, ...fn(state) };
      },
      get: () => state,
      drainQueue: vi.fn(),
      markUnseenIfBackground: vi.fn(),
      upsertSessionMeta: vi.fn(),
    };

    handleEngineEvents(
      [
        {
          runId: "run-tc-1",
          sessionId: "s-tc",
          engine: "codex",
          seq: 3,
          kind: "turn_complete",
          data: { usage: null },
        },
      ],
      deps,
    );

    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getComposerPrediction(key)).toBe("运行测试并提交变更");

    handleEngineEvents(
      [
        {
          runId: "run-tc-1",
          sessionId: "s-tc",
          engine: "codex",
          seq: 4,
          kind: "done",
          data: { usage: null },
        },
      ],
      deps,
    );

    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getComposerPrediction(key)).toBe("运行测试并提交变更");
  });

  it("deduplicates idle-session prediction requests for the same settled turn and migrates draft keys", async () => {
    const spy = vi
      .spyOn(ipc, "predictNextPrompt")
      .mockResolvedValue("继续检查下一个模块");

    const draftKey = "/repo::claude/draft";
    const nativeKey = "/repo::claude/s-native";
    const messages = [
      { seq: 1, ts: "1", role: "user", text: "检查认证模块" },
      { seq: 2, ts: "2", role: "assistant", text: "认证模块正常，是否继续检查下一个模块？" },
    ];

    requestComposerPrediction(draftKey, messages);
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getComposerPrediction(draftKey)).toBe("继续检查下一个模块");

    migrateComposerPredictionSessionKey(draftKey, nativeKey);
    expect(getComposerPrediction(draftKey)).toBeNull();
    expect(getComposerPrediction(nativeKey)).toBe("继续检查下一个模块");

    // Repeated idle check on the same settled turn does not re-query Codex GPT.
    requestComposerPrediction(nativeKey, messages);
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getComposerPrediction(nativeKey)).toBe("继续检查下一个模块");

    // After user dismisses, the same turn is not re-requested until a new turn settles.
    clearComposerPrediction(nativeKey);
    expect(getComposerPrediction(nativeKey)).toBeNull();
    requestComposerPrediction(nativeKey, messages);
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getComposerPrediction(nativeKey)).toBeNull();
  });

  it("discards late prediction responses if a new turn started or prediction was cleared", async () => {
    let resolvePrediction: ((val: string | null) => void) | null = null;
    vi.spyOn(ipc, "predictNextPrompt").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePrediction = resolve;
        }),
    );

    const key = "/repo::agy/s-late";
    let state = {
      openTabs: [{ engine: "agy", sessionId: "s-late", workspacePath: "/repo" }],
      models: {},
      efforts: {},
      streamingByKey: { [key]: true as const },
      retryingByKey: {},
      archivedSessionKeys: {},
      sessions: [],
      bySession: {
        [key]: {
          ...EMPTY_SESSION,
          streaming: true,
          messages: [
            { seq: 1, role: "user" as const, text: "检查性能瓶颈" },
            { seq: 2, role: "assistant" as const, text: "发现两处热点。" },
          ],
        },
      },
    } as unknown as ChatStore;

    const deps: EngineEventDeps = {
      set: (fn) => {
        state = { ...state, ...fn(state) };
      },
      get: () => state,
      drainQueue: vi.fn(),
      markUnseenIfBackground: vi.fn(),
      upsertSessionMeta: vi.fn(),
    };

    handleEngineEvents(
      [
        {
          runId: "run-late-1",
          sessionId: "s-late",
          engine: "agy",
          seq: 3,
          kind: "done",
          data: { usage: null },
        },
      ],
      deps,
    );

    clearComposerPrediction(key);
    resolvePrediction!("优化第一处热点");
    await Promise.resolve();
    expect(getComposerPrediction(key)).toBeNull();
  });
});
