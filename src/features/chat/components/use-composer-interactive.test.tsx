import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerActions } from "./use-composer-actions";
import { sessionKey, useChatStore } from "../store";
import { EMPTY_SESSION } from "../store/stream";
import { useSlashCommandStore } from "@/components/application/ai-chat/slash-commands";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";

vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(), listen: vi.fn(async () => () => {}), webToken: null }));
const original = useChatStore.getState();
const sends = vi.fn(async () => {}), errors = vi.fn();
let root: Root, host: HTMLDivElement;
const tab = { engine: "codex", sessionId: "interactive-one", workspacePath: "/ui-fixture" };
function Harness({ engine = "codex", text = "/ui 做一个预算表" }) {
  const active = { ...tab, engine };
  const actions = useComposerActions({ active, sessionKey: sessionKey(engine, tab.sessionId, tab.workspacePath), streaming: false,
    images: [], clearImages: vi.fn(), captureImageSubmission: () => vi.fn(), importImageFiles: vi.fn(), supportsImages: true,
    composerInputRef: createRef<ComposerInputHandle>() });
  return <button onClick={() => actions.submit(text)}>submit</button>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); useSlashCommandStore.setState({ byRoot: {} });
  const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
  useChatStore.setState({ ...original, active: tab, openTabs: [tab], drafts: { [key]: "/ui 做一个预算表" }, bySession: { [key]: { ...EMPTY_SESSION } },
    streamingByKey: {}, send: sends, setSessionError: errors });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useChatStore.setState(original, true); });

describe("retired /ui app command", () => {
  it("sends /ui text verbatim through the ordinary path for every engine", async () => {
    for (const engine of ["codex", "claude"]) {
      const active = { ...tab, engine };
      await act(async () => useChatStore.setState({ active, openTabs: [active] }));
      await act(async () => root.render(<Harness engine={engine} />));
      await act(async () => host.querySelector("button")!.click());
      expect(sends).toHaveBeenLastCalledWith("/ui 做一个预算表", [], undefined, active);
    }
    expect(sends).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
  });
});
