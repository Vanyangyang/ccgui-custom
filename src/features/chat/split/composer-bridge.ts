import type { RefObject } from "react";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import { useSplitStore } from "./store";
import { SOLO_PANE_ID } from "./tree";

/**
 * 每栏 composer 句柄的登记表。
 *
 * 分屏后同时挂着多个输入框：侧栏「切会话后聚焦输入框」、文件树「+」插入
 * @path 这些入口必须落到**当前聚焦那一栏**，而不是笼统的「active 会话」
 * （聚焦格可以是空格子，此时没有输入框，什么都不做才对）。
 */

const refs = new Map<string, RefObject<ComposerInputHandle | null>>();

export function registerPaneComposerRef(
  paneId: string,
  ref: RefObject<ComposerInputHandle | null>,
): () => void {
  refs.set(paneId, ref);
  return () => {
    if (refs.get(paneId) === ref) refs.delete(paneId);
  };
}

export function paneComposerHandle(paneId: string | null | undefined): ComposerInputHandle | null {
  if (!paneId) return null;
  return refs.get(paneId)?.current ?? null;
}

/** 当前聚焦栏的输入框句柄（单栏模式即那一栏；空格子为 null）。 */
export function focusedComposerHandle(): ComposerInputHandle | null {
  const { root, focusedPaneId } = useSplitStore.getState();
  if (!root) return paneComposerHandle(SOLO_PANE_ID);
  return paneComposerHandle(focusedPaneId ?? SOLO_PANE_ID);
}

/**
 * 全局 composer ref 的桥：调用方照旧持有「一个 ref」，读时解析到当前聚焦栏，
 * 写入不走这里（每栏自己持有 ref）。
 */
export const composerBridgeRef: RefObject<ComposerInputHandle | null> = {
  get current(): ComposerInputHandle | null {
    return focusedComposerHandle();
  },
};

export function useComposerBridge(): RefObject<ComposerInputHandle | null> {
  return composerBridgeRef;
}
