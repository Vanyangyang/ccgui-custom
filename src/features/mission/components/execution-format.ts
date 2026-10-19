import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";

/** Display name for a CLI engine id; unknown ids stay as-is. */
export function engineDisplayName(engine: string): string {
  return CLI_DISPLAY_NAMES[engine] ?? engine;
}
