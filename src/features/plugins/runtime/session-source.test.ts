import { describe, expect, it } from "vitest";
import { listExternalSessionMetas, registerSessionSource, type ExternalSessionRow } from "./session-source";

const row = (sessionId: string, workspacePath = "~/cxn", engine = "codex") => ({
  engine,
  sessionId,
  workspacePath,
  title: `t-${sessionId}`,
  updatedAt: 1000,
});

describe("session source registry", () => {
  it("merges rows from registered sources and fills SessionMeta defaults", async () => {
    const dispose = registerSessionSource("wsl", "main", async () => [row("s-1")]);
    const metas = await listExternalSessionMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      engine: "codex",
      sessionId: "s-1",
      workspacePath: "~/cxn",
      title: "t-s-1",
      pinned: false,
      customTitle: null,
      updatedAt: 1000,
    });
    dispose();
    expect(await listExternalSessionMetas()).toHaveLength(0);
  });

  it("re-registering the same source id replaces it (hot reload)", async () => {
    const d1 = registerSessionSource("wsl", "main", async () => [row("s-1")]);
    const d2 = registerSessionSource("wsl", "main", async () => [row("s-2")]);
    d1();
    const metas = await listExternalSessionMetas();
    expect(metas.map((m) => m.sessionId)).toEqual(["s-2"]);
    d2();
  });

  it("a throwing source is isolated, rows without workspacePath are dropped", async () => {
    const d1 = registerSessionSource("bad", "src", async () => {
      throw new Error("ssh down");
    });
    const d2 = registerSessionSource("wsl", "src", async () => [
      row("s-1"),
      // 缺 workspacePath 的行(类型违规输入,运行时须被丢弃)。
      { engine: "omp", sessionId: "x" } as unknown as ExternalSessionRow,
    ]);
    const metas = await listExternalSessionMetas();
    expect(metas.map((m) => m.sessionId)).toEqual(["s-1"]);
    d1();
    d2();
  });
  it("a synchronously throwing source is isolated (not just rejected promises)", async () => {
    // 非 async 的 list 同步抛错不得连累其他源或让整轮刷新失败。
    const d1 = registerSessionSource("bad", "sync", () => {
      throw new Error("not even a promise");
    });
    const d2 = registerSessionSource("wsl", "ok", async () => [row("s-1")]);
    const metas = await listExternalSessionMetas();
    expect(metas.map((m) => m.sessionId)).toEqual(["s-1"]);
    d1();
    d2();
  });

  it("coerces malformed field types instead of passing them through", async () => {
    const d = registerSessionSource("wsl", "bad-types", async () => [
      {
        engine: "codex",
        sessionId: "s-9",
        workspacePath: "~/cxn",
        title: { not: "a string" },
        updatedAt: "yesterday",
        remotePath: 42,
      } as unknown as ExternalSessionRow,
    ]);
    const metas = await listExternalSessionMetas();
    expect(metas[0]).toMatchObject({
      sessionId: "s-9",
      title: "s-9", // sessionId.slice(0, 8) 回落
      updatedAt: null,
      fileMtimeMs: 0,
      remotePath: undefined,
    });
    d();
  });
});
