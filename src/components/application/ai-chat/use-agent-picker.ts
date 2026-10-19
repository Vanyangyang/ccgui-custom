import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import { findHashTrigger } from "@/components/application/ai-chat/agent-prompt-triggers";
import { type AgentMenuHandle } from "@/components/application/ai-chat/agent-menu";
import {
  useTriggerPicker,
  type TriggerState,
} from "@/components/application/ai-chat/use-trigger-picker";
import { useAgentStore } from "@/features/agents/agent-store";

/** Active `#query` trigger: start offset, query text, popover x anchor. */
export type AgentTriggerState = TriggerState;

/** Popover width; shared by the caret clamp and the menu surface. */
export const AGENT_MENU_WIDTH = 420;

/** Prefetch the agent list on workspace switch, so the first `#` is
 *  instant. Agents are app-global (not per-root), so the root is ignored. */
const prefetchAgents = (_root: string) => {
  void useAgentStore.getState().refresh();
};

/**
 * useAgentPicker — state for the composer's `#` agent picker: an active
 * trigger is a line-start `#` + query at the caret (findHashTrigger). The
 * menu consumes arrows/Enter/Tab/Escape through agentMenuRef; `left`
 * anchors the popover to the caret's x position and stays fixed while the
 * query grows. Selecting an entry (DOM mutation) stays in the composer —
 * this hook only tracks the trigger. Thin wrapper over useTriggerPicker.
 */
export function useAgentPicker({
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
  agent: AgentTriggerState | null;
  setAgent: Dispatch<SetStateAction<AgentTriggerState | null>>;
  agentMenuRef: MutableRefObject<AgentMenuHandle | null>;
  /** Re-derive the trigger from the DOM; returns whether one is active so
   *  the composer can prioritize between pickers. */
  updateAgentTrigger: () => boolean;
} {
  const { trigger, setTrigger, menuRef, updateTrigger } =
    useTriggerPicker<AgentMenuHandle>({
      editableRef,
      wrapperRef,
      workspacePath,
      value,
      lastEmittedRef,
      findTrigger: findHashTrigger,
      prefetch: prefetchAgents,
      menuWidth: AGENT_MENU_WIDTH,
    });
  return {
    agent: trigger,
    setAgent: setTrigger,
    agentMenuRef: menuRef,
    updateAgentTrigger: updateTrigger,
  };
}
