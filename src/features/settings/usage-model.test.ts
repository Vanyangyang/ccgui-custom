import { describe, expect, it } from "vitest";
import { modelDisplayName } from "./usage-model";

describe("modelDisplayName", () => {
  it("drops a relay provider prefix so one model is one name", () => {
    // The ledger keeps whatever the session ran; the page must not list
    // "agentrouter qunyou/deepseek-v4-flash" next to "deepseek-v4-flash".
    expect(modelDisplayName("agentrouter qunyou/deepseek-v4-flash")).toBe(
      "deepseek-v4-flash",
    );
    expect(modelDisplayName("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(modelDisplayName("")).toBe("");
    expect(
      modelDisplayName(
        "plugin_model-switcher_custom_1789978640996/gemini-3.8-flash",
      ),
    ).toBe("gemini-3.8-flash");
  });
});
