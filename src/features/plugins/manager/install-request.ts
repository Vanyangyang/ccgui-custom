/** Crypto.getRandomValues also works on remote HTTP origins where randomUUID
 *  is unavailable. The id is correlation data, never an authorization token. */
export function createPluginInstallRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
