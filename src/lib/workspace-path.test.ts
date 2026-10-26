import { describe, expect, it } from "vitest";
import { workspaceCatalogPathKey } from "./workspace-path";

describe("workspace catalog path comparison", () => {
  it.each(["c:\\work\\project\\", "C:/work/project/", "c:/work//project"])("normalizes %s without changing launch paths", (path) => {
    expect(workspaceCatalogPathKey(path)).toBe("C:/work/project");
  });
  it("preserves a drive root and distinct non-drive paths", () => {
    expect(workspaceCatalogPathKey("c:\\")).toBe("C:/");
    for (const path of ["/work/Project/", "/work/project", "\\\\server\\share", "relative/path", "C:relative"]) {
      expect(workspaceCatalogPathKey(path)).toBe(path);
    }
    expect(workspaceCatalogPathKey("C:/Work")).not.toBe(workspaceCatalogPathKey("C:/work"));
  });
});
