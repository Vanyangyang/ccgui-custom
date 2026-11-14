import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useChatStore, sessionKey } from "../store";
import { EMPTY_SESSION, applyStreamParts, resolveSessionModel } from "../store/stream";
import type { Message } from "@/lib/ipc";
import { useTabModelDisplay } from "./use-tab-model-display";

// React's act() environment flag — a well-known global the runtime can't
// validate, so a named cast with no narrowing is the right boundary.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/ws";
const SID = "s-1";
const KEY = sessionKey("omp", SID, WS);
const ENGINE_DEFAULT = { omp: "medium" as const };

/** Reads the picker's inputs straight off the store, the way the composer does. */
function Probe() {
  const active = useChatStore((s) => s.active);
  const activeEngine = useChatStore((s) => s.activeEngine);
  const efforts = useChatStore((s) => s.efforts);
  const key = active
    ? sessionKey(active.engine, active.sessionId, active.workspacePath)
    : "";
  const { displayEfforts } = useTabModelDisplay({
    active,
    activeEngine,
    sessionKey: key,
    models: {},
    efforts,
    providers: {},
  });
  return (
    <span data-testid="effort">{displayEfforts[activeEngine] ?? ""}</span>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function shownEffort() {
  return container.querySelector("[data-testid='effort']")?.textContent ?? "";
}

describe("the picker follows the session, not a stale tab field", () => {
  it.each(["draft", "session", "history", "default"])(
    "shows legacy Claude ultra as max when restored from %s",
    async (source) => {
      const tab = {
        engine: "claude",
        sessionId: source === "draft" ? null : SID,
        workspacePath: WS,
        ...(source === "draft" ? { effort: "ultra" as const } : {}),
      };
      const key = sessionKey(tab.engine, tab.sessionId, WS);
      useChatStore.setState({
        activeEngine: "claude",
        active: tab,
        openTabs: [tab],
        efforts: { claude: source === "default" ? "ultra" : "medium" },
        bySession: {
          [key]: {
            ...EMPTY_SESSION,
            ...(source === "session" ? { activeEffort: "ultra" } : {}),
            messages: source === "history"
              ? [{ seq: 1, role: "assistant", text: "Done", ts: null, effort: "ultra" }]
              : [],
          },
        },
      });

      await act(async () => root.render(<Probe />));

      expect(shownEffort()).toBe("max");
    },
  );

  it("keeps ultra available for other engines", async () => {
    const tab = { engine: "omp", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      activeEngine: "omp", active: tab, openTabs: [tab],
      efforts: ENGINE_DEFAULT,
      bySession: { [KEY]: { ...EMPTY_SESSION, activeEffort: "ultra" } },
    });

    await act(async () => root.render(<Probe />));

    expect(shownEffort()).toBe("ultra");
  });

  it("shows the session's own level when the tab still carries an older one", async () => {
    const tab = { engine: "omp", sessionId: SID, workspacePath: WS, effort: "max" as const };
    useChatStore.setState({
      activeEngine: "omp",
      openTabs: [tab],
      active: tab,
      efforts: ENGINE_DEFAULT,
      bySession: { [KEY]: { ...EMPTY_SESSION, activeEffort: "low" } },
    });

    await act(async () => root.render(<Probe />));

    // The persisted tab field used to win forever, so a level changed in
    // another window never reached this picker.
    expect(shownEffort()).toBe("low");
  });

  it("still honours a starting level chosen on a not-yet-created chat", async () => {
    const tab = { engine: "omp", sessionId: null, workspacePath: WS, effort: "high" as const };
    useChatStore.setState({
      activeEngine: "omp",
      openTabs: [tab],
      active: tab,
      efforts: ENGINE_DEFAULT,
      bySession: {},
    });

    await act(async () => root.render(<Probe />));

    expect(shownEffort()).toBe("high");
  });

  it("falls back to the engine default for a session that never recorded one", async () => {
    const tab = { engine: "omp", sessionId: SID, workspacePath: WS };
    useChatStore.setState({
      activeEngine: "omp",
      openTabs: [tab],
      active: tab,
      efforts: ENGINE_DEFAULT,
      bySession: { [KEY]: { ...EMPTY_SESSION } },
    });

    await act(async () => root.render(<Probe />));

    expect(shownEffort()).toBe("medium");
  });
});

describe("draft changes do not rescan immutable model/effort history", () => {
  it("keeps narrow subscribers quiet without scanning 20,000 rows on each keystroke", async () => {
    let modelReads = 0, effortReads = 0, renders = 0;
    const tab = { engine: "claude", sessionId: "history", workspacePath: WS };
    const key = sessionKey(tab.engine, tab.sessionId, WS);
    const messages: Message[] = Array.from({ length: 20000 }, (_, seq) => ({ seq, role: "assistant", text: "历史中文🙂", ts: null,
      get model() { modelReads++; return undefined; }, get effort() { effortReads++; return undefined; },
    }));
    useChatStore.setState({ active: tab, openTabs: [tab], activeEngine: "claude", drafts: {}, models: {}, efforts: {},
      bySession: { [key]: { ...EMPTY_SESSION, messages } } });
    function HistoryProbe() {
      renders++;
      useTabModelDisplay({ active: tab, activeEngine: "claude", sessionKey: key, models: {}, efforts: {}, providers: {} });
      // ChatConversation also resolves this scalar for the Claude assist control.
      useChatStore(s => resolveSessionModel(tab, s.bySession[key], s.models.claude));
      return null;
    }
    await act(async () => root.render(<HistoryProbe />));
    expect(modelReads).toBeGreaterThanOrEqual(20000); expect(effortReads).toBeGreaterThanOrEqual(20000);
    modelReads = 0; effortReads = 0; renders = 0;
    for (let index = 0; index < 20; index++) {
      await act(async () => useChatStore.getState().setDraft(key, "逐键中文👩🏽‍💻 " + index));
    }
    expect(renders).toBe(0);
    expect(modelReads).toBe(0);
    expect(effortReads).toBe(0);
  });

  it("refreshes changed history and active overrides while text-only stream updates do not rerender the picker", async () => {
    const first = { engine: "claude", sessionId: "first", workspacePath: WS };
    const second = { engine: "claude", sessionId: "second", workspacePath: WS };
    const firstKey = sessionKey(first.engine, first.sessionId, WS), secondKey = sessionKey(second.engine, second.sessionId, WS);
    const row: Message = { seq: 1, role: "assistant", text: "start", ts: null, model: "history-first", effort: "low" };
    useChatStore.setState({ active: first, openTabs: [first, second], activeEngine: "claude", drafts: {}, models: { claude: "default-model" }, efforts: { claude: "medium" },
      bySession: { [firstKey]: { ...EMPTY_SESSION, messages: [row] },
        [secondKey]: { ...EMPTY_SESSION, messages: [{ ...row, model: "history-second", effort: "high" }] } } });
    let renders = 0;
    function SelectionProbe() {
      renders++;
      const active = useChatStore(s => s.active), models = useChatStore(s => s.models), efforts = useChatStore(s => s.efforts);
      const key = active ? sessionKey(active.engine, active.sessionId, active.workspacePath) : "";
      const display = useTabModelDisplay({ active, activeEngine: "claude", sessionKey: key, models, efforts, providers: {} });
      return <span data-model={display.displayModels.claude} data-effort={display.displayEfforts.claude} />;
    }
    const shown = () => ({ model: container.querySelector("[data-model]")?.getAttribute("data-model"), effort: container.querySelector("[data-effort]")?.getAttribute("data-effort") });
    const patch = async (change: Partial<typeof EMPTY_SESSION>) => act(async () => useChatStore.setState(s => ({ bySession: { ...s.bySession, [firstKey]: { ...s.bySession[firstKey], ...change } } })));
    await act(async () => root.render(<SelectionProbe />));
    expect(shown()).toEqual({ model: "history-first", effort: "low" });
    // A newly appended assistant row carries fresh model/effort provenance.
    await patch({ messages: applyStreamParts([row], [{ kind: "delta", text: "new reply" }], "history-new", "ultra") });
    expect(shown()).toEqual({ model: "history-new", effort: "max" });
    const live = useChatStore.getState().bySession[firstKey].messages;
    renders = 0;
    await patch({ messages: applyStreamParts(live, [{ kind: "delta", text: " 中文🙂" }], "history-new", "ultra") });
    expect(renders).toBe(0); // Still scalar subscriptions, never the messages array.
    // History restore/replacement must invalidate both raw-field caches.
    await patch({ messages: [{ ...row, model: "restored", effort: "high" }] });
    expect(shown()).toEqual({ model: "restored", effort: "high" });
    const sameHistory = useChatStore.getState().bySession[firstKey].messages;
    await patch({ activeModel: "reported", activeEffort: "medium" });
    expect(useChatStore.getState().bySession[firstKey].messages).toBe(sameHistory);
    expect(shown()).toEqual({ model: "reported", effort: "medium" });
    await act(async () => useChatStore.setState({ active: { ...first, model: "tab-choice", effort: "max" } }));
    expect(shown()).toEqual({ model: "tab-choice", effort: "medium" }); // Existing-session tab effort remains ignored.
    await act(async () => useChatStore.setState({ active: second }));
    expect(shown()).toEqual({ model: "history-second", effort: "high" });
    await act(async () => useChatStore.setState({ active: first }));
    await patch({ activeModel: null, activeEffort: null });
    expect(shown()).toEqual({ model: "restored", effort: "high" });
  });
});
