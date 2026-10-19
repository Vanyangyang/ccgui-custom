import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/i18n";
import { pageRegistry } from "@ccgui/plugin-sdk";
import type { Disposer, PageDef } from "@ccgui/plugin-sdk";
import PluginPageHost from "./PluginPageHost";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PluginPageHost", () => {
  let container: HTMLDivElement;
  let root: Root;
  let disposers: Disposer[];

  const register = (def: PageDef) => {
    act(() => {
      disposers.push(pageRegistry.register(def));
    });
  };

  const renderAt = (path: string) => {
    act(() =>
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/" element={<div data-testid="chat-root">chat</div>} />
            <Route path="/p/:pageId" element={<PluginPageHost />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
  };

  beforeEach(() => {
    disposers = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      for (const dispose of disposers.splice(0)) dispose();
    });
    act(() => root.unmount());
    container.remove();
  });

  it("renders the registered page as an overlay with its title", () => {
    register({
      id: "plugin:demo:main",
      title: () => "Demo Page",
      component: () => <div>demo body</div>,
    });
    renderAt("/p/plugin:demo:main");

    const overlay = container.querySelector("dialog");
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector("h1")!.textContent).toBe("Demo Page");
    expect(overlay!.textContent).toContain("demo body");
  });

  it("an unknown page id falls back to the chat root", () => {
    renderAt("/p/plugin:ghost:missing");

    expect(container.querySelector("dialog")).toBeNull();
    expect(container.querySelector('[data-testid="chat-root"]')).not.toBeNull();
  });

  it("the close button navigates back to the chat root when there is no in-app history", () => {
    register({
      id: "plugin:demo:main",
      title: () => "Demo Page",
      component: () => <div>demo body</div>,
    });
    renderAt("/p/plugin:demo:main");

    const closeButton = container.querySelector("dialog button")!;
    act(() => {
      closeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("dialog")).toBeNull();
    expect(container.querySelector('[data-testid="chat-root"]')).not.toBeNull();
  });
});
