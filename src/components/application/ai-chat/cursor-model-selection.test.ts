import { beforeEach, expect, it, vi } from "vitest";
const { refreshAppSettings, updateCursorModelSelection } = vi.hoisted(() => ({
  refreshAppSettings: vi.fn(), updateCursorModelSelection: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: { refreshAppSettings, updateCursorModelSelection } }));
import { loadCursorModelSelection, saveCursorModelSelection } from "./cursor-model-selection";
import { writeCursorPins } from "./cursor-models";

beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); });

it("serializes changes from multiple menus, including opposite toggles", async () => {
  let allowed: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  updateCursorModelSelection.mockImplementation(async (add: string[], remove: string[]) => {
    if (add.includes("grok-4.7")) await gate;
    allowed = [...new Set([...allowed, ...add])].filter(id => !remove.includes(id));
    return [...allowed];
  });
  const first = saveCursorModelSelection("grok-4.7", true);
  const second = saveCursorModelSelection("sonnet-5.5", true);
  const third = saveCursorModelSelection("grok-4.7", false);
  await Promise.resolve();
  expect(updateCursorModelSelection).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, second, third]);
  expect(allowed).toEqual(["sonnet-5.5"]);
});

it("only consumes the legacy migration after persistence succeeds", async () => {
  writeCursorPins(["grok-4.7"]);
  refreshAppSettings.mockResolvedValue({ leaderAllowedModels: { cursor: [] } });
  updateCursorModelSelection.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(["grok-4.7"]);
  await expect(loadCursorModelSelection([])).rejects.toThrow("offline");
  expect(await loadCursorModelSelection([])).toEqual(["grok-4.7"]);
  expect(updateCursorModelSelection).toHaveBeenCalledTimes(2);
  refreshAppSettings.mockResolvedValue({ leaderAllowedModels: { cursor: [] } });
  expect(await loadCursorModelSelection([])).toEqual([]);
  expect(updateCursorModelSelection).toHaveBeenCalledTimes(2);
});
