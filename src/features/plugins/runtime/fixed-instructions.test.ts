import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/transport", () => ({ invoke }));
beforeEach(() => { vi.resetModules(); invoke.mockReset(); });

it("caches the exact new-host engine list, preserving the no-argument capability", async () => {
  invoke.mockResolvedValue(["claude", "codex", "agy"]);
  const { nativeFixedInstructionsSupported: supports } = await import("./fixed-instructions");
  expect(await Promise.all([supports(), supports("claude"), supports("codex"), supports("agy"), supports("cursor"), supports("")])).toEqual([true, true, true, true, false, false]);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin_fixed_instructions_engines");
});

it.each([true, false, "true"])("old-host bool %s never attests AGY", async legacy => {
  invoke.mockRejectedValueOnce(new Error("unknown command")).mockResolvedValue(legacy);
  const { nativeFixedInstructionsSupported: supports } = await import("./fixed-instructions");
  expect(await supports("agy")).toBe(false);
  expect(await supports("claude")).toBe(legacy === true);
  expect(await supports("codex")).toBe(legacy === true);
  expect(await supports()).toBe(legacy === true);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each([null, true, { engines: ["agy"] }, ["agy", "unknown"], ["agy", "agy"], [1]])("fails closed on malformed response %j", async value => {
  invoke.mockResolvedValue(value);
  const { nativeFixedInstructionsSupported: supports } = await import("./fixed-instructions");
  expect(await supports()).toBe(false);
  expect(await supports("agy")).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("honors a valid partial list and fails closed when both probes fail", async () => {
  invoke.mockResolvedValue(["codex"]);
  let { nativeFixedInstructionsSupported: supports } = await import("./fixed-instructions");
  expect(await supports("codex")).toBe(true);
  expect(await supports("claude")).toBe(false);
  vi.resetModules(); invoke.mockRejectedValue(new Error("offline"));
  ({ nativeFixedInstructionsSupported: supports } = await import("./fixed-instructions"));
  expect(await supports()).toBe(false);
});
