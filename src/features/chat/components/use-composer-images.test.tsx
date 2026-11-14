import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { ipc } from "@/lib/ipc";

import { hasComposerImageDraft, subscribeComposerImageDraftOccupation, useComposerImages, type ComposerImageDraft, type ComposerImages } from "./use-composer-images";
import { backgroundDraftBlockReason } from "../store/tabs";
import type { ChatStore } from "../store/types";

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

function Harness({ draftKey, draft }: { draftKey?: string; draft?: ComposerImageDraft }) {
  latest = useComposerImages(draftKey, draft);
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

describe("composer image draft occupation", () => {
  const key = "new:agy:G:/fixture";
  let root: Root;
  let changed: ReturnType<typeof vi.fn>;
  let off: () => void;
  let mounted: boolean;
  beforeEach(async () => {
    vi.clearAllMocks();
    root = createRoot(document.createElement("div"));
    mounted = true;
    changed = vi.fn();
    off = subscribeComposerImageDraftOccupation(changed);
    await act(async () => { root.render(<StrictMode><Harness draftKey={key} /></StrictMode>); });
  });
  afterEach(async () => {
    off();
    if (mounted) await act(async () => { root.unmount(); });
  });

  it("notifies once for pending import occupation, then only when the last attachment clears", async () => {
    const imported = Promise.withResolvers<string[]>();
    vi.mocked(ipc.importAttachments).mockReturnValueOnce(imported.promise);
    await act(async () => { latest.importImageFiles(["/private/a.png"], true); });
    expect(hasComposerImageDraft(key)).toBe(true);
    expect(changed.mock.calls).toEqual([[]]);
    const state = { initialized: true, active: null, openTabs: [], bySession: {}, drafts: {} } as unknown as ChatStore;
    expect(backgroundDraftBlockReason(state, "agy", "G:/fixture")).toBe("user-draft:images");
    await act(async () => { imported.resolve(["/sandbox/a.png"]); });
    await act(async () => { latest.importImageFiles(["/private/b.png"], true); });
    await act(async () => { latest.removeImage("/sandbox/a.png"); });
    expect(changed).toHaveBeenCalledTimes(1);
    await act(async () => { latest.clearImages(); });
    expect(changed.mock.calls).toEqual([[], []]);
    expect(hasComposerImageDraft(key)).toBe(false);
    expect(backgroundDraftBlockReason(state, "agy", "G:/fixture")).toBeNull();
  });

  it("releases a failed import and disposed listeners without exposing any paths", async () => {
    const imported = Promise.withResolvers<string[]>();
    vi.mocked(ipc.importAttachments).mockReturnValueOnce(imported.promise);
    await act(async () => { latest.importImageFiles(["/private/a.png"], true); });
    expect(changed).toHaveBeenCalledTimes(1);
    await act(async () => { imported.reject(new Error("fixture failure")); });
    expect(changed.mock.calls).toEqual([[], []]);
    expect(hasComposerImageDraft(key)).toBe(false);
    off();
    await act(async () => { latest.importImageFiles(["/private/b.png"], true); });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("releases an unmounted pending importer and ignores its late result", async () => {
    const imported = Promise.withResolvers<string[]>();
    vi.mocked(ipc.importAttachments).mockReturnValueOnce(imported.promise);
    await act(async () => { latest.importImageFiles(["/private/a.png"], true); });
    await act(async () => { root.unmount(); }); mounted = false;
    expect(changed).toHaveBeenCalledTimes(2);
    expect(hasComposerImageDraft(key)).toBe(false);
    await act(async () => { imported.resolve(["/sandbox/a.png"]); });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(hasComposerImageDraft(key)).toBe(false);
  });

  it("coalesces effect owner replacement and observes actual key moves", async () => {
    await act(async () => { latest.importImageFiles(["/private/a.png"], true); });
    expect(changed).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(<StrictMode><Harness draftKey={key} /></StrictMode>); });
    expect(changed).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(<StrictMode><Harness draftKey="agy/adopted" /></StrictMode>); });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(hasComposerImageDraft(key)).toBe(false);
    expect(hasComposerImageDraft("agy/adopted")).toBe(true);
    await act(async () => { root.unmount(); }); mounted = false;
    expect(changed).toHaveBeenCalledTimes(3);
    expect(hasComposerImageDraft("agy/adopted")).toBe(false);
  });

  it("observes external durable draft edits and submission cleanup but not occupied path replacements", async () => {
    let paths: string[] = [];
    const draft = (): ComposerImageDraft => ({ paths, getPaths: () => paths, update: updater => { paths = updater(paths); } });
    await act(async () => { root.render(<Harness draftKey={key} draft={draft()} />); });
    paths = ["/private/a.png"];
    await act(async () => { root.render(<Harness draftKey={key} draft={draft()} />); });
    expect(changed).toHaveBeenCalledTimes(1);
    paths = ["/private/b.png"];
    await act(async () => { root.render(<Harness draftKey={key} draft={draft()} />); });
    expect(changed).toHaveBeenCalledTimes(1);
    await act(async () => { latest.captureImageSubmission(paths)(); });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(hasComposerImageDraft(key)).toBe(false);
  });
});
