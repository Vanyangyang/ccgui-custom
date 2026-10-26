// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn(), listen: vi.fn() }));
vi.mock("./api", () => ({ projectsApi: mocks }));
vi.mock("@/lib/transport", () => ({ listen: mocks.listen }));
import { useProjectsStore, useProjectsSubscription } from "./store";
const p = { id: "p", name: "P", defaultPath: "G:/game", members: [] };
beforeEach(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); useProjectsStore.setState({ projects: [p], loaded: true, error: null }); });
describe("project store", () => {
  it("retains prior data on a rejected save and only removes relationships", async () => {
    mocks.save.mockRejectedValue(new Error("disk full"));
    await expect(useProjectsStore.getState().save(p)).rejects.toThrow("disk full");
    expect(useProjectsStore.getState().projects).toEqual([p]);
    mocks.remove.mockResolvedValue(undefined);
    await useProjectsStore.getState().remove("p");
    expect(mocks.remove).toHaveBeenCalledWith("p");
    expect(useProjectsStore.getState().projects).toEqual([]);
  });
  it("ignores a list response older than a successful mutation", async () => {
    let resolve!: (value: typeof p[]) => void;
    mocks.list.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const loading = useProjectsStore.getState().load();
    mocks.remove.mockResolvedValue(undefined);
    await useProjectsStore.getState().remove("p");
    resolve([p]); await loading;
    expect(useProjectsStore.getState().projects).toEqual([]);
  });
  it("unsubscribes listeners that resolve after unmount", async () => {
    const off = vi.fn(); const pending: ((fn: () => void) => void)[] = [];
    mocks.listen.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    mocks.list.mockResolvedValue([p]);
    const root = createRoot(document.createElement("div"));
    function Consumer() { useProjectsSubscription(); return null; }
    await act(async () => root.render(<Consumer />));
    await act(async () => root.unmount());
    await act(async () => pending.forEach((resolve) => resolve(off)));
    expect(off).toHaveBeenCalledTimes(3);
  });
});
