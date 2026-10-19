import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { listenSettingsChanged } from "@/lib/events";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { claudeAutoCompactWindow, claudeAutoCompactDraft, claudeContextWindowEditBlock, type ContextWindowEditBlock } from "../claude-context-window";

export function useClaudeContextWindow(engine: string) {
  const [value, setValue] = useState<{ engine: string; window?: number; block?: ContextWindowEditBlock }>({ engine, block: "unavailable" });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (engine !== "claude") {
      setValue({ engine });
      return;
    }
    try {
      const files = await ipc.officialConfigRead("claude");
      if (request === generation.current) setValue({ engine, window: claudeAutoCompactWindow(files), block: claudeContextWindowEditBlock(files) });
    } catch {
      if (request === generation.current) {
        setValue({ engine, block: "unavailable" });
        console.warn("Claude context display: could not read the global auto-compact setting; using model capacity.");
      }
    }
  }, [engine]);
  const save = useCallback(async (tokens?: number) => {
    if (engine !== "claude") throw new Error("context window is only available for Claude");
    // Re-read at save time so settings changed since the popover opened survive.
    const files = await ipc.officialConfigRead("claude");
    await ipc.officialConfigWrite("claude", [claudeAutoCompactDraft(files, tokens)]);
    await refresh();
  }, [engine, refresh]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useTauriEvent(() => listenSettingsChanged(() => { void refreshRef.current(); }));

  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      ++generation.current;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return {
    window: value.engine === engine ? value.window : undefined,
    block: value.engine === engine ? value.block : "unavailable" as const,
    refresh,
    save,
  };
}
