/** A missing/invalid dev scope never silently selects the stable bridge. */
export function relayProfileBase(pathname: string): string {
  if (!pathname.startsWith("/.ccgui-dev/")) return "";
  const match = /^\/\.ccgui-dev\/(dev-[a-f0-9]{64})(?:\/|$)/.exec(pathname);
  if (!match) throw new Error("Invalid development relay profile route");
  return `/.ccgui-dev/${match[1]}`;
}

export function relayProfilePath(path: string): string {
  return `${relayProfileBase(typeof location === "undefined" ? "/" : location.pathname)}${path}`;
}
