import { useCallback, useEffect, useState } from "react";
import {
  AGY_REFERENCE_WINDOW_EVENT,
  AGY_REFERENCE_WINDOW_KEY,
  readAgyReferenceWindow,
  writeAgyReferenceWindow,
} from "./agy-context";

export function useAgyContextWindow(engine: string) {
  const [windowValue, setWindowValue] = useState<number | undefined>(() =>
    engine === "agy" ? readAgyReferenceWindow() : undefined,
  );

  const refresh = useCallback(async () => {
    setWindowValue(engine === "agy" ? readAgyReferenceWindow() : undefined);
  }, [engine]);

  const save = useCallback(
    async (tokens?: number) => {
      if (engine !== "agy") throw new Error("context window is only available for AGY");
      writeAgyReferenceWindow(tokens);
      setWindowValue(readAgyReferenceWindow());
    },
    [engine],
  );

  useEffect(() => {
    void refresh();
    if (engine !== "agy") return;
    const onSync = () => {
      setWindowValue(readAgyReferenceWindow());
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === AGY_REFERENCE_WINDOW_KEY) onSync();
    };
    window.addEventListener("focus", onSync);
    window.addEventListener("storage", onStorage);
    window.addEventListener(AGY_REFERENCE_WINDOW_EVENT, onSync);
    return () => {
      window.removeEventListener("focus", onSync);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(AGY_REFERENCE_WINDOW_EVENT, onSync);
    };
  }, [engine, refresh]);

  return {
    window: engine === "agy" ? windowValue : undefined,
    refresh,
    save,
  };
}
