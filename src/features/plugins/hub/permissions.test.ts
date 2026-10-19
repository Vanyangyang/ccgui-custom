import { describe, expect, it } from "vitest";
import { describePermission } from "./permissions";

describe("describePermission", () => {
  it("names the base permissions individually", () => {
    expect(describePermission("storage").key).toBe("plugins.hub.permissions.storage");
    expect(describePermission("events").key).toBe("plugins.hub.permissions.events");
    expect(describePermission("composer:draft").key).toBe(
      "plugins.hub.permissions.composerDraft",
    );
    expect(describePermission("host:session").key).toBe("plugins.hub.permissions.hostSession");
    expect(describePermission("network:none").key).toBe("plugins.hub.permissions.networkNone");
  });

  it("names ui:* capabilities and falls back for unknown ui ids", () => {
    expect(describePermission("ui:status-bar").key).toBe("plugins.hub.permissions.uiStatusBar");
    expect(describePermission("ui:center-tab").key).toBe("plugins.hub.permissions.uiCenterTab");
    expect(describePermission("ui:future-thing").key).toBe("plugins.hub.permissions.ui");
  });

  it("carries the CLI / host into the grant-shaped permissions", () => {
    expect(describePermission("exec:claude")).toEqual({
      key: "plugins.hub.permissions.exec",
      params: { name: "claude" },
    });
    expect(describePermission("network:api.deepseek.com")).toEqual({
      key: "plugins.hub.permissions.network",
      params: { host: "api.deepseek.com" },
    });
  });

  it("never hides an unrecognized grant", () => {
    expect(describePermission("future:thing")).toEqual({
      key: "plugins.hub.permissions.unknown",
      params: { name: "future:thing" },
    });
  });
});
