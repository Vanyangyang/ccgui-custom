import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopTaskMayContinue, localizeRunError } from "../src/features/chat/run-error.ts";

test("only unconfirmed Desktop outcomes keep the external task unresolved", () => {
  for (const code of ["timeout", "stopped", "lost", "unknown", "not_started"]) {
    assert.equal(desktopTaskMayContinue(`[codex-desktop:${code}] Following ended.`), true, code);
  }
  for (const code of ["disabled", "images", "settings", "unavailable", "elsewhere", "workspace", "rejected", "failed", "interrupted"]) {
    assert.equal(desktopTaskMayContinue(`[codex-desktop:${code}] Task failed or message was not delivered.`), false, code);
  }
});

test("unrelated, malformed and unknown errors cannot claim a Desktop follow ended", () => {
  for (const value of [null, undefined, 30, {}, "timeout", "thread t already has an active writer",
    "upstream says [codex-desktop:timeout] ended", "[codex-desktop:new_code] message", "[codex-desktop:timeout]"]) {
    assert.equal(desktopTaskMayContinue(value), false);
  }
});

test("disabled and timeout notices localize without losing Unicode upstream details", () => {
  const texts: Record<string, string> = {
    "chat.codexDesktop.disabled": "线程被其他执行方占用；交接已关闭。",
    "chat.codexDesktop.timeout": "跟进超时，任务完成未确认，原任务可能继续。",
  };
  const t = ((key: string) => texts[key] ?? key) as Parameters<typeof localizeRunError>[1];
  assert.equal(localizeRunError("[codex-desktop:disabled] Another executor holds the thread.", t), texts["chat.codexDesktop.disabled"]);
  assert.equal(localizeRunError("[codex-desktop:timeout] CC GUI stopped following.\n部分回复 🧭", t), `${texts["chat.codexDesktop.timeout"]}\n部分回复 🧭`);
});

test("unknown coded errors retain their full text", () => {
  const t = ((key: string) => key) as Parameters<typeof localizeRunError>[1];
  const unknown = "[codex-desktop:future_code] New notice.\nDetail 🧭";
  assert.equal(localizeRunError(unknown, t), unknown);
  assert.equal(localizeRunError(null, t), null);
});
