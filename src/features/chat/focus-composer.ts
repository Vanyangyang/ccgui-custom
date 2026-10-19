import type { RefObject } from "react";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";

/** 焦点落在任一输入类控件上（我们自己的 composer 或用户点去的别处）。 */
function focusIsInField(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.matches("input, textarea, select")) return true;
  // 读 DOM 属性而非 `isContentEditable`：属性在浏览器与 WebView 里是同一份
  // 事实（contenteditable=false 的 chip 会继续向上找到 composer 本体）。
  return element.closest("[contenteditable='true']") !== null;
}

/**
 * 现在这个焦点算不算「已就位」：是输入类控件，且不在隐藏面里（Surface 用
 * `.invisible` 切换）。隐藏面里的旧焦点（比如刚被盖住的文件编辑器）既不是
 * 我们想要的结果，也不代表用户意图，不能拿来当作「别抢焦点」的理由。
 */
function fieldHasFocus(): boolean {
  const active = document.activeElement;
  if (!focusIsInField(active)) return false;
  return (active as HTMLElement).closest(".invisible") === null;
}

/**
 * 切回聊天中心面后聚焦输入框。
 *
 * 为什么不能直接 `focus()`：中心面用 `invisible`（visibility:hidden）做切换
 * （见 ChatCenterPane 的 Surface），从插件中心/浏览器/文件切回聊天的**这一帧**
 * 输入框还在隐藏面里——浏览器对隐藏元素会静默忽略 focus()，用户表现为
 * 「跳过去了但要自己点一下才有光标」。
 *
 * 所以要等这次 commit 生效（rAF）再聚焦，并在时间窗内重试：新建会话那条路径
 * 上 composer 还要挂载/重新绑定句柄，实测要 ~250ms 才可聚焦（fixture
 * tests/browser/creator-jump.html 记录了逐帧实测）。窗口内每帧一次检查很便宜，
 * 且一旦焦点落在**可见**的输入框上就立刻停手：既不会持续抢焦点，也不会把用户
 * 自己点开的输入框抢回来。
 */
export function focusComposerWhenVisible(
  ref: RefObject<ComposerInputHandle | null>,
  timeoutMs = 400,
): void {
  const deadline = performance.now() + timeoutMs;
  const tryFocus = () => {
    requestAnimationFrame(() => {
      if (!fieldHasFocus()) ref.current?.focus();
      if (fieldHasFocus()) return;
      if (performance.now() < deadline) tryFocus();
    });
  };
  tryFocus();
}
