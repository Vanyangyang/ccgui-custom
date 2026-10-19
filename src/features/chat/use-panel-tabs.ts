import { useMemo } from "react";
import {
  compareByOrder,
  panelTabRegistry,
  useRegistry,
  type PanelTabDef,
} from "@ccgui/plugin-sdk";

/** Registry entries in display order (compareByOrder: undefined order sorts
 *  last, ties by id). Shared by ChatPanelHeader's pills and ChatSidePanel's
 *  panels so both always agree on tab order. */
export function useSortedPanelTabs(): PanelTabDef[] {
  const tabs = useRegistry(panelTabRegistry);
  return useMemo(() => [...tabs].sort(compareByOrder), [tabs]);
}

/** Read-side fallback for the persisted active tab: a plugin tab can vanish
 *  (plugin unloaded/quarantined) while its id stays in layout state, which
 *  would hide every panel and blank the sidebar. Resolve to the first tab
 *  instead. Deliberately NOT written back — the stale id re-resolves if the
 *  plugin returns. */
export function resolveActivePanelTab(
  tabs: PanelTabDef[],
  activeId: string,
): string | undefined {
  if (tabs.some((tab) => tab.id === activeId)) return activeId;
  return tabs[0]?.id;
}
