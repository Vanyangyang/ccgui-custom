import type { OfficialConfigDraft, OfficialConfigFile } from "@/lib/ipc";

export type ContextWindowEditBlock = "disabled" | "override" | "unavailable";

export function claudeContextWindowEditBlock(files: OfficialConfigFile[]): ContextWindowEditBlock | undefined {
  const file = files.find((f) => /(?:^|[/\\])settings\.json$/i.test(f.path));
  if (!file) return "unavailable";
  try {
    const config = JSON.parse(file.exists ? file.content : "{}");
    if (!config || typeof config !== "object" || Array.isArray(config)) return "unavailable";
    if (config.autoCompactEnabled === false || String(config.env?.DISABLE_AUTO_COMPACT ?? "") === "1") return "disabled";
    if (config.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW != null) return "override";
    return undefined;
  } catch {
    return "unavailable";
  }
}

/** Merge into a freshly read file, preserving unrelated configuration. */
export function claudeAutoCompactDraft(files: OfficialConfigFile[], tokens?: number): OfficialConfigDraft {
  if (tokens !== undefined && (!Number.isInteger(tokens) || tokens < 100_000 || tokens > 1_000_000)) {
    throw new Error("invalid context window");
  }
  const block = claudeContextWindowEditBlock(files);
  if (block) throw new Error(`context window ${block}`);
  const file = files.find((f) => /(?:^|[/\\])settings\.json$/i.test(f.path))!;
  const config = JSON.parse(file.exists ? file.content : "{}");
  if (tokens === undefined) delete config.autoCompactWindow;
  else config.autoCompactWindow = tokens;
  return { path: file.path, content: `${JSON.stringify(config, null, 2)}\n` };
}

/** Read the global Claude setting without changing the model's reported capacity. */
export function claudeAutoCompactWindow(files: OfficialConfigFile[]): number | undefined {
  const file = files.find((f) => f.exists && /(?:^|[/\\])settings\.json$/i.test(f.path));
  if (!file) return undefined;
  try {
    const config = JSON.parse(file.content);
    if (!config || typeof config !== "object" || config.autoCompactEnabled === false) return undefined;
    const env = config.env && typeof config.env === "object" ? config.env : {};
    if (String(env.DISABLE_AUTO_COMPACT ?? "") === "1") return undefined;
    // The environment override has precedence over autoCompactWindow in Claude Code.
    const override = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const value = override == null ? config.autoCompactWindow : Number.parseInt(String(override), 10);
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
    return Math.max(100_000, Math.min(1_000_000, Math.trunc(value)));
  } catch {
    return undefined;
  }
}

/** A reported capacity caps the budget; an assumed fallback does not. */
export function contextDisplayMax(modelWindow: number, autoCompactWindow?: number, modelWindowKnown = true): number {
  return autoCompactWindow && Number.isFinite(autoCompactWindow) && autoCompactWindow > 0
    ? (modelWindowKnown ? Math.min(modelWindow, autoCompactWindow) : autoCompactWindow)
    : modelWindow;
}
