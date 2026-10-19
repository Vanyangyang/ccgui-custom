import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerSlotExtras } from "./composer-slot-extras";
import { composerSlotRegistry } from "@ccgui/plugin-sdk";
import type { ComposerSlotDef, Disposer } from "@ccgui/plugin-sdk";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const marker = (text: string) => () => <span data-testid={text}>{text}</span>;

function def(id: string, slot: ComposerSlotDef["slot"], order?: number): ComposerSlotDef {
  return { id, slot, order, component: marker(id) };
}

describe("ComposerSlotExtras", () => {
  let container: HTMLDivElement;
  let root: Root;
  let disposers: Disposer[];

  const register = (entry: ComposerSlotDef) => {
    const dispose = composerSlotRegistry.register(entry);
    disposers.push(dispose);
    return dispose;
  };

  const render = (slot: ComposerSlotDef["slot"]) => {
    act(() => {
      root.render(<ComposerSlotExtras slot={slot} />);
    });
  };

  beforeEach(() => {
    disposers = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    for (const dispose of disposers) dispose();
  });

  it("renders only the extras registered for its slot", () => {
    register(def("plugin:alpha:add", "addMenu"));
    register(def("plugin:alpha:cli", "cliMenu"));
    render("addMenu");
    expect(container.querySelector('[data-testid="plugin:alpha:add"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plugin:alpha:cli"]')).toBeNull();
  });

  it("orders extras by ascending order; undefined order sorts last, ties break by id", () => {
    register(def("plugin:alpha:late", "addMenu", 10));
    register(def("plugin:alpha:first", "addMenu"));
    register(def("plugin:alpha:mid", "addMenu", 5));
    render("addMenu");
    const ids = [...container.querySelectorAll("[data-testid]")].map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(ids).toEqual(["plugin:alpha:mid", "plugin:alpha:late", "plugin:alpha:first"]);
  });

  it("the registration disposer removes the extra from the slot", () => {
    const dispose = register(def("plugin:alpha:add", "addMenu"));
    render("addMenu");
    expect(container.querySelector('[data-testid="plugin:alpha:add"]')).not.toBeNull();
    act(() => dispose());
    expect(container.querySelector('[data-testid="plugin:alpha:add"]')).toBeNull();
  });

  it("a crashing plugin extra is isolated by PluginBoundary; siblings keep rendering", () => {
    const Boom = () => {
      throw new Error("boom");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    register({ id: "plugin:alpha:boom", slot: "addMenu", component: Boom });
    register(def("plugin:alpha:ok", "addMenu", 1));
    render("addMenu");
    expect(container.querySelector('[data-testid="plugin:alpha:ok"]')).not.toBeNull();
    vi.restoreAllMocks();
  });
});
