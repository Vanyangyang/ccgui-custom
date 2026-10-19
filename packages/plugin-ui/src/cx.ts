/**
 * 轻量 className 合并：拼接真值片段。插件没有 Tailwind，不需要
 * tailwind-merge 的冲突消解——pui-* 类名互不冲突，插件自定义类后写即赢。
 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
