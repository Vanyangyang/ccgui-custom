import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent } from "@/lib/ipc";
import { installFilesBridge, readRemoteAware } from "./remote-files";

const text = (body: string): FileContent => ({
  kind: "text",
  text: body,
  dataUrl: null,
  truncated: false,
});

function bridge() {
  const b = window.__ccguiFiles;
  if (!b) throw new Error("files bridge not installed");
  return b;
}

describe("readRemoteAware", () => {
  beforeEach(() => {
    installFilesBridge(vi.fn(async () => {}));
  });
  afterEach(() => {
    bridge().registerRemoteFileReader(null);
  });

  it("reader 命中:返回远端内容并标记 readOnly(不借用 truncated)", async () => {
    bridge().registerRemoteFileReader(async () => text("remote"));
    const localRead = vi.fn(async () => text("local"));
    const out = await readRemoteAware("//wsl$/u/a.ts", localRead);
    expect(out.text).toBe("remote");
    expect(out.readOnly).toBe(true);
    expect(out.truncated).toBe(false);
    expect(localRead).not.toHaveBeenCalled();
    expect(bridge().isRemote("//wsl$/u/a.ts")).toBe(true);
  });

  it("reader 拒绝(null):回退本地读,不标记 remote", async () => {
    bridge().registerRemoteFileReader(async () => null);
    const out = await readRemoteAware("/local/a.ts", async () => text("local"));
    expect(out.text).toBe("local");
    expect(out.readOnly).toBeUndefined();
    expect(bridge().isRemote("/local/a.ts")).toBe(false);
  });

  it("reader 抛错:同样回退本地读(插件故障不拖垮本地管线)", async () => {
    bridge().registerRemoteFileReader(async () => {
      throw new Error("ssh down");
    });
    const out = await readRemoteAware("/local/a.ts", async () => text("local"));
    expect(out.text).toBe("local");
  });

  it("注销 reader 即清空 remotePaths:历史远端路径不再被误判只读", async () => {
    bridge().registerRemoteFileReader(async () => text("remote"));
    await readRemoteAware("//wsl$/u/a.ts", async () => text("local"));
    expect(bridge().isRemote("//wsl$/u/a.ts")).toBe(true);
    bridge().registerRemoteFileReader(null);
    expect(bridge().isRemote("//wsl$/u/a.ts")).toBe(false);
  });
});
