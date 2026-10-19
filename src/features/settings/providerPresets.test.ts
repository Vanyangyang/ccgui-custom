import { describe, expect, it } from "vitest";
import { buildDefaultClaudeSettings, claudeTemplateJson } from "./providerPresets";

describe("Claude channel defaults", () => {
  it("starts new channels with Sonnet and xhigh", () => {
    const settings = buildDefaultClaudeSettings();
    expect(settings).toMatchObject({ model: "sonnet", effortLevel: "xhigh" });
    expect(settings.env.MAX_THINKING_TOKENS).toBeUndefined();
  });

  it("keeps explicit provider model mappings when generating a new channel", () => {
    const config = JSON.parse(claudeTemplateJson("https://relay.example", "fixture-token", {
      ANTHROPIC_DEFAULT_SONNET_MODEL: "custom-sonnet",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
    }));
    expect(config).toMatchObject({
      model: "sonnet", effortLevel: "xhigh",
      env: {
        ANTHROPIC_BASE_URL: "https://relay.example",
        ANTHROPIC_AUTH_TOKEN: "fixture-token",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "custom-sonnet",
        CLAUDE_CODE_EFFORT_LEVEL: "max",
      },
    });
  });
});
