import { describe, expect, it } from "vitest";
import type { MarketPlugin } from "@/lib/ipc";
import {
  categorizePlugin,
  categoryCounts,
  githubAvatarUrl,
  githubLoginFor,
  indexUpdatedAt,
  isOfficialPlugin,
  pluginAvatarGradient,
  pluginInitial,
  pluginMatchesQuery,
  resolveReadmeUrl,
  sortByDownloads,
  sortPlugins,
} from "./catalog";

const entry = (id: string, overrides: Partial<MarketPlugin> = {}): MarketPlugin => ({
  id,
  repo: `owner/${id}`,
  name: id,
  description: "",
  author: "tester",
  tier: "js",
  version: "1.0.0",
  minAppVersion: null,
  sdkVersion: null,
  permissions: [],
  downloads: null,
  screenshots: [],
  icon: null,
  updatedAt: null,
  ...overrides,
});

describe("categorizePlugin", () => {
  it("classifies the real index entries the way the sections promise", () => {
    expect(
      categorizePlugin({
        id: "react-doctor",
        name: "React Doctor",
        description: "一键运行 npx react-doctor@latest 代码体检",
      }),
    ).toBe("dev");
    expect(
      categorizePlugin({
        id: "auto-title",
        name: "会话自动命名",
        description: "每轮对话结束后生成会话标题",
      }),
    ).toBe("productivity");
    expect(
      categorizePlugin({
        id: "composer-rainbow-border",
        name: "彩虹跑马灯边界线",
        description: "为聊天输入框添加沿边界持续流动的彩虹跑马灯效果",
      }),
    ).toBe("appearance");
    expect(
      categorizePlugin({
        id: "model-switcher",
        name: "模型与供应商助手",
        description: "模型与 CLI 选择、供应商渠道切换、全局主题",
      }),
    ).toBe("integration");
  });

  it("falls back to 其他 when nothing matches", () => {
    expect(categorizePlugin({ id: "mystery", name: "Mystery", description: "?" })).toBe("other");
  });
});

describe("pluginInitial", () => {
  it("uppercases latin initials and keeps CJK / emoji intact", () => {
    expect(pluginInitial("react-doctor")).toBe("R");
    expect(pluginInitial("会话自动命名")).toBe("会");
    // Code-point iteration: the emoji stays one unit, not half a surrogate.
    expect(pluginInitial("🎨 themes")).toBe("🎨");
    expect(pluginInitial("   ")).toBe("?");
  });
});

describe("pluginAvatarGradient", () => {
  it("is deterministic per id and picks from the palette", () => {
    expect(pluginAvatarGradient("auto-title")).toEqual(pluginAvatarGradient("auto-title"));
    const { from, to } = pluginAvatarGradient("auto-title");
    expect(from).toMatch(/^#[0-9a-f]{6}$/i);
    expect(to).toMatch(/^#[0-9a-f]{6}$/i);
    expect(from).not.toBe(to);
  });
});

describe("githubLoginFor", () => {
  it("prefers a GitHub-shaped author and falls back to the repo owner", () => {
    expect(githubLoginFor({ author: "libo-zhou", repo: "someone/plugin" })).toBe("libo-zhou");
    expect(githubLoginFor({ author: " libo-zhou ", repo: "someone/plugin" })).toBe("libo-zhou");
    // Display-name authors still resolve to the account that published.
    expect(githubLoginFor({ author: "李波 · 插件作者", repo: "libo-zhou/ccgui-plugin-x" })).toBe(
      "libo-zhou",
    );
  });

  it("yields null when nothing is a real GitHub login", () => {
    expect(githubLoginFor({ author: "插件作者" })).toBeNull();
    expect(githubLoginFor({ author: "李波", repo: "ccgui-plugins" })).toBeNull();
    // The repo isn't `owner/name`, so no owner can be trusted.
    expect(githubLoginFor({ author: "", repo: "bad/owner/extra" })).toBeNull();
    expect(githubLoginFor({ author: "-leading" })).toBeNull();
    expect(githubLoginFor({ author: "trailing-" })).toBeNull();
    expect(githubLoginFor({ author: "a".repeat(40) })).toBeNull();
  });
});

describe("githubAvatarUrl", () => {
  it("asks GitHub for the account avatar at 2× the chip size, capped", () => {
    expect(githubAvatarUrl("libo-zhou", 20)).toBe("https://github.com/libo-zhou.png?size=40");
    expect(githubAvatarUrl("libo-zhou", 400)).toBe("https://github.com/libo-zhou.png?size=460");
  });
});

describe("indexUpdatedAt", () => {
  it("reads the index stamp and refuses anything that is not a date", () => {
    expect(indexUpdatedAt("2026-09-20T08:30:00Z")?.toISOString()).toBe(
      "2026-09-20T08:30:00.000Z",
    );
    // Entries registered before the field existed, plus hostile index rows:
    // the rail hides rather than printing "Invalid Date".
    expect(indexUpdatedAt(null)).toBeNull();
    expect(indexUpdatedAt(undefined)).toBeNull();
    expect(indexUpdatedAt("")).toBeNull();
    expect(indexUpdatedAt("v0.7.0")).toBeNull();
    expect(indexUpdatedAt("2026-13-45T00:00:00Z")).toBeNull();
  });
});

describe("isOfficialPlugin", () => {
  it("matches the publisher account behind author or repo owner", () => {
    expect(isOfficialPlugin({ author: "zhukunpenglinyutong" })).toBe(true);
    expect(isOfficialPlugin({ author: "ZhukunPengLinYuTong" })).toBe(true);
    // A display name still resolves through the repo owner (githubLoginFor).
    expect(
      isOfficialPlugin({
        author: "诸昆鹏",
        repo: "zhukunpenglinyutong/ccgui-plugin-react-doctor",
      }),
    ).toBe(true);
  });

  it("rejects third-party publishers and unresolvable identities", () => {
    expect(
      isOfficialPlugin({ author: "libo-zhou", repo: "libo-zhou/ccgui-plugin-x" }),
    ).toBe(false);
    expect(isOfficialPlugin({ author: "tester", repo: "owner/plugin" })).toBe(false);
    expect(isOfficialPlugin({ author: "插件作者" })).toBe(false);
  });
});

describe("sortByDownloads", () => {
  it("ranks counted entries first, then name, and does not mutate the input", () => {
    const input = [
      entry("b", { downloads: 5, name: "B" }),
      entry("c", { downloads: null, name: "C" }),
      entry("a", { downloads: 5, name: "A" }),
      entry("d", { downloads: 9, name: "D" }),
    ];
    expect(sortByDownloads(input).map((item) => item.id)).toEqual(["d", "a", "b", "c"]);
    expect(input.map((item) => item.id)).toEqual(["b", "c", "a", "d"]);
  });
});

describe("sortPlugins", () => {
  const input = [
    entry("b", { downloads: 1, name: "Bravo", author: "libo-zhou" }),
    entry("a", { downloads: 9, name: "Alpha", author: "zhukunpenglinyutong" }),
    entry("c", { downloads: null, name: "Charlie", author: "libo-zhou" }),
  ];

  it("ranks downloads for the two ranking orders and leaves the input alone", () => {
    expect(sortPlugins(input, "smart").map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(sortPlugins(input, "downloads").map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(input.map((item) => item.id)).toEqual(["b", "a", "c"]);
  });

  it("keeps only the chosen audience for 官方 / 第三方, still downloads-ranked", () => {
    expect(sortPlugins(input, "official").map((item) => item.id)).toEqual(["a"]);
    expect(sortPlugins(input, "thirdParty").map((item) => item.id)).toEqual(["b", "c"]);
  });
});

describe("categoryCounts", () => {
  it("counts each category in fixed order and drops the empty ones", () => {
    expect(
      categoryCounts([
        entry("rainbow", { name: "彩虹", description: "彩虹主题" }),
        entry("doctor", { name: "Doctor", description: "代码体检" }),
        entry("doctor-2", { name: "Doctor two", description: "代码健检" }),
        entry("misc", { name: "Misc", description: "nothing" }),
      ]),
    ).toEqual([
      { category: "dev", count: 2 },
      { category: "appearance", count: 1 },
      { category: "other", count: 1 },
    ]);
  });

  it("returns nothing for an empty index", () => {
    expect(categoryCounts([])).toEqual([]);
  });
});

describe("pluginMatchesQuery", () => {
  const item = entry("auto-title", {
    name: "会话自动命名",
    description: "生成标题",
    author: "zhukunpeng",
  });

  it("matches id, name, description and author, case-insensitively", () => {
    expect(pluginMatchesQuery(item, "AUTO")).toBe(true);
    expect(pluginMatchesQuery(item, "自动")).toBe(true);
    expect(pluginMatchesQuery(item, "标题")).toBe(true);
    expect(pluginMatchesQuery(item, "zhukunpeng")).toBe(true);
    expect(pluginMatchesQuery(item, "missing")).toBe(false);
    expect(pluginMatchesQuery(item, "  ")).toBe(true);
  });
});

describe("resolveReadmeUrl", () => {
  const repo = "owner/ccgui-plugin-demo";

  it("loads relative images from raw and relative links from the blob page", () => {
    expect(resolveReadmeUrl("docs/shot.png", "image", repo)).toBe(
      "https://raw.githubusercontent.com/owner/ccgui-plugin-demo/HEAD/docs/shot.png",
    );
    expect(resolveReadmeUrl("./docs/a b.png", "image", repo)).toBe(
      "https://raw.githubusercontent.com/owner/ccgui-plugin-demo/HEAD/docs/a%20b.png",
    );
    expect(resolveReadmeUrl("docs/guide.zh-CN.md", "link", repo)).toBe(
      "https://github.com/owner/ccgui-plugin-demo/blob/HEAD/docs/guide.zh-CN.md",
    );
  });

  it("passes absolute https and mailto through", () => {
    expect(resolveReadmeUrl("https://example.com/a.png", "image", repo)).toBe(
      "https://example.com/a.png",
    );
    expect(resolveReadmeUrl(" mailto:dev@example.com ", "link", repo)).toBe(
      "mailto:dev@example.com",
    );
  });

  it("drops other schemes and anything that escapes the repo", () => {
    expect(resolveReadmeUrl("http://example.com/a.png", "image", repo)).toBe("");
    expect(resolveReadmeUrl("javascript:alert(1)", "link", repo)).toBe("");
    expect(resolveReadmeUrl("//evil.test/a.png", "image", repo)).toBe("");
    expect(resolveReadmeUrl("../../outside.png", "image", repo)).toBe("");
    expect(resolveReadmeUrl("", "image", repo)).toBe("");
  });

  it("keeps same-document anchors as links and drops them as images", () => {
    expect(resolveReadmeUrl("#install", "link", repo)).toBe("#install");
    expect(resolveReadmeUrl("#install", "image", repo)).toBe("");
  });
});
