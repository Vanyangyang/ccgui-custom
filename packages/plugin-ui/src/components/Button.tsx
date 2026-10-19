import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cx } from "../cx";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = 宿主 CTA 渐变；secondary = 描边浅填充（工具栏默认）；ghost = 无边框 */
  variant?: "primary" | "secondary" | "ghost";
  size?: "md" | "sm";
}

/** 原生 button，样式全部吃宿主语义 token（见 ../tokens.ts 契约）。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      // 插件容器外可能处在表单上下文，默认 button 防误提交
      type={type ?? "button"}
      className={cx("pui-btn", `pui-btn-${variant}`, size === "sm" && "pui-btn-sm", className)}
      {...rest}
    />
  );
});
