import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEventPayload } from "@/lib/events";
import { ipc } from "@/lib/ipc";
import { sessionKey, useChatStore } from "./store";
import { EMPTY_SESSION, runRouting } from "./store/stream";
import { useComposerActions } from "./components/use-composer-actions";

/** The composer's submit while a turn is in flight: a Claude CLI that idles with
 *  background tasks running takes the message at once (as the native CLI does),
 *  everything else queues, and an idle session just sends. */

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async (args: { runId?: string }) => ({ runId: args.runId ?? "run-x", sessionId: null })),
    sendFollowUp: vi.fn(async () => true),
    interruptTurn: vi.fn(async () => true),
    interruptSession: vi.fn(async () => true),
    rememberSessionModel: vi.fn(async () => {}),
    rememberSessionEffort: vi.fn(async () => {}),
    rememberSessionProvider: vi.fn(async () => {}),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
    computerUseSetActive: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async (_cb: (events: EngineEventPayload[]) => void) => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/tmp/ws";
const TAB = { engine: "claude", sessionId: "s-1", workspacePath: WS };
const KEY = sessionKey("claude", "s-1", WS);
const RUN = "composer-run";

let submit: ((value: string) => void) | null = null;
let stop: (() => void) | null = null;

function Probe() {
  const streaming = useChatStore((s) => s.bySession[KEY]?.streaming ?? false);
  const actions = useComposerActions({
    active: TAB,
    sessionKey: KEY,
    streaming,
    images: [],
    clearImages: () => {},
    captureImageSubmission: () => () => {},
    importImageFiles: () => {},
    supportsImages: true,
    composerInputRef: { current: null },
  });
  submit = actions.submit;
  stop = actions.handleStop;
  return null;
}

let root: Root;
let host: HTMLDivElement;

/** A launched native run that finished its reply and idles with a task running. */
function seed(activity: "waiting" | "running" | "requires_action" | null, streaming = true) {
  useChatStore.setState({
    active: TAB,
    openTabs: [TAB],
    models: { claude: "claude-sonnet-4" },
    efforts: {},
    providers: {},
    engines: [
      {
        id: "claude",
        available: true,
        enabled: true,
        supportsImages: true,
        supportsComputerUse: true,
        permissions: ["auto"],
      } as never,
    ],
    permission: "auto",
    streamingByKey: streaming ? { [KEY]: true } : {},
    bySession: {
      [KEY]: {
        ...EMPTY_SESSION,
        streaming,
        messages: [{ seq: 1, role: "user", text: "build", ts: null }],
        nativeTaskRunId: RUN,
        nativeActivity: activity,
        liveLaunch: { model: "claude-sonnet-4", effort: null, provider: null, permission: "auto" },
      },
    },
  });
  runRouting.set(RUN, KEY);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  runRouting.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  submit = null;
  stop = null;
});

async function submitText(value: string) {
  seedProbe();
  await act(async () => {
    submit!(value);
  });
}
function seedProbe() {
  act(() => root.render(<Probe />));
}

describe("composer submit while a turn is in flight", () => {
  it("hands the message to a Claude CLI that idles with background tasks running", async () => {
    seed("waiting");
    await submitText("then deploy");
    expect(ipc.sendFollowUp).toHaveBeenCalledWith(expect.objectContaining({ sessionId: RUN, prompt: "then deploy" }));
    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().bySession[KEY].queue).toEqual([]);
    expect(useChatStore.getState().bySession[KEY].messages.at(-1)).toMatchObject({ role: "user", text: "then deploy" });
  });

  it("queues while the CLI is still generating a reply", async () => {
    seed("running");
    await submitText("then deploy");
    expect(ipc.sendFollowUp).not.toHaveBeenCalled();
    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().bySession[KEY].queue.map((q) => q.text)).toEqual(["then deploy"]);
  });

  it.each([null, "running", "waiting", "requires_action"] as const)("the composer's Stop natively interrupts Claude activity %s and keeps its reply and queue", async (activity) => {
    seed(activity);
    useChatStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [KEY]: {
          ...s.bySession[KEY],
          messages: [
            ...s.bySession[KEY].messages,
            { seq: 2, role: "assistant", text: "已输出的内容🙂", ts: null, live: true },
          ],
          queue: [{ id: "next", text: "then deploy", images: [], queuedAt: 0 }],
        },
      },
    }));
    seedProbe();
    await act(async () => stop!());

    expect(ipc.interruptTurn).toHaveBeenCalledTimes(1);
    expect(ipc.interruptTurn).toHaveBeenCalledWith(RUN);
    expect(ipc.interruptSession).not.toHaveBeenCalled();
    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(ipc.sendFollowUp).not.toHaveBeenCalled();
    expect(runRouting.get(RUN)).toBe(KEY);
    expect(useChatStore.getState().bySession[KEY]).toMatchObject({
      streaming: true,
      interrupted: false,
      nativeActivity: activity,
      queueParked: true,
      queue: [{ id: "next", text: "then deploy" }],
    });
    expect(useChatStore.getState().bySession[KEY].interruptRequestedAt).toEqual(expect.any(Number));
    expect(useChatStore.getState().bySession[KEY].messages.at(-1)).toMatchObject({ text: "已输出的内容🙂", live: true });
  });

  it("queues during Claude startup and Send Now requests native interrupt without spawning another process", async () => {
    seed(null);
    await submitText("then deploy");
    const queued = useChatStore.getState().bySession[KEY].queue;
    expect(queued).toMatchObject([{ text: "then deploy" }]);

    await act(async () => useChatStore.getState().sendQueuedNow(queued[0].id));

    expect(ipc.interruptTurn).toHaveBeenCalledTimes(1);
    expect(ipc.interruptTurn).toHaveBeenCalledWith(RUN);
    expect(ipc.interruptSession).not.toHaveBeenCalled();
    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(ipc.sendFollowUp).not.toHaveBeenCalled();
    expect(useChatStore.getState().bySession[KEY].queue).toEqual(queued);
    expect(useChatStore.getState().bySession[KEY].streaming).toBe(true);
  });

  it("queues a computer-use task with its flag, never into the live CLI", async () => {
    seed("waiting");
    await submitText("/ccgui-cua open the calculator");
    expect(ipc.sendFollowUp).not.toHaveBeenCalled();
    expect(useChatStore.getState().bySession[KEY].queue).toMatchObject([
      { text: "open the calculator", computerUse: true },
    ]);
  });

  it("sends an ordinary message when nothing is running", async () => {
    seed("waiting", false);
    await submitText("hello");
    expect(ipc.sendFollowUp).not.toHaveBeenCalled();
    expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ prompt: "hello" }));
  });
});
