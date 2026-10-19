import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerFileDrop } from "./use-composer-file-drop";

// jsdom has no __TAURI_INTERNALS__, so the hook takes the web (HTML5) branch.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let latest: { isDragOver: boolean };

function Harness({
  disabled = false,
  onDropPaths,
  onDropFiles,
}: {
  disabled?: boolean;
  onDropPaths?: (paths: string[]) => void;
  onDropFiles?: (files: File[]) => void;
}) {
  const { dropRef, isDragOver } = useComposerFileDrop({
    disabled,
    onDropPaths,
    onDropFiles,
  });
  latest = { isDragOver };
  return (
    <div ref={dropRef} data-testid="zone">
      <span data-testid="child" />
    </div>
  );
}

/** jsdom has no DataTransfer constructor; defineProperty plants a plain
 * object with the exact surface the hook reads (types + files). */
function dragEvent(type: string, dt: { types: string[]; files?: File[] }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dt });
  return event;
}

describe("useComposerFileDrop (web/HTML5 branch)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let zone: HTMLElement;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function render(props: Parameters<typeof Harness>[0]) {
    await act(async () => {
      root.render(<Harness {...props} />);
    });
    zone = container.querySelector("[data-testid='zone']")!;
  }

  it("tracks drag-over state with a child-depth counter", async () => {
    await render({});
    const child = container.querySelector("[data-testid='child']")!;
    const dt = { types: ["Files"] };

    await act(async () => {
      zone.dispatchEvent(dragEvent("dragenter", dt));
    });
    expect(latest.isDragOver).toBe(true);

    // Moving onto a child bubbles enter+leave pairs; the hint must survive.
    await act(async () => {
      child.dispatchEvent(dragEvent("dragenter", dt));
      child.dispatchEvent(dragEvent("dragleave", dt));
    });
    expect(latest.isDragOver).toBe(true);

    await act(async () => {
      zone.dispatchEvent(dragEvent("dragleave", dt));
    });
    expect(latest.isDragOver).toBe(false);
  });

  it("ignores non-file drags (e.g. in-app text drags)", async () => {
    await render({});
    await act(async () => {
      zone.dispatchEvent(dragEvent("dragenter", { types: ["text/plain"] }));
    });
    expect(latest.isDragOver).toBe(false);
  });

  it("routes dropped image blobs to onDropFiles and drops the rest", async () => {
    const onDropFiles = vi.fn();
    await render({ onDropFiles });
    const png = new File(["x"], "a.png", { type: "image/png" });
    const txt = new File(["x"], "b.txt", { type: "text/plain" });

    await act(async () => {
      zone.dispatchEvent(dragEvent("drop", { types: ["Files"], files: [png, txt] }));
    });
    expect(onDropFiles).toHaveBeenCalledWith([png]);
    expect(latest.isDragOver).toBe(false);
  });

  it("attaches nothing when disabled", async () => {
    const onDropFiles = vi.fn();
    await render({ disabled: true, onDropFiles });
    const png = new File(["x"], "a.png", { type: "image/png" });

    await act(async () => {
      zone.dispatchEvent(dragEvent("dragenter", { types: ["Files"] }));
      zone.dispatchEvent(dragEvent("drop", { types: ["Files"], files: [png] }));
    });
    expect(latest.isDragOver).toBe(false);
    expect(onDropFiles).not.toHaveBeenCalled();
  });
});
