import { describe, expect, it } from "vitest";
import { isDeliveryOutcomeUnknown } from "./delivery-outcome";

describe("isDeliveryOutcomeUnknown", () => {
  it("recognizes native DTOs, IPC JSON strings, and typed WebBridge errors", () => {
    const native = { code: "transport_timeout", message: "response unavailable", outcomeUnknown: true };
    expect(isDeliveryOutcomeUnknown(native)).toBe(true);
    expect(isDeliveryOutcomeUnknown(JSON.stringify(native))).toBe(true);
    expect(isDeliveryOutcomeUnknown(new Error(JSON.stringify(native)))).toBe(true);
    expect(isDeliveryOutcomeUnknown(Object.assign(new Error("connection lost"), { code: "request-uncertain" }))).toBe(true);
  });

  it("does not infer acceptance from prose, ordinary failures, or truthy flags", () => {
    for (const error of [new Error("outcome unknown / unconfirmed / broken pipe"), "request-uncertain", null,
      { code: "transport-disconnected" }, { code: "outcome_unknown", outcomeUnknown: false },
      { outcomeUnknown: "true" }, { cause: { outcomeUnknown: true } }, "{malformed"]) {
      expect(isDeliveryOutcomeUnknown(error)).toBe(false);
    }
  });

  it("bounds serialized error parsing", () => {
    expect(isDeliveryOutcomeUnknown(JSON.stringify({ outcomeUnknown: true, message: "x".repeat(16 * 1024) }))).toBe(false);
  });
});
