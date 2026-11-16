import { describe, expect, it } from "vitest";
import { resolveFilePath, toLocalFileUrl } from "./fileLinks";

describe("local file URLs", () => {
  it.each([
    ["file:///C:/music/index.html", "C:/music/index.html"],
    ["FILE:///D:/music/demo.wav", "D:/music/demo.wav"],
    ["file:///tmp/demo.ogg", "/tmp/demo.ogg"],
    ["file://localhost/C:/music/index.html", "C:/music/index.html"],
    ["file://LOCALHOST/tmp/demo.wav", "/tmp/demo.wav"],
    ["file:///C:/%E8%AF%95%E5%90%AC/a%20b.wav", "C:/试听/a b.wav"],
    ["file:///tmp/a%2520b%25.wav", "/tmp/a%20b%.wav"],
    ["file:///tmp/a%23L53", "/tmp/a#L53"],
    ["file:///tmp/a%3Fv%3D1.wav?download=1#preview", "/tmp/a?v=1.wav"],
    ["file:///tmp/main.ts#L53", "/tmp/main.ts"],
    ["file:///tmp/name:12", "/tmp/name:12"],
  ])("resolves %s exactly once", (url, expected) => {
    expect(resolveFilePath(url, "G:/workspace")).toBe(expected);
  });

  it.each([
    "file://server/share/demo.wav", "file:relative.wav", "file:///",
    "file:////server/share/demo.wav", "file:///C:/a%2Fb.wav",
    "file:///C:/a%5Cb.wav", "file:///tmp/a%00.wav", "file:///tmp/a%0A.wav",
    "file:///tmp/bad%ZZ.wav", "file:///tmp/bad%C0%AF.wav",
    "file:///C:\\music\\demo.wav", "file:///tmp/a\nb.wav",
    "file://user:pass@localhost/tmp/a.wav", "file://localhost:80/tmp/a.wav",
  ])("rejects unsupported or malformed URL %s", (url) => {
    expect(resolveFilePath(url, "G:/workspace")).toBeNull();
  });

  it("keeps existing raw path and source-location handling", () => {
    expect(resolveFilePath("./src/main.ts:12:3", "G:/workspace")).toBe("G:/workspace/src/main.ts");
    expect(resolveFilePath("/tmp/a%23L53", "G:/workspace")).toBe("/tmp/a#L53");
    expect(resolveFilePath("../outside.wav", "G:/workspace")).toBeNull();
  });

  it.each([
    ["C:\\试听\\a b%20#L53.wav", "C:/试听/a b%20#L53.wav"],
    ["D:/music/index.html", "D:/music/index.html"],
    ["/tmp/a%20#L53?x=1.wav", "/tmp/a%20#L53?x=1.wav"],
  ])("round-trips a copied filesystem path %s", (path, expected) => {
    const url = toLocalFileUrl(path);
    expect(url).toMatch(/^file:\/\//);
    expect(url).not.toContain("#");
    expect(url).not.toContain("?");
    expect(resolveFilePath(url!, "G:/workspace")).toBe(expected);
  });
});
