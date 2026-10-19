import { describe, expect, it } from "vitest";
import { familyAliasOfEnvKey, providerFamilyModels } from "./providers";

describe("familyAliasOfEnvKey", () => {
  it("derives the alias id from the CLI's family env key shape", () => {
    expect(familyAliasOfEnvKey("ANTHROPIC_DEFAULT_OPUS_MODEL")).toBe("opus");
    expect(familyAliasOfEnvKey("ANTHROPIC_DEFAULT_FABLE_MODEL")).toBe("fable");
  });

  it("rejects non-family Anthropic keys", () => {
    // SMALL_FAST is a routing key, not a family remap; ANTHROPIC_MODEL is the
    // flat default. Neither names an alias row in the picker.
    expect(familyAliasOfEnvKey("ANTHROPIC_SMALL_FAST_MODEL")).toBeNull();
    expect(familyAliasOfEnvKey("ANTHROPIC_MODEL")).toBeNull();
    expect(familyAliasOfEnvKey("ANTHROPIC_DEFAULT_")).toBeNull();
  });
});

describe("providerFamilyModels", () => {
  const channel = (env: Record<string, string>) => ({
    name: "relay",
    settingsConfig: { env },
  });

  it("picks up a family the frontend never heard of", () => {
    // The mapping is derived from the key pattern, not a mirrored table: a
    // new ANTHROPIC_DEFAULT_<FAMILY>_MODEL ships with the CLI/backend and
    // works here without an edit.
    expect(
      providerFamilyModels("claude", channel({ ANTHROPIC_DEFAULT_NINE_MODEL: "m-9" })),
    ).toEqual({ nine: "m-9" });
  });

  it("reads both the flat env and settingsConfig.env, nested winning", () => {
    expect(
      providerFamilyModels("claude", {
        name: "relay",
        env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "flat-opus" },
        settingsConfig: { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "nested-opus" } },
      }),
    ).toEqual({ opus: "nested-opus" });
  });

  it("ignores blank values and non-claude engines", () => {
    expect(
      providerFamilyModels("claude", channel({ ANTHROPIC_DEFAULT_OPUS_MODEL: "  " })),
    ).toEqual({});
    expect(
      providerFamilyModels("codex", channel({ ANTHROPIC_DEFAULT_OPUS_MODEL: "x" })),
    ).toEqual({});
  });
});
