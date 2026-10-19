/** Actual center-surface visibility, independent of keep-alive mounts. */
const panes = new Map<symbol, boolean>();
const listeners = new Set<() => void>();
export const chatHostVisible = () => [...panes.values()].some(Boolean);
export function publishChatHostPresence(visible: boolean): () => void {
  const owner = Symbol();
  panes.set(owner, visible);
  listeners.forEach(fn => fn());
  return () => { panes.delete(owner); listeners.forEach(fn => fn()); };
}
export function subscribeChatHostPresence(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
