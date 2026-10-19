import { useEffect } from "react";
import { listen } from "@/lib/transport";
import { invalidateSlashCommandCatalog } from "@/components/application/ai-chat/slash-commands";

/** Reconcile visible host data after another client writes or reconnects. */
export function useSkillSync(active: boolean, refresh: () => Promise<void>, onError: (error: string) => void) {
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    for (const event of ["skills://changed", "transport://connected"]) {
      void listen(event, () => {
        if (disposed) return;
        invalidateSlashCommandCatalog();
        void refresh().catch((error) => { if (!disposed) onError(String(error)); });
      })
        .then((off) => { if (disposed) off(); else unlisteners.push(off); })
        .catch((error) => { if (!disposed) onError(String(error)); });
    }
    return () => { disposed = true; unlisteners.forEach((off) => off()); };
  }, [active, refresh, onError]);
}
