/**
 * IPC 形状回归：desktop 端 `skills_hub_mutate` 的签名是两个参数
 * (`action: String`, `payload: Value`)，而查询是 (`mode`, `params`)。
 * 曾经把变更参数拍平成一个对象直接 invoke，所有变更（安装 / 纳管 / 同步 /
 * 卸载）都报「invalid args `payload` … missing required key payload」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => ({ web: false }));

vi.mock("@/lib/transport", () => ({ get isWeb() { return runtime.web; }, invoke }));
vi.mock("@/components/application/ai-chat/slash-commands", () => ({
  invalidateSlashCommandCatalog: vi.fn(),
}));

import { SkillsHubError, skillsHubApi } from "./api";
import type { DiscoveredSkill } from "./types";

const discovered: DiscoveredSkill = {
  key: "anthropics/skills:alpha",
  name: "alpha",
  description: "managed skill",
  directory: "alpha",
  readmeUrl: null,
  repoOwner: "anthropics",
  repoName: "skills",
  repoBranch: "main",
};

describe.each([false, true])("skills hub invoke args (web=%s)", (web) => {
  beforeEach(() => {
    runtime.web = web;
    invoke.mockReset();
    invoke.mockResolvedValue({ ok: true });
  });

  it("splits the action from the payload for skills_hub_mutate", async () => {
    await skillsHubApi.setTargets("local:beta", ["claude"]);
    expect(invoke).toHaveBeenCalledWith("skills_hub_mutate", {
      action: "set_targets",
      payload: { id: "local:beta", targets: ["claude"] },
    });
  });

  it("keeps install's skill bag and force inside the payload", async () => {
    await skillsHubApi.install(discovered, ["claude", "codex"], true);
    expect(invoke).toHaveBeenCalledWith("skills_hub_mutate", {
      action: "install",
      payload: {
        force: true,
        skill: {
          name: "alpha",
          description: "managed skill",
          directory: "alpha",
          repoOwner: "anthropics",
          repoName: "skills",
          repoBranch: "main",
        },
        targets: ["claude", "codex"],
      },
    });
  });

  it("sends queries as mode + params, not as a mutation", async () => {
    await skillsHubApi.installed();
    expect(invoke).toHaveBeenCalledWith("skills_hub_query", {
      mode: "installed",
      params: {},
    });
  });

  it("normalizes backend { code, message } errors for callers that branch on code", async () => {
    invoke.mockRejectedValueOnce({ code: "conflict", message: "already managed" });
    const error = await skillsHubApi.uninstall("x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SkillsHubError);
    expect((error as SkillsHubError).code).toBe("conflict");
  });
});
