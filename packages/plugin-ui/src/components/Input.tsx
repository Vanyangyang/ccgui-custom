import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cx } from "../cx";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 校验失败态：边框与 focus ring 走 error token */
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, spellCheck, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      spellCheck={spellCheck ?? false}
      className={cx("pui-input", invalid && "pui-input-invalid", className)}
      {...rest}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, spellCheck, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      spellCheck={spellCheck ?? false}
      className={cx("pui-textarea", invalid && "pui-input-invalid", className)}
      {...rest}
    />
  );
});
