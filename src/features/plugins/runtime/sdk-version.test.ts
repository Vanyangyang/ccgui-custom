import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SDK_VERSION, compareVersions, satisfiesSdkRange } from "@ccgui/plugin-sdk";

describe("satisfiesSdkRange", () => {
  it("absent or * accepts anything", () => {
    expect(satisfiesSdkRange(undefined, "0.2.0")).toBe(true);
    expect(satisfiesSdkRange("*", "9.9.9")).toBe(true);
  });

  it("exact match", () => {
    expect(satisfiesSdkRange("0.2.0", "0.2.0")).toBe(true);
    expect(satisfiesSdkRange("0.2.0", "0.2.1")).toBe(false);
  });

  it("caret on 0.x left-anchors the minor (semver rule)", () => {
    expect(satisfiesSdkRange("^0.2", "0.2.0")).toBe(true);
    expect(satisfiesSdkRange("^0.2.1", "0.2.5")).toBe(true);
    expect(satisfiesSdkRange("^0.2.1", "0.2.0")).toBe(false);
    expect(satisfiesSdkRange("^0.2.0", "0.3.0")).toBe(false);
    expect(satisfiesSdkRange("^0.2.0", "1.0.0")).toBe(false);
  });

  it("caret on 0.0: omitted patch means any 0.0.x (mirrors ^0.2)", () => {
    expect(satisfiesSdkRange("^0.0", "0.0.0")).toBe(true);
    expect(satisfiesSdkRange("^0.0", "0.0.7")).toBe(true);
    expect(satisfiesSdkRange("^0.0", "0.1.0")).toBe(false);
    expect(satisfiesSdkRange("^0.0", "1.0.0")).toBe(false);
    // 带 patch 时精确锚定该 patch（0.0.x 里 patch 即破坏性位）
    expect(satisfiesSdkRange("^0.0.3", "0.0.3")).toBe(true);
    expect(satisfiesSdkRange("^0.0.3", "0.0.4")).toBe(false);
  });

  it("caret on ≥1 anchors the major", () => {
    expect(satisfiesSdkRange("^1.2.0", "1.9.3")).toBe(true);
    expect(satisfiesSdkRange("^1.2.0", "2.0.0")).toBe(false);
  });

  it("tilde anchors major+minor", () => {
    expect(satisfiesSdkRange("~1.2.3", "1.2.9")).toBe(true);
    expect(satisfiesSdkRange("~1.2.3", "1.3.0")).toBe(false);
  });

  it(">= floor", () => {
    expect(satisfiesSdkRange(">=0.2.0", "1.0.0")).toBe(true);
    expect(satisfiesSdkRange(">=0.2.0", "0.1.9")).toBe(false);
  });

  it("garbage ranges reject rather than silently pass", () => {
    expect(satisfiesSdkRange("latest", "0.2.0")).toBe(false);
    expect(satisfiesSdkRange("0.2", "0.2.0")).toBe(false);
  });

  it("the shipped SDK_VERSION satisfies the template's declared range", () => {
    expect(satisfiesSdkRange("^0.3", SDK_VERSION)).toBe(true);
  });

  it("plugin.d.ts header version stamp matches SDK_VERSION", () => {
    // jsdom 的全局 URL 会忽略 base 转而相对 document 解析，故走字符串路径。
    const dts = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/plugin-sdk/plugin.d.ts"),
      "utf8",
    );
    expect(dts.slice(0, 400)).toContain(`@ccgui/plugin-sdk v${SDK_VERSION}`);
  });
});

describe("compareVersions", () => {
  it("compares dotted versions; missing segments count as 0", () => {
    expect(compareVersions("0.3.1", "0.3.0")).toBeGreaterThan(0);
    expect(compareVersions("0.3", "0.3.0")).toBe(0);
    expect(compareVersions("0.2.9", "0.10.0")).toBeLessThan(0);
  });

  it("ignores semver build metadata such as custom-build app versions", () => {
    expect(compareVersions("1.1.1", "1.1.1+protected.3")).toBe(0);
    expect(compareVersions("1.1.2", "1.1.1+protected.3")).toBeGreaterThan(0);
    expect(compareVersions("1.1.0+a.b", "1.1.1")).toBeLessThan(0);
  });

  it("throws a clear Error on non-numeric segments instead of returning NaN", () => {
    expect(() => compareVersions("0.a.1", "0.1.0")).toThrow(/non-numeric segment/);
    expect(() => compareVersions("0.1.0", "latest")).toThrow(/non-numeric segment/);
    expect(() => compareVersions("0..1", "0.1.0")).toThrow(/non-numeric segment/);
    expect(() => compareVersions("-1.0.0", "0.1.0")).toThrow(/non-numeric segment/);
  });
});
