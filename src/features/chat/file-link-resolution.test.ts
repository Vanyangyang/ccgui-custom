import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileIndexEntry } from "@/lib/ipc";
import { resolveChatFileLink } from "./file-link-resolution";

const mocks = vi.hoisted(() => ({
  listDir: vi.fn(async (_path: string): Promise<{ name: string }[]> => []),
  listFileIndex: vi.fn(async (_path: string): Promise<FileIndexEntry[]> => []),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mocks }));

const WS = "S:\\AIWorker\\ZZZrePatch";

beforeEach(() => {
  mocks.listDir.mockReset();
  mocks.listFileIndex.mockReset();
  mocks.listDir.mockResolvedValue([]);
  mocks.listFileIndex.mockResolvedValue([]);
});

describe("resolveChatFileLink", () => {
  it("keeps the workspace-anchored candidate when its file shows up in the parent listing", async () => {
    mocks.listDir.mockResolvedValueOnce([{ name: "app.exe" }]);
    const got = await resolveChatFileLink("release/app.exe", WS);
    expect(got).toBe("S:\\AIWorker\\ZZZrePatch/release/app.exe");
    expect(mocks.listFileIndex).not.toHaveBeenCalled();
  });

  it("finds a file nested below the workspace root through the index", async () => {
    mocks.listDir.mockRejectedValueOnce(new Error("missing"));
    mocks.listFileIndex.mockResolvedValueOnce([
      { rel: "ZZZrePatch/release/ZZZrePatch.exe", isDir: false },
      { rel: "ZZZrePatch/dist/ZZZrePatch.exe", isDir: false },
    ]);
    const got = await resolveChatFileLink("release/ZZZrePatch.exe", WS);
    expect(got).toBe("S:\\AIWorker\\ZZZrePatch/ZZZrePatch/release/ZZZrePatch.exe");
    // Build outputs are gitignored: the fallback index must include them.
    expect(mocks.listFileIndex).toHaveBeenCalledWith(WS, true);
  });

  it("applies the same fallback to an absolute link that resolves under the workspace", async () => {
    mocks.listDir.mockRejectedValueOnce(new Error("missing"));
    mocks.listFileIndex.mockResolvedValueOnce([
      { rel: "ZZZrePatch/release/ZZZrePatch.exe", isDir: false },
    ]);
    const got = await resolveChatFileLink(
      "S:\\AIWorker\\ZZZrePatch\\release\\ZZZrePatch.exe",
      WS,
    );
    expect(got).toBe("S:\\AIWorker\\ZZZrePatch/ZZZrePatch/release/ZZZrePatch.exe");
  });

  it("does not guess when the basename alone is ambiguous", async () => {
    mocks.listDir.mockRejectedValueOnce(new Error("missing"));
    mocks.listFileIndex.mockResolvedValueOnce([
      { rel: "dist/app.exe", isDir: false },
      { rel: "release/app.exe", isDir: false },
    ]);
    const got = await resolveChatFileLink("app.exe", WS);
    expect(got).toBe("S:\\AIWorker\\ZZZrePatch/app.exe");
  });

  it("leaves paths outside the workspace as written and never probes them", async () => {
    const got = await resolveChatFileLink("D:\\other\\tool.exe", WS);
    expect(got).toBe("D:\\other\\tool.exe");
    expect(mocks.listDir).not.toHaveBeenCalled();
    expect(mocks.listFileIndex).not.toHaveBeenCalled();
  });

  it("returns null for non-path inputs", async () => {
    expect(await resolveChatFileLink("~/notes.txt", WS)).toBeNull();
    expect(await resolveChatFileLink("   ", WS)).toBeNull();
  });
});
