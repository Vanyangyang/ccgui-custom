"use client";

import type { ReactNode, Ref } from "react";
import {
  Group as AriaGroup,
  TextArea as AriaTextArea,
  type TextAreaProps as AriaTextAreaProps,
} from "react-aria-components";
import { cx } from "@/utils/cx";
import { HintText } from "./hint-text";
import { TextField, type TextFieldProps } from "./input";
import { Label } from "./label";

/**
 * Multiline text field — the TextField/Label/HintText composition of Input,
 * with a <textarea> instead of <input>. Used by the provider dialogs' JSON /
 * TOML config editors (`mono` for code-font rendering).
 */

export interface TextAreaProps
  extends Omit<TextFieldProps, "children" | "spellCheck">,
    Pick<AriaTextAreaProps, "rows" | "placeholder" | "spellCheck"> {
  label?: ReactNode;
  hint?: ReactNode;
  tooltip?: boolean | string;
  /** Monospace text (config/code editors). */
  mono?: boolean;
  /** Class for the field shell. */
  fieldClassName?: string;
  /** Class for the <textarea> element itself. */
  inputClassName?: string;
  ref?: Ref<HTMLTextAreaElement>;
}

export function TextArea({
  label,
  hint,
  tooltip,
  placeholder,
  mono = false,
  fieldClassName,
  inputClassName,
  className,
  ref,
  rows = 6,
  spellCheck,
  ...textFieldProps
}: TextAreaProps) {
  return (
    <TextField
      {...textFieldProps}
      className={className}
      aria-label={
        textFieldProps["aria-label"] ??
        (!label && typeof placeholder === "string" ? placeholder : undefined)
      }
    >
      {({ isRequired, isInvalid }) => (
        <>
          {label && (
            <Label isRequired={isRequired} isInvalid={isInvalid} tooltip={tooltip}>
              {label}
            </Label>
          )}
          <AriaGroup
            className={({ isFocusWithin, isHovered, isDisabled, isInvalid }) =>
              cx(
                "relative flex w-full items-start rounded-2lg p-2",
                "bg-background-tertiary-default text-foreground-icon-tertiary",
                "ring-2 ring-inset ring-transparent",
                "transition-[background-color,box-shadow,color] duration-[var(--input-transition-ms)] ease",
                isHovered && !isFocusWithin && !isDisabled && !isInvalid && "ring-border-button-hover",
                isFocusWithin && !isDisabled && !isInvalid && "ring-border-button-active",
                isDisabled && "bg-input-disabled-background text-input-disabled-foreground",
                isInvalid && "bg-background-tertiary-error",
                fieldClassName,
              )
            }
          >
            <AriaTextArea
              ref={ref}
              rows={rows}
              placeholder={placeholder}
              spellCheck={spellCheck}
              className={cx(
                "min-w-0 flex-1 resize-y bg-transparent border-0 outline-none p-0 m-0 pl-1",
                mono ? "font-mono text-[12px] leading-5" : "font-sans text-body-regular",
                "text-text-primary placeholder:text-text-tertiary",
                "focus:placeholder:text-text-primary",
                "disabled:cursor-not-allowed disabled:text-input-disabled-text disabled:placeholder:text-input-disabled-text",
                inputClassName,
              )}
            />
          </AriaGroup>
          {hint && <HintText isInvalid={isInvalid}>{hint}</HintText>}
        </>
      )}
    </TextField>
  );
}

TextArea.displayName = "TextArea";
