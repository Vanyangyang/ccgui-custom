import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  caretLeftPx,
  extractText,
  getCaretOffset,
} from "@/components/application/ai-chat/file-tags";

/** Active trigger (`@query` / `/query`): start offset, query text, popover x anchor. */
export interface TriggerState {
  start: number;
  query: string;
  left: number;
}

/**
 * useTriggerPicker — shared state machine for the composer's trigger pickers
 * (`@` file mentions, `/` commands): an active trigger is whatever
 * `findTrigger` matches at the caret. The menu consumes
 * arrows/Enter/Tab/Escape through menuRef; `left` anchors the popover to the
 * caret's x position and stays fixed while the query grows. Selecting an
 * entry (DOM mutation) stays in the composer — this hook only tracks the
 * trigger.
 */
export function useTriggerPicker<H>({
  editableRef,
  wrapperRef,
  workspacePath,
  value,
  lastEmittedRef,
  findTrigger,
  prefetch,
  menuWidth,
}: {
  editableRef: RefObject<HTMLDivElement | null>;
  wrapperRef: RefObject<HTMLDivElement | null>;
  workspacePath?: string;
  /** Controlled field value: external changes invalidate a live trigger. */
  value?: string;
  /** Last text the composer emitted upward; own echoes skip the reset. */
  lastEmittedRef: MutableRefObject<string>;
  /** Detect a trigger spanning the caret in the editable's text. */
  findTrigger: (text: string, caret: number) => { start: number; query: string } | null;
  /** Warm the picker's per-root cache, so the first trigger is instant. */
  prefetch: (root: string) => void;
  /** Popover width; shared by the caret clamp and the menu surface. */
  menuWidth: number;
}): {
  trigger: TriggerState | null;
  setTrigger: Dispatch<SetStateAction<TriggerState | null>>;
  menuRef: MutableRefObject<H | null>;
  /** Re-derive the trigger from the DOM (called on real input only, never
   *  during IME composition); returns whether one is active so the composer
   *  can prioritize between pickers. */
  updateTrigger: () => boolean;
} {
  const menuRef = useRef<H | null>(null);
  const [trigger, setTrigger] = useState<TriggerState | null>(null);

  // Workspace switch closes the picker: render-time adjustment via prev-prop
  // comparison instead of a cascading effect setState.
  const [prevWorkspacePath, setPrevWorkspacePath] = useState(workspacePath);
  if (prevWorkspacePath !== workspacePath) {
    setPrevWorkspacePath(workspacePath);
    setTrigger(null);
  }

  // Prefetch the picker's catalog on workspace switch, so the first trigger
  // is instant.
  useEffect(() => {
    if (workspacePath) prefetch(workspacePath);
  }, [workspacePath, prefetch]);

  // External value changes (draft restore on tab switch, clear on submit)
  // rebuild the editable DOM from text, which invalidates any live trigger
  // range — reset the picker via prev-prop comparison (render-time
  // adjustment, no cascading effect setState). Own emissions are already in
  // the DOM and skip this path through lastEmittedRef.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    if ((value ?? "") !== lastEmittedRef.current) setTrigger(null);
  }

  /** Caret x relative to the composer wrapper, clamped to the menu width. */
  const caretLeft = useCallback(
    () => caretLeftPx(wrapperRef.current, menuWidth),
    [wrapperRef, menuWidth],
  );

  const updateTrigger = useCallback((): boolean => {
    const el = editableRef.current;
    if (!el || !workspacePath) return false;
    const caret = getCaretOffset(el);
    const found = caret >= 0 ? findTrigger(extractText(el), caret) : null;
    setTrigger((prev) => {
      if (!found) return null;
      if (prev && prev.start === found.start) return { ...prev, query: found.query };
      return { ...found, left: caretLeft() };
    });
    return found != null;
  }, [editableRef, workspacePath, findTrigger, caretLeft]);

  // Close the picker when the caret leaves the trigger (mouse click, arrow
  // keys). Typing keeps the same trigger start, so input stays open.
  useEffect(() => {
    if (!trigger) return;
    const closeIfCaretLeft = () => {
      const el = editableRef.current;
      if (!el) return;
      const caret = getCaretOffset(el);
      const found = caret >= 0 ? findTrigger(extractText(el), caret) : null;
      if (!found || found.start !== trigger.start) setTrigger(null);
    };
    document.addEventListener("selectionchange", closeIfCaretLeft);
    return () => document.removeEventListener("selectionchange", closeIfCaretLeft);
  }, [editableRef, trigger, findTrigger]);

  return { trigger, setTrigger, menuRef, updateTrigger };
}
