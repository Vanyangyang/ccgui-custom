import { createContext, useContext, type ReactNode } from "react";
import { useChatStore } from "../store";
import { sessionKey, type ActiveSession } from "../store/persistence";

/**
 * 一栏对话的会话作用域（分屏后每个格子一栏）。
 *
 * 时间线里的卡片（授权、问答、计划审批）与输入框下方的浮层原先都从全局
 * `active` 推自己的 sessionKey——分屏后那样会串台：非聚焦格子里的问答卡会把
 * 答案提交到聚焦格子的会话上。它们改为读这里的作用域会话，没有 provider 时
 * 回退到全局 active，单栏行为不变。
 *
 * `undefined` = 没有 provider（回退全局 active），`null` = 这一栏确实没有会话。
 */
const SessionScopeContext = createContext<ActiveSession | null | undefined>(undefined);

export function SessionScope({
  session,
  children,
}: {
  session: ActiveSession | null;
  children: ReactNode;
}) {
  return <SessionScopeContext.Provider value={session}>{children}</SessionScopeContext.Provider>;
}

/** 当前栏位的会话；不在任何作用域内时按全局激活会话解析。 */
export function useScopedSession(): ActiveSession | null {
  const scoped = useContext(SessionScopeContext);
  const active = useChatStore((s) => s.active);
  return scoped === undefined ? active : scoped;
}

/** 当前栏位的会话 key；没有会话时为空串。 */
export function useScopedSessionKey(): string {
  const session = useScopedSession();
  return session ? sessionKey(session.engine, session.sessionId, session.workspacePath) : "";
}
