import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { ImagePreviewGrantsSettings } from "./ImagePreviewGrantsSettings";
import { imagePreview } from "./api";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/platform", () => ({ isWeb: false }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.spyOn(imagePreview, "changed").mockResolvedValue(() => {});
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
it("lists scopes and revokes the exact stored key before removing a row", async () => {
  const entry = { path: "C:/art/missing.png", scope: "file" as const };
  vi.spyOn(imagePreview, "list").mockResolvedValue([entry]);
  const revoke = vi.spyOn(imagePreview, "revoke").mockRejectedValueOnce(new Error("locked"));
  await act(async () => root.render(<ImagePreviewGrantsSettings />));
  expect(container.textContent).toContain(entry.path);
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(revoke).toHaveBeenCalledWith(entry.path, "file");
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).toContain(entry.path);
  revoke.mockResolvedValue(); vi.mocked(imagePreview.list).mockResolvedValue([]);
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.textContent).not.toContain(entry.path);
});
it("cleans up a late subscription and ignores late list results after unmount", async () => {
  let finish!: (value: []) => void, subscribed!: (stop: () => void) => void;
  vi.spyOn(imagePreview, "list").mockImplementation(() => new Promise(r => { finish = r; }));
  vi.mocked(imagePreview.changed).mockImplementation(() => new Promise(r => { subscribed = r; }));
  await act(async () => root.render(<ImagePreviewGrantsSettings />));
  await act(async () => root.render(null));
  const stop = vi.fn();
  await act(async () => { subscribed(stop); finish([]); });
  expect(stop).toHaveBeenCalledOnce(); expect(container.textContent).toBe("");
});
it("refreshes the grant list after a reconnect notification", async () => {
  let refresh!: () => void;
  vi.mocked(imagePreview.changed).mockImplementation(async callback => { refresh = callback; return () => {}; });
  vi.spyOn(imagePreview, "list").mockResolvedValue([{ path: "C:/art", scope: "directory" }]);
  await act(async () => root.render(<ImagePreviewGrantsSettings />));
  expect(container.textContent).toContain("C:/art");
  vi.mocked(imagePreview.list).mockResolvedValue([]);
  await act(async () => refresh());
  expect(container.textContent).not.toContain("C:/art");
});
