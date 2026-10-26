import { useCallback, useEffect, useRef, useState } from "react";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { listenSettingsChanged } from "@/lib/events";
import { errorText } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { loadCursorModelSelection, saveCursorModelSelection } from "./cursor-model-selection";
import type { CursorModel } from "./cursor-models";

export function useCursorModelSelection(models: readonly CursorModel[]) {
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const request = useRef(0);
  const catalog = useRef(models);
  catalog.current = models;

  const refresh = useCallback(async () => {
    const token = ++request.current;
    try {
      const result = await loadCursorModelSelection(catalog.current);
      if (mounted.current && token === request.current) { setSelected(result); setError(null); }
    } catch (reason) {
      if (mounted.current && token === request.current) setError(errorText(reason));
    } finally {
      if (mounted.current && token === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { mounted.current = false; ++request.current; window.removeEventListener("focus", refresh); };
  }, [refresh]);
  useTauriEvent(() => listenSettingsChanged(() => { if (!pending.current) void refresh(); }));

  const change = useCallback(async (id: string, enabled: boolean): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true;
    ++request.current;
    setSaving(true);
    setError(null);
    try {
      const result = await saveCursorModelSelection(id, enabled);
      if (mounted.current) setSelected(result);
      return mounted.current;
    } catch (reason) {
      // A native settings write can commit with a warning. Reconcile the
      // visible switches with disk, while keeping the failed action explicit.
      try {
        const actual = await ipc.refreshAppSettings();
        if (mounted.current) setSelected(actual.leaderAllowedModels?.cursor ?? []);
      } catch { /* Keep the last confirmed selection and the actionable error. */ }
      if (mounted.current) setError(errorText(reason));
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }, []);

  return { selected, loading, saving, error, refresh, change };
}
