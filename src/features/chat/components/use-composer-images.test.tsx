import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { ipc } from "@/lib/ipc";

import { useComposerImages, type ComposerImages } from "./use-composer-images";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    importAttachments: vi.fn(async (paths: string[]) =>
      paths.map((p) => `/sandbox/${p.split("/").pop()}`),
    ),
    readFile: vi.fn(async () => ({ kind: "other" })),
    savePastedImage: vi.fn(async () => "/sandbox/pasted.png"),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let latest: ComposerImages;

function Harness() {
  latest = useComposerImages();
  return null;
}

describe("useComposerImages.importImageFiles", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("attaches sandboxed copies of picked images, deduped", async () => {
    await act(async () => {
      latest.importImageFiles(["/tmp/a.png", "/tmp/b.jpg"], true);
    });
    expect(vi.mocked(ipc.importAttachments)).toHaveBeenCalledWith([
      "/tmp/a.png",
      "/tmp/b.jpg",
    ]);
    expect(latest.images).toEqual(["/sandbox/a.png", "/sandbox/b.jpg"]);

    // Picking the same file again must not duplicate the chip.
    await act(async () => {
      latest.importImageFiles(["/tmp/a.png"], true);
    });
    expect(latest.images).toEqual(["/sandbox/a.png", "/sandbox/b.jpg"]);
  });

  it("refuses images for engines without image input, without touching the backend", async () => {
    await act(async () => {
      latest.importImageFiles(["/tmp/a.png"], false);
    });
    expect(latest.images).toEqual([]);
    expect(latest.imageError).toBeTruthy();
    expect(vi.mocked(ipc.importAttachments)).not.toHaveBeenCalled();
  });

  it("surfaces an import failure instead of attaching", async () => {
    vi.mocked(ipc.importAttachments).mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      latest.importImageFiles(["/tmp/a.png"], true);
    });
    expect(latest.images).toEqual([]);
    expect(latest.imageError).toContain("boom");
  });
});
