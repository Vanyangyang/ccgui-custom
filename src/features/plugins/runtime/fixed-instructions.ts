import type { HostFixedInstructions } from "@ccgui/plugin-sdk";

export function validateFixedInstructions(value: unknown): asserts value is HostFixedInstructions | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some(key => key !== "version" && key !== "text")) throw new Error("Invalid fixed instructions");
  const profile = value as HostFixedInstructions;
  if (typeof profile.version !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(profile.version) ||
    typeof profile.text !== "string" || !profile.text.trim() || profile.text.length > 16000 || profile.text.includes("\0")) {
    throw new Error("Invalid fixed instructions");
  }
}

export function sameFixedInstructions(a?: HostFixedInstructions, b?: HostFixedInstructions): boolean {
  return a?.version === b?.version && a?.text === b?.text;
}

/** Canonical key order also makes request fingerprints insensitive to object construction order. */
export function fixedInstructionsIdentity(value: HostFixedInstructions): HostFixedInstructions {
  return { version: value.version, text: value.text };
}

export const supportsFixedInstructions = (engine: string) => engine === "claude" || engine === "codex" || engine === "agy";

let nativeSupport: Promise<readonly string[]> | undefined;
/** A new frontend may be hot-loaded over an older binary: never advertise the
 * channel until that binary explicitly confirms it implements the resolver. */
export async function nativeFixedInstructionsSupported(engine?: string): Promise<boolean> {
  const engines = await (nativeSupport ??= import("@/lib/transport").then(async ({ invoke }) => {
    try {
      const value = await invoke<unknown>("plugin_fixed_instructions_engines");
      // A successful but malformed response is not evidence of any capability.
      if (!Array.isArray(value) || value.some(id => typeof id !== "string" || !supportsFixedInstructions(id)) || new Set(value).size !== value.length) return [];
      return value as string[];
    } catch {
      // Old binaries only attest Claude/Codex; never infer AGY from this bool.
      return await invoke<unknown>("plugin_fixed_instructions_supported").catch(() => false) === true ? ["claude", "codex"] : [];
    }
  }).catch(() => []));
  return engine === undefined ? engines.length > 0 : engines.includes(engine);
}
