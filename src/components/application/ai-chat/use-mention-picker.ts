import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import { findMentionTrigger } from "@/components/application/ai-chat/file-tags";
import { type FileMentionMenuHandle } from "@/components/application/ai-chat/file-mention-menu";
import { useMentionIndexStore } from "@/components/application/ai-chat/mention-files";
import {
  useTriggerPicker,
  type TriggerState,
} from "@/components/application/ai-chat/use-trigger-picker";

/** Active `@query` trigger: start offset, query text, popover x anchor. */
export type MentionTriggerState = TriggerState;

/** Popover width; shared by the caret clamp and the menu surface. */
const MENTION_MENU_WIDTH = 320;

/** Prefetch the file index on workspace switch, so the first `@` is instant. */
const prefetchMentionIndex = (root: string) =>
  useMentionIndexStore.getState().ensure(root);

/**
 * useMentionPicker — state for the composer's `@` file-mention picker: an
 * active trigger is `@` + query at the caret (findMentionTrigger). The menu
 * consumes arrows/Enter/Tab/Escape through mentionMenuRef; `left` anchors
 * the popover to the caret's x position and stays fixed while the query
 * grows. Selecting an entry (DOM mutation) stays in the composer — this hook
 * only tracks the trigger. Thin wrapper over useTriggerPicker.
 */
export function useMentionPicker({
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
  mention: MentionTriggerState | null;
  setMention: Dispatch<SetStateAction<MentionTriggerState | null>>;
  mentionMenuRef: MutableRefObject<FileMentionMenuHandle | null>;
  updateMentionTrigger: () => void;
} {
  const { trigger, setTrigger, menuRef, updateTrigger } =
    useTriggerPicker<FileMentionMenuHandle>({
      editableRef,
      wrapperRef,
      workspacePath,
      value,
      lastEmittedRef,
      findTrigger: findMentionTrigger,
      prefetch: prefetchMentionIndex,
      menuWidth: MENTION_MENU_WIDTH,
    });
  return {
    mention: trigger,
    setMention: setTrigger,
    mentionMenuRef: menuRef,
    updateMentionTrigger: () => {
      updateTrigger();
    },
  };
}
