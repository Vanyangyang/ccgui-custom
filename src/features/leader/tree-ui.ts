import { create } from "zustand";

const STORAGE_KEY = "ccgui.leader.expanded.v1";
function initial(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : []);
  } catch { return new Set(); }
}
function persist(expanded: Set<string>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...expanded])); } catch { /* Persistence is optional. */ }
}
export const useLeaderTreeUI = create<{ expanded: Set<string>; toggle: (id: string) => void; reveal: (id: string) => void }>((set) => ({
  expanded: initial(),
  toggle: (id) => set((s) => {
    const expanded = new Set(s.expanded);
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    persist(expanded);
    return { expanded };
  }),
  reveal: (id) => set((s) => {
    if (s.expanded.has(id)) return s;
    const expanded = new Set(s.expanded).add(id);
    persist(expanded);
    return { expanded };
  }),
}));
