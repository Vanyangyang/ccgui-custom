/**
 * 发现页回归：skills.sh 的条目只有 name / repo / installs，行主体点开详情后
 * 回仓库读 SKILL.md（`remote_skill_content`）。这里盯住三件事：行里不重复
 * 贴仓库、详情真的去读正文、读不到时说人话并给仓库兜底而不是甩英文报错。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredSkill, SkillRemoteContent } from "./types";

const api = vi.hoisted(() => ({
  installed: vi.fn(),
  discover: vi.fn(),
  search: vi.fn(),
  popular: vi.fn(),
  repos: vi.fn(),
  updates: vi.fn(),
  activity: vi.fn(),
  usage: vi.fn(),
  content: vi.fn(),
  remoteContent: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  restore: vi.fn(),
  setTargets: vi.fn(),
  importLocal: vi.fn(),
  deleteLocal: vi.fn(),
  addRepo: vi.fn(),
  removeRepo: vi.fn(),
}));

vi.mock("./api", () => ({
  SkillsHubError: class SkillsHubError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  skillsHubApi: api,
}));

vi.mock("@/lib/transport", () => ({ isWeb: false, listen: vi.fn(async () => () => {}) }));

vi.mock("@/features/files/MarkdownPreview", () => ({
  MarkdownPreview: ({ draft }: { draft: string }) => <pre data-testid="markdown">{draft}</pre>,
}));

import "@/lib/i18n";
import { DiscoverPane } from "./DiscoverPane";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const popularSkill: DiscoveredSkill = {
  key: "mattpocock/skills/grill-with-docs",
  name: "grill-with-docs",
  description: "",
  directory: "grill-with-docs",
  readmeUrl: "https://github.com/mattpocock/skills",
  repoOwner: "mattpocock",
  repoName: "skills",
  repoBranch: "main",
  installs: 1028594,
};

const remote: SkillRemoteContent = {
  name: "grill-with-docs",
  description: "A relentless interview to sharpen a plan or design.",
  directory: "skills/engineering/grill-with-docs",
  path: "skills/engineering/grill-with-docs/SKILL.md",
  url: "https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/SKILL.md",
  repoUrl: "https://github.com/mattpocock/skills",
  markdown: "---\nname: grill-with-docs\n---\nAsk one question at a time.",
  truncated: false,
  branch: "main",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.popular.mockResolvedValue({ skills: [popularSkill], cached: false, generatedAt: Date.now() });
  api.discover.mockResolvedValue({ skills: [], cached: false, generatedAt: Date.now() });
  api.repos.mockResolvedValue({ repos: [] });
  api.remoteContent.mockResolvedValue(remote);
  api.install.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderPane() {
  await act(async () => {
    root.render(<DiscoverPane />);
  });
  await act(async () => {});
}

function rowText(): string {
  return document.querySelector("li")?.textContent ?? "";
}

async function openDetails(name = "grill-with-docs") {
  await act(async () => {
    document.querySelector<HTMLButtonElement>(`[aria-label="查看 ${name} 详情"]`)?.click();
  });
}

describe("DiscoverPane", () => {
  it("lists a skills.sh entry with repo and installs exactly once", async () => {
    await renderPane();
    const text = rowText();
    expect(text).toContain("grill-with-docs");
    expect(text).toContain("mattpocock/skills");
    expect(text).toContain("1028594 次安装");
    // 没描述时不再把仓库贴两遍（第二行就是仓库 + 安装数）。
    expect(text.split("mattpocock/skills").length - 1).toBe(1);
    expect(api.remoteContent).not.toHaveBeenCalled();
  });

  it("reads the SKILL.md from the repository when the row is opened", async () => {
    await renderPane();
    await openDetails();
    expect(api.remoteContent).toHaveBeenCalledWith(popularSkill);
    expect(document.querySelector('[data-testid="markdown"]')?.textContent).toContain(
      "Ask one question at a time.",
    );
    expect(document.body.textContent).toContain(
      "A relentless interview to sharpen a plan or design.",
    );
  });

  it("explains a missing SKILL.md and offers the repository instead of the raw error", async () => {
    const { SkillsHubError } = await import("./api");
    api.remoteContent.mockRejectedValueOnce(
      new SkillsHubError("not_found", 'No SKILL.md for "gh-cli" in github/awesome-copilot'),
    );
    await renderPane();
    await openDetails();
    expect(document.body.textContent).toContain("仓库里没有找到这个技能的 SKILL.md");
    expect(document.body.textContent).toContain("打开仓库");
    // 后端英文原文不冒充用户文案（not_found 由说明覆盖）。
    expect(document.body.textContent).not.toContain("No SKILL.md for");
  });

  it("installs from the detail dialog into the default engines", async () => {
    await renderPane();
    await openDetails();
    await act(async () => {
      buttonByText("安装").click();
    });
    expect(api.install).toHaveBeenCalledWith(popularSkill, ["claude", "codex"]);
    expect(buttonByText("已安装").disabled).toBe(true);
  });
});

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`button "${text}" not found`);
  return button;
}
