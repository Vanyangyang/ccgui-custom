import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CliConfig } from "@/lib/ipc";
import "@/lib/i18n";

const bridge = vi.hoisted(() => ({
  read: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  offs: [] as Array<ReturnType<typeof vi.fn>>,
}));
vi.mock("@/lib/ipc", () => ({ ipc: { getCliConfig: bridge.read, checkCcSwitch: vi.fn(async () => ({ installed: false })) } }));
vi.mock("@/lib/platform", () => ({ pickFile: vi.fn() }));
vi.mock("@/lib/transport", () => ({ listen: vi.fn(async (name: string, cb: (event: { payload: unknown }) => void) => {
  bridge.listeners.set(name, cb);
  const off = vi.fn(() => bridge.listeners.delete(name)); bridge.offs.push(off); return off;
}) }));
import { useCliConfig, type CliConfigState } from "./useCliConfig";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let view: CliConfigState;
function Harness() { view = useCliConfig("claude"); return null; }
function config(current: string) { return { claude: { current, providers: {} } } as unknown as CliConfig; }
beforeEach(() => {
  vi.clearAllMocks(); bridge.listeners.clear(); bridge.offs = [];
  bridge.read.mockResolvedValue(config("initial"));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("refreshes provider state from another surface and reconnect without discarding the editor", async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => view.setDialog({}));
  const editor = view.dialog;
  bridge.read.mockResolvedValue(config("remote-provider"));
  await act(async () => bridge.listeners.get("engine-config://changed")?.({ payload: { engine: "claude" } }));
  expect(view.currentId).toBe("remote-provider");
  expect(view.dialog).toBe(editor);
  bridge.read.mockResolvedValue(config("after-reconnect"));
  await act(async () => bridge.listeners.get("transport://connected")?.({ payload: null }));
  expect(view.currentId).toBe("after-reconnect");
});

it("ignores a late initial provider read after a newer host notification", async () => {
  let resolveOld!: (value: CliConfig) => void;
  bridge.read.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  await act(async () => root.render(<Harness />));
  bridge.read.mockResolvedValue(config("new"));
  await act(async () => bridge.listeners.get("engine-config://changed")?.({ payload: { engine: "claude" } }));
  await act(async () => resolveOld(config("old")));
  expect(view.currentId).toBe("new");
  await act(async () => root.unmount());
  expect(bridge.listeners.size).toBe(0);
  expect(bridge.offs.every((off) => off.mock.calls.length === 1)).toBe(true);
  // afterEach can safely unmount the already-unmounted React root.
});
