import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "./en";
import { zh } from "./zh";

// Every literal `t("namespace.key")` in production code must resolve in both
// languages; otherwise the UI shows the raw key (e.g. a sidebar badge reading
// `chat.selfDevWorkspaceBadge`). Dynamic keys are out of scope.
const SOURCE = /\.(ts|tsx)$/;
const TEST = /\.test\.(ts|tsx)$/;
const LITERAL = /\bt\("([a-zA-Z][\w]*\.[\w.]+)"/g;

function literalKeys(): Map<string, string> {
  const found = new Map<string, string>();
  const root = path.resolve("src");
  for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!SOURCE.test(entry) || TEST.test(entry)) continue;
    const text = readFileSync(path.join(root, entry), "utf8");
    for (const match of text.matchAll(LITERAL)) if (!found.has(match[1])) found.set(match[1], entry);
  }
  return found;
}

/** Strings, plural `_other` forms and `returnObjects` arrays all count. */
function resolves(messages: Record<string, unknown>, key: string): boolean {
  if (messages[key] !== undefined) return true; // flat "ns.key" entries
  const parts = key.split(".");
  const leaf = parts.pop()!;
  let node: unknown = messages;
  for (const part of parts) node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  if (!node || typeof node !== "object") return false;
  const values = node as Record<string, unknown>;
  return values[leaf] !== undefined || values[`${leaf}_other`] !== undefined;
}

describe("literal i18n keys", () => {
  it("resolve in zh and en", () => {
    const keys = literalKeys();
    expect(keys.size).toBeGreaterThan(1000);
    const missing = [...keys]
      .filter(([key]) => !resolves(zh, key) || !resolves(en as Record<string, unknown>, key))
      .map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });
});
