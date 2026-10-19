import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationModeRegistry, type PluginConversationProps } from "@ccgui/plugin-sdk";
import { ConversationModePane, ConversationModePicker } from "./ConversationModeHost";
import { getConversationModeState } from "./state";

vi.mock("../runtime/loader", () => ({ notePluginRenderOk: vi.fn(), reportPluginCrash: vi.fn() }));
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("conversation mode host", () => {
  let container: HTMLDivElement;
  let root: Root;
  const disposers: (() => void)[] = [];
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    for (const identity of ["first", "second", "busy", "idle"]) {
      getConversationModeState().setExitBlocked(identity, "plugin:relay", false);
    }
    act(() => root.unmount());
    container.remove();
    disposers.splice(0).forEach((dispose) => dispose());
    vi.restoreAllMocks();
  });
  const render = (node: ReactNode) => act(() => root.render(node));

  it("blocks host and plugin exits synchronously until the plugin clears its lock", () => {
    const onExit = vi.fn();
    let pluginProps: PluginConversationProps;
    const mode = { id: "plugin:relay", label: () => "Relay", component: (props: PluginConversationProps) => {
      pluginProps = props;
      return null;
    } };
    render(<ConversationModePane mode={mode} conversationId="first" workspacePath="/a" language="en" onExit={onExit} />);
    expect(pluginProps!.setExitBlocked).toBeTypeOf("function");
    act(() => {
      pluginProps.setExitBlocked!(true);
      pluginProps.onExit();
    });
    expect(container.querySelector("button")!.disabled).toBe(true);
    act(() => container.querySelector("button")!.click());
    expect(onExit).not.toHaveBeenCalled();
    act(() => pluginProps.setExitBlocked!(false));
    expect(container.querySelector("button")!.disabled).toBe(false);
    act(() => pluginProps.onExit());
    act(() => container.querySelector("button")!.click());
    expect(onExit).toHaveBeenCalledTimes(2);
  });

  it("resets locks between conversations and isolates late callbacks from unmounted panes", () => {
    const onExit = vi.fn();
    let pluginProps: PluginConversationProps;
    const mode = { id: "plugin:relay", label: () => "Relay", component: (props: PluginConversationProps) => {
      pluginProps = props;
      useLayoutEffect(() => { props.setExitBlocked?.(props.conversationId === "busy"); }, [props.conversationId, props.setExitBlocked]);
      return null;
    } };
    render(<ConversationModePane mode={mode} conversationId="busy" workspacePath="/a" language="en" onExit={onExit} />);
    expect(container.querySelector("button")!.disabled).toBe(true);
    const staleProps = pluginProps!;
    render(<ConversationModePane mode={mode} conversationId="idle" workspacePath="/b" language="en" onExit={onExit} />);
    expect(container.querySelector("button")!.disabled).toBe(false);
    act(() => { staleProps.setExitBlocked!(false); staleProps.onExit(); staleProps.setExitBlocked!(true); });
    expect(onExit).not.toHaveBeenCalled();
    expect(container.querySelector("button")!.disabled).toBe(false);
    act(() => pluginProps.onExit());
    expect(onExit).toHaveBeenCalledOnce();
    render(<ConversationModePane mode={mode} conversationId="busy" workspacePath="/a" language="en" onExit={onExit} />);
    expect(container.querySelector("button")!.disabled).toBe(true);
    act(() => staleProps.setExitBlocked!(false));
    expect(container.querySelector("button")!.disabled).toBe(true);
  });

  it("renders installed mode entries, disables busy entry and removes unregistered modes", () => {
    const select = vi.fn();
    const dispose = conversationModeRegistry.register({ id: "plugin:relay", label: () => "Relay", component: () => null });
    disposers.push(dispose);
    render(<ConversationModePicker disabled onSelect={select} />);
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(select).not.toHaveBeenCalled();
    render(<ConversationModePicker disabled={false} onSelect={select} />);
    act(() => container.querySelector("button")!.click());
    expect(select).toHaveBeenCalledWith("plugin:relay");
    act(dispose);
    expect(container.textContent).toBe("");
  });

  it("passes current identity, workspace, language and exit; remounts on identity changes", () => {
    const propsSeen: PluginConversationProps[] = [];
    const onExit = vi.fn();
    const mode = { id: "plugin:relay", label: () => "Relay", component: (props: PluginConversationProps) => {
      propsSeen.push(props);
      return <textarea defaultValue={props.conversationId} />;
    } };
    render(<ConversationModePane mode={mode} conversationId="first" workspacePath="/a" language="en" onExit={onExit} />);
    const input = container.querySelector("textarea")!;
    input.value = "private transcript";
    render(<ConversationModePane mode={mode} conversationId="first" workspacePath="/a" language="zh" onExit={onExit} />);
    expect(container.querySelector("textarea")!.value).toBe("private transcript");
    render(<ConversationModePane mode={mode} conversationId="second" workspacePath="/b" language="zh" onExit={onExit} />);
    expect(container.querySelector("textarea")!.value).toBe("second");
    expect(propsSeen.at(-1)).toEqual({ conversationId: "second", workspacePath: "/b", language: "zh", onExit: expect.any(Function), setExitBlocked: expect.any(Function) });
    act(() => container.querySelector("button")!.click());
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("contains a plugin render failure while keeping the host exit reachable", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onExit = vi.fn();
    const mode = { id: "plugin:broken", label: () => "Broken", component: () => { throw new Error("broken"); } };
    render(<ConversationModePane mode={mode} conversationId="first" workspacePath="/a" language="en" onExit={onExit} />);
    expect(container.textContent).not.toContain("private transcript");
    act(() => container.querySelector("button")!.click());
    expect(onExit).toHaveBeenCalledOnce();
  });
});
