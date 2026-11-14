import { beforeEach, expect, it, vi } from "vitest";
import { HandoffTargetSelectionError, resolveHandoffTargetSelection } from "./cost-approval";
import { invoke } from "@/lib/transport";

vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
const selection = { engine: "claude", model: "opus", providerId: "__local_settings_json__", effort: "xhigh" };
beforeEach(() => vi.clearAllMocks());

it("accepts the fixed model resolved from the exact selected alias and channel", async () => {
  vi.mocked(invoke).mockResolvedValue({ ...selection, model: "fixed-opus" });
  expect(await resolveHandoffTargetSelection(selection)).toEqual({ ...selection, model: "fixed-opus" });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("task_resolve_handoff_selection", { selection });
  expect(selection.model).toBe("opus");
});

it.each(["HANDOFF_TARGET_INVALID", "HANDOFF_TARGET_UNAVAILABLE", "HANDOFF_TARGET_RESOLUTION_FAILED", "HANDOFF_TARGET_NOT_ALLOWED", "HANDOFF_TARGET_CHANGED"] as const)("localizes %s without disclosing exception details", async code => {
  vi.mocked(invoke).mockRejectedValue(`${code}: PRIVATE_MODEL_CONTEXT_AND_CREDENTIAL`);
  const error = await resolveHandoffTargetSelection(selection).catch(value => value);
  expect(error).toBeInstanceOf(HandoffTargetSelectionError);
  expect(error.code).toBe(code);
  expect(error.message).not.toContain("PRIVATE_");
});

it("maps arbitrary provider failures to a safe fixed message", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("PRIVATE_PROVIDER_CONFIGURATION"));
  const error = await resolveHandoffTargetSelection(selection).catch(value => value);
  expect(error.code).toBe("HANDOFF_TARGET_RESOLUTION_FAILED");
  expect(error.message).not.toContain("PRIVATE_");
});
