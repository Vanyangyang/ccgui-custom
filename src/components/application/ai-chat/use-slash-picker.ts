import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  findSlashTrigger,
  useSlashCommandStore,
} from "@/components/application/ai-chat/slash-commands";
import { type SlashCommandMenuHandle } from "@/components/application/ai-chat/slash-command-menu";
import {
  useTriggerPicker,
  type TriggerState,
} from "@/components/application/ai-chat/use-trigger-picker";

/** Active `/query` trigger: start offset, query text, popover x anchor. */
export type SlashTriggerState = TriggerState;

/** Popover width; shared by the caret clamp and the menu surface. */
export const SLASH_MENU_WIDTH = 420;

/** Prefetch the command catalog on workspace switch, so the first `/` is instant. */
const prefetchSlashCommands = (root: string) =>
  useSlashCommandStore.getState().ensure(root);

/**
 * useSlashPicker — state for the composer's `/` command picker: an active
 * trigger is a line-start `/` + query at the caret (findSlashTrigger). The
 * menu consumes arrows/Enter/Tab/Escape through slashMenuRef; `left` anchors
 * the popover to the caret's x position and stays fixed while the query
 * grows. Selecting an entry (DOM mutation) stays in the composer — this hook
 * only tracks the trigger. Thin wrapper over useTriggerPicker.
 */
export function useSlashPicker({
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
  slash: SlashTriggerState | null;
  setSlash: Dispatch<SetStateAction<SlashTriggerState | null>>;
  slashMenuRef: MutableRefObject<SlashCommandMenuHandle | null>;
  /** Re-derive the trigger from the DOM; returns whether one is active so
   *  the composer can give `/` priority over the `@` mention picker. */
  updateSlashTrigger: () => boolean;
} {
  const { trigger, setTrigger, menuRef, updateTrigger } =
    useTriggerPicker<SlashCommandMenuHandle>({
      editableRef,
      wrapperRef,
      workspacePath,
      value,
      lastEmittedRef,
      findTrigger: findSlashTrigger,
      prefetch: prefetchSlashCommands,
      menuWidth: SLASH_MENU_WIDTH,
    });
  return {
    slash: trigger,
    setSlash: setTrigger,
    slashMenuRef: menuRef,
    updateSlashTrigger: updateTrigger,
  };
}
