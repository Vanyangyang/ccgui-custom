import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PluginAvatar } from "./PluginAvatar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PluginAvatar", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;
  });

  async function render(node: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
    return container;
  }

  it("shows the GitHub image when a URL is given, the initial otherwise", async () => {
    const view = await render(
      <PluginAvatar
        id="libo-zhou"
        name="libo-zhou"
        src="https://github.com/libo-zhou.png?size=40"
      />,
    );
    expect(view.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe(
      "https://github.com/libo-zhou.png?size=40",
    );
    expect(view.textContent).toBe("");

    await act(async () => {
      root!.render(<PluginAvatar id="libo-zhou" name="libo-zhou" />);
    });
    expect(view.querySelector("img")).toBeNull();
    expect(view.textContent).toBe("L");
  });

  it("falls back to the initial when the image fails, and retries a new src", async () => {
    const view = await render(
      <PluginAvatar
        id="libo-zhou"
        name="libo-zhou"
        src="https://github.com/libo-zhou.png?size=40"
      />,
    );

    await act(async () => {
      view.querySelector<HTMLImageElement>("img")!.dispatchEvent(new Event("error"));
    });
    expect(view.querySelector("img")).toBeNull();
    expect(view.textContent).toBe("L");

    // A recycled row gets a different author: the failed URL must not stick.
    await act(async () => {
      root!.render(
        <PluginAvatar
          id="zhujiuyi"
          name="zhujiuyi"
          src="https://github.com/zhujiuyi.png?size=40"
        />,
      );
    });
    expect(view.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe(
      "https://github.com/zhujiuyi.png?size=40",
    );
  });
});
