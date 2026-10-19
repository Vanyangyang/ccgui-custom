import { beforeEach, describe, expect, it } from "vitest";
import { BROWSER_TABS_KEY, resetBrowserStoreForTests, useBrowserStore } from "./store";

function openTabs(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(useBrowserStore.getState().openTab(`https://example${i}.com/`));
  return ids;
}

beforeEach(() => {
  localStorage.clear();
  resetBrowserStoreForTests();
});

describe("browser tab store", () => {
  it("openTab appends and activates the new tab", () => {
    const [a, b] = openTabs(2);
    const s = useBrowserStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual([a, b]);
    expect(s.activeId).toBe(b);
  });

  it("activate only accepts known ids and persists", () => {
    const [a, b] = openTabs(2);
    useBrowserStore.getState().activate("nope");
    expect(useBrowserStore.getState().activeId).toBe(b);
    useBrowserStore.getState().activate(a);
    expect(useBrowserStore.getState().activeId).toBe(a);
    const persisted = JSON.parse(localStorage.getItem(BROWSER_TABS_KEY)!);
    expect(persisted.activeId).toBe(a);
    expect(persisted.tabs).toHaveLength(2);
  });

  it("closing the active tab falls back to the neighbor at the same slot", () => {
    const [a, b, c] = openTabs(3);
    useBrowserStore.getState().activate(b);
    useBrowserStore.getState().closeTab(b);
    let s = useBrowserStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual([a, c]);
    expect(s.activeId).toBe(c);
    // Closing the last tab clears the active id.
    useBrowserStore.getState().closeTab(c);
    useBrowserStore.getState().closeTab(a);
    s = useBrowserStore.getState();
    expect(s.tabs).toEqual([]);
    expect(s.activeId).toBeNull();
  });

  it("closing an inactive tab keeps the active id", () => {
    const [a, b] = openTabs(2);
    useBrowserStore.getState().activate(b);
    useBrowserStore.getState().closeTab(a);
    expect(useBrowserStore.getState().activeId).toBe(b);
  });

  it("moveTab reorders and clamps the target index", () => {
    const [a, b, c] = openTabs(3);
    useBrowserStore.getState().moveTab(c, 0);
    expect(useBrowserStore.getState().tabs.map((t) => t.id)).toEqual([c, a, b]);
    useBrowserStore.getState().moveTab(c, 99);
    expect(useBrowserStore.getState().tabs.map((t) => t.id)).toEqual([a, b, c]);
  });

  it("deactivate clears only the active id", () => {
    openTabs(1);
    useBrowserStore.getState().deactivate();
    const s = useBrowserStore.getState();
    expect(s.activeId).toBeNull();
    expect(s.tabs).toHaveLength(1);
  });

  it("setUrl and setTitle update the tab and persist", () => {
    const [a] = openTabs(1);
    useBrowserStore.getState().setUrl(a, "https://example.org/page");
    useBrowserStore.getState().setTitle(a, "Example");
    expect(useBrowserStore.getState().tabs[0]).toMatchObject({
      url: "https://example.org/page",
      title: "Example",
    });
    const persisted = JSON.parse(localStorage.getItem(BROWSER_TABS_KEY)!);
    expect(persisted.tabs[0]).toMatchObject({ url: "https://example.org/page", title: "Example" });
  });
});
