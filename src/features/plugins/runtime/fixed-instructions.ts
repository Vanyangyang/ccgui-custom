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

export const supportsFixedInstructions = (engine: string) => engine === "claude" || engine === "codex";

let nativeSupport: Promise<boolean> | undefined;
/** A new frontend may be hot-loaded over an older binary: never advertise the
 * channel until that binary explicitly confirms it implements the resolver. */
export function nativeFixedInstructionsSupported(): Promise<boolean> {
  return nativeSupport ??= import("@/lib/transport")
    .then(({ invoke }) => invoke<boolean>("plugin_fixed_instructions_supported"))
    .then(value => value === true, () => false);
}
