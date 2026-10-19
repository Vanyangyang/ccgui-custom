import { describe, expect, it } from "vitest";
import type { OfficialConfigFile } from "@/lib/ipc";
import { claudeAutoCompactWindow, claudeAutoCompactDraft, contextDisplayMax } from "./claude-context-window";
import { usageBreakdown } from "./components/usage-breakdown";
import { resolveContextMaxInfo } from "./context-window-memory";

function settings(config: unknown): OfficialConfigFile[] {
  return [{ path: "C:\\Users\\test\\.claude\\settings.json", content: JSON.stringify(config), format: "json", exists: true }];
}

describe("Claude auto-compact context display", () => {
  it("shows a 750K budget and 8% for a 60K prompt while retaining the 1M model report", () => {
    const usage = { input_tokens: 2, output_tokens: 998, cache_read_input_tokens: 58_000, cache_creation_input_tokens: 1_000, model_context_window: 1_000_000 };
    const max = contextDisplayMax(usage.model_context_window, claudeAutoCompactWindow(settings({ autoCompactWindow: 750_000 })));
    expect(max).toBe(750_000);
    expect(usageBreakdown(usage, max)?.pct).toBe(8);
    expect(usage.model_context_window).toBe(1_000_000);
  });

  it("keeps smaller model windows at their real capacity", () => {
    expect(contextDisplayMax(200_000, 750_000)).toBe(200_000);
  });

  it("uses the configured 750K for a restored session without a reported capacity", () => {
    const usage = { input_tokens: 78_000, output_tokens: 700 };
    const capacity = resolveContextMaxInfo({ usage, engine: "claude", model: "unreported-test-model" });
    expect(capacity).toEqual({ max: 200_000, known: false });
    const max = contextDisplayMax(capacity.max, 750_000, capacity.known);
    expect(max).toBe(750_000);
    expect(usageBreakdown(usage, max)?.pct).toBe(10);
    expect(contextDisplayMax(capacity.max, undefined, capacity.known)).toBe(200_000);
  });

  it("caps the configured budget when a restored session reports a real 200K capacity", () => {
    const capacity = resolveContextMaxInfo({ usage: { input_tokens: 10, model_context_window: 200_000 }, engine: "claude", model: "reported-test-model" });
    expect(capacity).toEqual({ max: 200_000, known: true });
    expect(contextDisplayMax(capacity.max, 750_000, capacity.known)).toBe(200_000);
  });

  it("uses the environment override before the saved window", () => {
    expect(claudeAutoCompactWindow(settings({ autoCompactWindow: 750_000, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" } }))).toBe(500_000);
  });

  it("does not treat a percentage override as a token window", () => {
    expect(claudeAutoCompactWindow(settings({ autoCompactWindow: 750_000, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" } }))).toBe(750_000);
  });

  it.each([{ autoCompactEnabled: false, autoCompactWindow: 750_000 }, { autoCompactWindow: 750_000, env: { DISABLE_AUTO_COMPACT: "1" } }])("falls back to model capacity when auto-compaction is disabled", (config) => {
    expect(claudeAutoCompactWindow(settings(config))).toBeUndefined();
  });

  it("keeps model capacity when the setting is absent or invalid", () => {
    expect(claudeAutoCompactWindow(settings({}))).toBeUndefined();
    expect(claudeAutoCompactWindow(settings({ autoCompactWindow: "750k" }))).toBeUndefined();
    const files = settings({});
    files[0].content = "{broken";
    expect(claudeAutoCompactWindow(files)).toBeUndefined();
    expect(contextDisplayMax(1_000_000, undefined)).toBe(1_000_000);
  });

  it("changes only the window and preserves hooks, permissions and environment", () => {
    const config = { autoCompactWindow: 750_000, hooks: { SessionStart: [] }, permissions: { defaultMode: "auto" }, env: { HTTPS_PROXY: "http://localhost:7897" }, model: "sonnet" };
    const draft = claudeAutoCompactDraft(settings(config), 600_000);
    expect(JSON.parse(draft.content)).toEqual({ ...config, autoCompactWindow: 600_000 });
  });

  it("restores defaults without deleting unrelated settings", () => {
    const draft = claudeAutoCompactDraft(settings({ autoCompactWindow: 750_000, model: "sonnet" }));
    expect(JSON.parse(draft.content)).toEqual({ model: "sonnet" });
  });

  it("creates an absent settings file at its authorized official path", () => {
    const file = settings({})[0];
    file.exists = false;
    file.content = "";
    expect(JSON.parse(claudeAutoCompactDraft([file], 750_000).content)).toEqual({ autoCompactWindow: 750_000 });
  });

  it("refuses invalid or overridden settings rather than overwriting them", () => {
    expect(() => claudeAutoCompactDraft(settings({}), 2_000_000)).toThrow("invalid");
    expect(() => claudeAutoCompactDraft(settings({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" } }), 750_000)).toThrow("override");
    const files = settings({});
    files[0].content = "{broken";
    expect(() => claudeAutoCompactDraft(files, 750_000)).toThrow("unavailable");
  });
});
