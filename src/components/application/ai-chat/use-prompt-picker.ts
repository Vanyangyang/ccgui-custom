import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import { findBangTrigger } from "@/components/application/ai-chat/agent-prompt-triggers";
import { type PromptMenuHandle } from "@/components/application/ai-chat/prompt-menu";
import {
  useTriggerPicker,
  type TriggerState,
} from "@/components/application/ai-chat/use-trigger-picker";
import { usePromptStore } from "@/features/prompts/prompt-store";

/** Active `!query` trigger: start offset, query text, popover x anchor. */
export type PromptTriggerState = TriggerState;

/** Popover width; shared by the caret clamp and the menu surface. */
export const PROMPT_MENU_WIDTH = 420;

/** Prefetch the prompt catalog on workspace switch, so the first `!` is instant. */
const prefetchPrompts = (root: string) =>
  usePromptStore.getState().ensure(root);

/**
 * usePromptPicker — state for the composer's `!` prompt picker: an active
 * trigger is a line-start or post-whitespace `!` + query at the caret
 * (findBangTrigger). The menu consumes arrows/Enter/Tab/Escape through
 * promptMenuRef; `left` anchors the popover to the caret's x position and
 * stays fixed while the query grows. Selecting an entry (DOM mutation)
 * stays in the composer — this hook only tracks the trigger. Thin wrapper
 * over useTriggerPicker.
 */
export function usePromptPicker({
  editableRef,
  wrapperRef,
  workspacePath,
  value,
  lastEmittedRef,
}: {
  editableRef: RefObject<HTMLDivElement | null>;
  wrapperRef: RefObject<HTMLDivElement | null>;
  workspacePath?: string;
  /** Controlled field value: external changes invalidate a live trigger. */
  value?: string;
  /** Last text the composer emitted upward; own echoes skip the reset. */
  lastEmittedRef: MutableRefObject<string>;
}): {
  prompt: PromptTriggerState | null;
  setPrompt: Dispatch<SetStateAction<PromptTriggerState | null>>;
  promptMenuRef: MutableRefObject<PromptMenuHandle | null>;
  /** Re-derive the trigger from the DOM; returns whether one is active so
   *  the composer can prioritize between pickers. */
  updatePromptTrigger: () => boolean;
} {
  const { trigger, setTrigger, menuRef, updateTrigger } =
    useTriggerPicker<PromptMenuHandle>({
      editableRef,
      wrapperRef,
      workspacePath,
      value,
      lastEmittedRef,
      findTrigger: findBangTrigger,
      prefetch: prefetchPrompts,
      menuWidth: PROMPT_MENU_WIDTH,
    });
  return {
    prompt: trigger,
    setPrompt: setTrigger,
    promptMenuRef: menuRef,
    updatePromptTrigger: updateTrigger,
  };
}
