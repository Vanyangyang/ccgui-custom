import type { Message, SessionMeta } from "@/lib/ipc";
import { workspaceCatalogPathKey } from "@/lib/workspace-path";

export type InternalMessageSource = NonNullable<Message["internalSource"]>;

/** Display-only recognition of the existing host wrapper, including saved
 * history. This is never proof of authorization or a reason to filter rows. */
export function parseInternalMessage(text: string): { source: InternalMessageSource; text: string } | null {
  const header = /^\[Message from CC GUI (\{[^\r\n]{1,4096}\})\]\r?\n\r?\n/.exec(text);
  if (!header) return null;
  try {
    const value: unknown = JSON.parse(header[1]);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { engine, session_id: sessionId } = value as Record<string, unknown>;
    if (typeof engine !== "string" || !engine || typeof sessionId !== "string" || !sessionId ||
      /[\s\u0000-\u001f]/.test(engine + sessionId)) return null;
    return { source: { engine, sessionId }, text: text.slice(header[0].length) };
  } catch {
    return null;
  }
}

export function internalMessageTitle(source: InternalMessageSource, sessions: readonly SessionMeta[]): string {
  // Old wrappers contain no workspace identity. A duplicate native id must
  // not pick an arbitrary workspace's title.
  const matches = sessions.filter(session => session.engine === source.engine && session.sessionId === source.sessionId &&
    (!source.workspacePath || workspaceCatalogPathKey(session.workspacePath) === workspaceCatalogPathKey(source.workspacePath)));
  const session = matches.length === 1 ? matches[0] : undefined;
  return session?.customTitle?.trim() || session?.title?.trim() || `${source.engine} · ${source.sessionId.slice(0, 8)}`;
}
