import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import { pickSavePath } from "./platform";

const runtime = vi.hoisted(() => ({ web: true }));
const translate = vi.hoisted(() => vi.fn((key: string, values?: Record<string, string>) => `${key}:${values?.path ?? values?.filename ?? ""}`));
vi.mock("./transport", () => ({ get isWeb() { return runtime.web; }, serverVersion: vi.fn(), webToken: null }));
vi.mock("./i18n", () => ({ default: { t: translate } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));

beforeEach(() => {
  runtime.web = true; vi.clearAllMocks();
  vi.spyOn(window, "prompt").mockReturnValue(null);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "alert").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("host save path selection", () => {
  it.each(["C:\\exports\\文件.zip", "/home/user/exports/file.zip", "\\\\server\\share\\exports\\file.zip"])("accepts an explicitly confirmed absolute host path: %s", async (path) => {
    vi.mocked(window.prompt).mockReturnValueOnce(`  ${path}  `);
    expect(await pickSavePath("Export", "file.zip")).toBe(path);
    expect(translate).toHaveBeenCalledWith("settings.remoteSavePathPrompt", { filename: "file.zip" });
    expect(translate).toHaveBeenCalledWith("settings.remoteSavePathConfirm", { path });
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([null, "", "   "])("cancels without invoking a native save dialog or overwrite confirmation (%s)", async (path) => {
    vi.mocked(window.prompt).mockReturnValueOnce(path);
    expect(await pickSavePath("Export", "file.zip")).toBeNull();
    expect(window.confirm).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });

  it("cancels if overwrite confirmation is declined", async () => {
    vi.mocked(window.prompt).mockReturnValueOnce("/host/file.zip");
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    expect(await pickSavePath("Export", "file.zip")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["file.zip", "C:file.zip", "/host/folder/", "/host/file\n.zip", "\\server\\file.zip"])("rejects invalid paths visibly before retry or cancellation: %s", async (path) => {
    vi.mocked(window.prompt).mockReturnValueOnce(path).mockReturnValueOnce(null);
    expect(await pickSavePath("Export", "file.zip")).toBeNull();
    expect(window.alert).toHaveBeenCalledWith("settings.remoteSavePathInvalid:");
    expect(window.prompt).toHaveBeenCalledTimes(2); expect(window.confirm).not.toHaveBeenCalled();
  });

  it("allows retry with a valid path after a validation error", async () => {
    vi.mocked(window.prompt).mockReturnValueOnce("relative.zip").mockReturnValueOnce("/host/file.zip");
    expect(await pickSavePath("Export", "file.zip")).toBe("/host/file.zip");
  });

  it("retains the native save dialog for desktop clients", async () => {
    runtime.web = false;
    vi.mocked(save).mockResolvedValueOnce("C:/export/file.zip");
    expect(await pickSavePath("Export", "file.zip")).toBe("C:/export/file.zip");
    expect(save).toHaveBeenCalledWith({ title: "Export", defaultPath: "file.zip" });
    expect(window.prompt).not.toHaveBeenCalled(); expect(window.confirm).not.toHaveBeenCalled();
  });
});
