import { describe, expect, it } from "vitest";
import { Registry } from "@ccgui/plugin-sdk";

interface Entry {
  id: string;
  value: number;
}

describe("Registry", () => {
  it("returns registered entries in insertion order", () => {
    const r = new Registry<Entry>();
    r.register({ id: "a", value: 1 });
    r.register({ id: "b", value: 2 });
    expect(r.getSnapshot().map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("disposer removes its entry and notifies subscribers", () => {
    const r = new Registry<Entry>();
    let notified = 0;
    r.subscribe(() => notified++);
    const dispose = r.register({ id: "a", value: 1 });
    expect(notified).toBe(1);
    dispose();
    expect(r.getSnapshot()).toEqual([]);
    expect(notified).toBe(2);
  });

  it("a stale disposer cannot evict a newer registration under the same id (upsert semantics)", () => {
    const r = new Registry<Entry>();
    const disposeOld = r.register({ id: "a", value: 1 });
    r.register({ id: "a", value: 2 }); // reload / HMR re-registration
    disposeOld();
    expect(r.get("a")?.value).toBe(2);
  });

  it("disposers are idempotent", () => {
    const r = new Registry<Entry>();
    const dispose = r.register({ id: "a", value: 1 });
    dispose();
    dispose();
    expect(r.getSnapshot()).toEqual([]);
  });

  it("getSnapshot is referentially stable between emits (useSyncExternalStore-safe)", () => {
    const r = new Registry<Entry>();
    r.register({ id: "a", value: 1 });
    expect(r.getSnapshot()).toBe(r.getSnapshot());
  });
});
