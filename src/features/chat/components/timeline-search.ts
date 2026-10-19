import type { TimelineRow } from "./timeline-rows";

/**
 * 对话内搜索（⌘F / Ctrl+F）：数据层负责匹配计数与行定位，DOM 层用 CSS
 * Custom Highlight API 给已挂载的行上底色——不改 Markdown/进程行的渲染
 * 管线，未变行的 memo 与缓存全部不受影响。
 */

/** 一行时间线的可搜索文本：气泡行取消息正文；进程行把折叠的思考/工具
 *  步骤合成一段，命中后由搜索导航展开该行。 */
export function rowSearchText(row: TimelineRow): string {
  if (row.kind === "msg") return row.message.text;
  return row.items.map((item) => item.text).join("\n");
}

export interface TimelineMatch {
  rowIndex: number;
}

/** 大小写不敏感地找出所有命中，按文档顺序每处出现一条（与浏览器查找的
 *  “3/12” 计数一致）。空查询返回空数组。 */
export function findTimelineMatches(
  rows: TimelineRow[],
  query: string,
): TimelineMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: TimelineMatch[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const hay = rowSearchText(rows[rowIndex]).toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at === -1) break;
      matches.push({ rowIndex });
      from = at + needle.length;
    }
  }
  return matches;
}

const HIGHLIGHT_ALL = "ccgui-chat-search";
const HIGHLIGHT_CURRENT = "ccgui-chat-search-current";

/** WKWebView 需 Safari 17.2+；不支持时退化为仅计数+跳转+行圈选。 */
export function searchHighlightSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

export function clearSearchHighlights(): void {
  if (!searchHighlightSupported()) return;
  CSS.highlights.delete(HIGHLIGHT_ALL);
  CSS.highlights.delete(HIGHLIGHT_CURRENT);
}

/** 给滚动容器内已挂载行的文本命中建 Range 并注册高亮。当前命中行内的
 *  Range 进 CURRENT 组（更高优先级，盖过普通底色），其余进 ALL 组。
 *  时间线是虚拟列表，未挂载的行没有 DOM——调用方在虚拟器挂载/流式变更
 *  （MutationObserver）后重绘。 */
export function paintSearchHighlights(
  root: HTMLElement,
  query: string,
  currentRowIndex: number | null,
): void {
  clearSearchHighlights();
  const needle = query.trim().toLowerCase();
  if (!needle || !searchHighlightSupported()) return;
  const all: Range[] = [];
  const current: Range[] = [];
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();
    const rowIndex = Number(
      node.parentElement?.closest("[data-index]")?.getAttribute("data-index"),
    );
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      const range = new Range();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      (rowIndex === currentRowIndex ? current : all).push(range);
      from = at + needle.length;
    }
    node = walker.nextNode();
  }
  if (all.length > 0) CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...all));
  if (current.length > 0) {
    const highlight = new Highlight(...current);
    // 同一段文本同时命中两组时，当前组必须画在上层。
    highlight.priority = 1;
    CSS.highlights.set(HIGHLIGHT_CURRENT, highlight);
  }
}
