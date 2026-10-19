import { forwardRef, type SelectHTMLAttributes } from "react";
import { cx } from "../cx";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/**
 * 原生 select：去默认箭头，wrapper 挂 chevron。保持原生弹出层——插件环境
 * 里自绘下拉要处理定位/焦点逃逸，原生行为零成本且不出错。
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <span className={cx("pui-select-wrap", className)}>
      <select ref={ref} className="pui-select" {...rest}>
        {children}
      </select>
      <svg
        className="pui-select-chevron"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
});
