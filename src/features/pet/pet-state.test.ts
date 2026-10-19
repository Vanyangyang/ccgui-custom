import { describe, expect, it } from "vitest";
import { derivePetStates } from "./pet-state";

const chat = (session: Record<string, unknown>) => ({ bySession: { current: session } }) as never;
const mission = (runs: Record<string, unknown>) => ({ runs }) as never;

const firstStatus = (
  chatState: Parameters<typeof derivePetStates>[0],
  missionState: Parameters<typeof derivePetStates>[1],
) => derivePetStates(chatState, missionState)[0]?.status;

describe("pet state aggregation", () => {
  it("works on the v1.0.8 session shape without PR #1266 task signals", () => {
    const states = derivePetStates(
      chat({
        error: null,
        streaming: true,
        messages: [{ role: "thinking", text: "正在分析", live: true }],
      }),
      mission({}),
    );

    expect(states[0]?.status).toBe("running");
    expect(states[0]?.activity).toBe("thinking");
  });

  it("prioritizes terminal failures over waiting", () => {
    expect(
      firstStatus(
        chat({
          error: null,
          streaming: false,
          backgroundActive: false,
          awaitingTasks: true,
          tasks: [{ status: "failed" }],
        }),
        mission({}),
      ),
    ).toBe("failed");
  });

  it("shows resumed session activity after a child task failed", () => {
    expect(
      firstStatus(
        chat({
          error: null,
          streaming: true,
          backgroundActive: false,
          awaitingTasks: false,
          tasks: [{ status: "failed" }],
          messages: [],
        }),
        mission({}),
      ),
    ).toBe("running");
  });

  it("includes active mission runs when chat is idle", () => {
    expect(
      firstStatus(
        chat({ error: null, streaming: false, backgroundActive: false, awaitingTasks: false, tasks: [] }),
        mission({
          run: {
            endedAt: undefined,
            cancelled: false,
            interrupted: false,
            tasks: [{ status: "waiting_human" }],
          },
        }),
      ),
    ).toBe("waiting");
  });

  it("reports a failed task inside an active mission run", () => {
    expect(
      firstStatus(
        chat({ error: null, streaming: false, backgroundActive: false, awaitingTasks: false, tasks: [] }),
        mission({
          run: {
            endedAt: undefined,
            cancelled: false,
            tasks: [{ status: "failed" }],
          },
        }),
      ),
    ).toBe("failed");
  });

  it("ignores finished mission runs instead of pinning a stale state", () => {
    const states = derivePetStates(
      chat({ error: null, streaming: false, backgroundActive: false, awaitingTasks: false, tasks: [] }),
      mission({
        failedRun: {
          endedAt: 1000,
          cancelled: false,
          tasks: [{ status: "failed" }],
        },
        doneRun: {
          endedAt: 2000,
          cancelled: false,
          tasks: [{ status: "succeeded" }],
        },
      }),
    );

    expect(states.every((state) => state.sessionKey !== "__mission__")).toBe(true);
  });

  it("ignores cancelled or interrupted mission runs", () => {
    const states = derivePetStates(
      chat({ error: null, streaming: false, backgroundActive: false, awaitingTasks: false, tasks: [] }),
      mission({
        interruptedRun: {
          endedAt: 3000,
          cancelled: true,
          interrupted: true,
          tasks: [{ status: "cancelled" }],
        },
      }),
    );

    expect(states.every((state) => state.sessionKey !== "__mission__")).toBe(true);
  });

  it("keeps concurrent session names attached to their own states", () => {
    const session = (text: string) => ({
      messages: [{ role: "thinking", text, live: true }],
      error: null,
      streaming: true,
      backgroundActive: false,
      awaitingTasks: false,
      tasks: [],
    });
    const states = derivePetStates(
      {
        bySession: {
          "claude/session-a": session("A"),
          "claude/session-b": session("B"),
        },
        sessions: [
          {
            engine: "claude",
            sessionId: "session-a",
            workspacePath: "E:/a",
            title: "会话 A",
            customTitle: null,
          },
          {
            engine: "claude",
            sessionId: "session-b",
            workspacePath: "E:/b",
            title: "会话 B",
            customTitle: null,
          },
        ],
      } as never,
      mission({}),
    );

    expect(states.map((state) => [state.sessionKey, state.sessionName])).toEqual([
      ["claude/session-a", "会话 A"],
      ["claude/session-b", "会话 B"],
    ]);
  });
});
