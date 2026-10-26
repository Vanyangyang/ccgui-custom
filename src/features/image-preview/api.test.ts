import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), web: false }));
vi.mock("@/lib/transport", () => ({ invoke: mocks.invoke, listen: mocks.listen }));
vi.mock("@/lib/platform", () => ({ get isWeb() { return mocks.web; } }));
import { imagePreview } from "./api";
import { loadChatImage } from "@/features/chat/components/chat-image-refs";
describe("preview IPC isolation", () => {
  beforeEach(() => { mocks.invoke.mockReset(); mocks.listen.mockReset(); mocks.web = false; });
  it("forwards the displayed scope without resolving it again", async () => {
    mocks.invoke.mockResolvedValue({ path: "/shown", scope: "directory" });
    await imagePreview.grant("/shown/a.png", "directory", "/shown");
    expect(mocks.invoke).toHaveBeenCalledWith("grant_image_preview", { path: "/shown/a.png", scope: "directory", expectedPath: "/shown" });
  });
  it("refreshes for all permission catalogues and reconnect, then cleans all subscriptions", async () => {
    const callbacks = new Map<string, () => void>(); const stops = Array.from({ length: 4 }, () => vi.fn());
    mocks.listen.mockImplementation(async (name: string, callback: () => void) => { callbacks.set(name, callback); return stops[callbacks.size - 1]; });
    const refresh = vi.fn(); const stop = await imagePreview.changed(refresh);
    const events = ["image-preview-grants://changed", "transport://connected", "granted-roots://changed", "workspace-roots://changed"];
    expect([...callbacks.keys()]).toEqual(events);
    events.forEach(event => callbacks.get(event)!());
    expect(refresh).toHaveBeenCalledTimes(4);
    stop(); stops.forEach(fn => expect(fn).toHaveBeenCalledOnce());
  });
  it.each([0, 1, 2, 3])("cleans all late successful subscriptions if subscription %i fails", async failed => {
    const finishes: Array<(stop: () => void) => void> = [];
    let index = 0;
    mocks.listen.mockImplementation(() => index++ === failed ? Promise.reject(new Error("offline")) : new Promise(resolve => { finishes.push(resolve); }));
    const result = imagePreview.changed(vi.fn());
    const stops = finishes.map(finish => { const stop = vi.fn(); finish(stop); return stop; });
    await expect(result).rejects.toThrow("offline");
    stops.forEach(stop => expect(stop).toHaveBeenCalledOnce());
  });
  it("never requests broad grant_root after an unauthorized desktop read", async () => {
    mocks.invoke.mockRejectedValue("path is outside the registered workspaces: /out/a.png");
    await expect(loadChatImage("/out/a.png")).rejects.toContain("outside");
    expect(mocks.invoke.mock.calls).toEqual([["read_preview_image_bytes", { path: "/out/a.png" }]]);
  });
  it("uses the preview data URL read on web without read_file or grant_root", async () => {
    mocks.web = true;
    mocks.invoke.mockRejectedValue("path is outside the registered workspaces: /out/a.png");
    await expect(loadChatImage("/out/a.png")).rejects.toContain("outside");
    expect(mocks.invoke.mock.calls).toEqual([["read_preview_image", { path: "/out/a.png" }]]);
    await expect(imagePreview.grant("/out/a.png", "directory", "/out")).rejects.toThrow("Desktop only");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
