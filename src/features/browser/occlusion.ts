import { useEffect, useId } from "react";
import { create } from "zustand";

/**
 * HTML overlays (modals, menus, lightbox, toasts) always paint *under* the
 * native browser webview: child webviews are native views stacked above the
 * main webview, so no z-index can lift a React dialog over the browser
 * page. The only way to show one is to hide the webview while any overlay
 * is open.
 *
 * This store tracks which overlays are currently open; BrowserPane hides
 * the webview while the set is non-empty and shows it again when the last
 * overlay closes (page state — scroll, login, media — survives, same as a
 * tab switch).
 */
interface OcclusionStore {
  /** Ids of open overlays. A Set so StrictMode double-effects can't
   *  over-count and a stray unregister can never drive a count negative. */
  openIds: ReadonlySet<string>;
  register: (id: string) => void;
  unregister: (id: string) => void;
}

export const useOcclusionStore = create<OcclusionStore>()((set) => ({
  openIds: new Set(),
  register: (id) =>
    set((s) => {
      if (s.openIds.has(id)) return s;
      const next = new Set(s.openIds);
      next.add(id);
      return { openIds: next };
    }),
  unregister: (id) =>
    set((s) => {
      if (!s.openIds.has(id)) return s;
      const next = new Set(s.openIds);
      next.delete(id);
      return { openIds: next };
    }),
}));

/** True while any registered overlay is open. */
export function useBrowserOccluded(): boolean {
  return useOcclusionStore((s) => s.openIds.size > 0);
}

/** Register an overlay while `open` is true. Call in every modal, context
 *  menu, lightbox, or toast that can appear above the browser pane. */
export function useBrowserOcclusion(open: boolean) {
  const id = useId();
  const register = useOcclusionStore((s) => s.register);
  const unregister = useOcclusionStore((s) => s.unregister);
  useEffect(() => {
    if (!open) return;
    register(id);
    return () => unregister(id);
  }, [open, id, register, unregister]);
}
