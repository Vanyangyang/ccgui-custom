/** null preserves the CLI's existing configuration; default explicitly opts out. */
export type OmpServiceTier = "default" | "priority" | null;
export function normalizeOmpServiceTier(value: unknown): OmpServiceTier {
  return value === "default" || value === "priority" ? value : null;
}
export function supportsOmpFastMode(model: string): boolean {
  return /^openai-codex\/.+/.test(model);
}
