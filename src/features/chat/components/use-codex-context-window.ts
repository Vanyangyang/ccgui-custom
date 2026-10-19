import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, type CodexContextWindowSettings } from "@/lib/ipc";
import { listenSettingsChanged } from "@/lib/events";
import { useTauriEvent } from "@/hooks/use-tauri-event";

const EMPTY: CodexContextWindowSettings = { contextWindow: null, autoCompactTokenLimit: null, block: "unavailable" };

export function useCodexContextWindow(engine: string, providerId?: string, workspacePath?: string) {
  const route = JSON.stringify([engine, providerId, workspacePath]);
  const currentRoute = useRef(route);
  currentRoute.current = route;
  const generation = useRef(0);
  const mounted = useRef(false);
  const [state, setState] = useState({ route, settings: EMPTY });
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (engine !== "codex") return;
    const current = () => mounted.current && currentRoute.current === route && request === generation.current;
    try {
      const settings = await ipc.codexContextWindowRead({ providerId, workspacePath });
      if (current()) setState({ route, settings });
    } catch {
      if (current()) setState({ route, settings: EMPTY });
    }
  }, [engine, providerId, workspacePath, route]);
  const save = useCallback(async (contextWindow: number | null, autoCompactTokenLimit: number | null) => {
    if (engine !== "codex" || !mounted.current || currentRoute.current !== route) throw new Error("unavailable");
    ++generation.current;
    await ipc.codexContextWindowWrite({ providerId, workspacePath, contextWindow, autoCompactTokenLimit });
    if (!mounted.current || currentRoute.current !== route) throw new Error("scope_changed");
    await refresh();
  }, [engine, providerId, workspacePath, route, refresh]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useTauriEvent(() => listenSettingsChanged(() => { void refreshRef.current(); }));
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { mounted.current = false; ++generation.current; window.removeEventListener("focus", focus); };
  }, [refresh]);
  return { settings: state.route === route && engine === "codex" ? state.settings : EMPTY, refresh, save };
}
