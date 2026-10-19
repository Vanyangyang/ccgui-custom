import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLUGIN_UI_TOKEN_CONTRACT } from "@ccgui/plugin-ui/tokens";

/**
 * 宿主 → @ccgui/plugin-ui 的 token 兼容承诺（packages/plugin-ui/src/tokens.ts
 * 头部注释）：清单内的 CSS 自定义属性不得在 theme.css 中重命名或删除——
 * 每个用了 plugin-ui 的插件样式都 var() 引用它们，改名会静默破坏所有
 * 插件 UI。此测试逐条断言定义仍在；扩约走 tokens.ts 加条目。
 */
const themeCss = readFileSync(
  path.resolve(__dirname, "../../styles/theme.css"),
  "utf8",
);

describe("plugin-ui token contract", () => {
  it("theme.css defines every contracted token", () => {
    const missing = PLUGIN_UI_TOKEN_CONTRACT.filter(
      (token) => !new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(themeCss),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the .dark override block (components carry no dark branches)", () => {
    expect(themeCss).toMatch(/\.dark\s*\{/);
  });

  it("contract has no duplicate entries", () => {
    expect(new Set(PLUGIN_UI_TOKEN_CONTRACT).size).toBe(PLUGIN_UI_TOKEN_CONTRACT.length);
  });

  /** 插件 bundle 样式注入在 `@layer ccgui-plugins`，层序在 `theme` 之后：
   *  自带 Tailwind 构建的插件会输出 `@layer theme { :root { --font-sans:
   *  var(--font-sans-host), …; --default-font-family: … } }`，而它自己又声明
   *  `--font-sans-host: var(--font-sans, …)`，两者构成自定义属性循环 → 计算值
   *  变为 guaranteed-invalid，宿主 preflight 回退到 `-apple-system, …`，设置页
   *  的界面/代码字体会静默失效（kimi-lb 插件实测）。修法是宿主在 :root 里以
   *  **无层**声明重推 `--font-sans` / `--font-mono` / `--default-font-family` /
   *  `--default-mono-font-family`（无层声明胜过所有 @layer）。此守卫防止未来
   *  重构把它们挪回 @theme 或删掉。
   */
  it("re-asserts the font stacks unlayered so plugin layers cannot clobber them", () => {
    const rootBlocks = [...themeCss.matchAll(/^:root\s*\{([\s\S]*?)^\}/gm)].map(
      (match) => match[1] ?? "",
    );
    const fontRoot = rootBlocks.find((block) => block.includes("--font-inter")) ?? "";
    expect(fontRoot).toMatch(/--font-sans:\s*var\(--font-inter\)/);
    expect(fontRoot).toMatch(/--font-mono:\s*var\(--font-mono-source\)/);
    expect(fontRoot).toMatch(/--default-font-family:\s*var\(--font-sans\)/);
    expect(fontRoot).toMatch(/--default-mono-font-family:\s*var\(--font-mono\)/);
  });
});
