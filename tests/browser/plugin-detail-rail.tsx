// Open /tests/browser/plugin-detail-rail.html with the Vite dev server running.
// Two reported defects on the plugin detail page, both in the "left README +
// right rail" layout:
//   1. a README code line wider than the left column painted over the rail
//      (the plain <pre> that PluginReadme renders has no horizontal scroll);
//   2. after 展开全部, the sticky rail grew past the viewport and its bottom
//      rows could not be reached — scrolling only moved the left column.
// Mounts the real PluginDetailPage inside the app's real vertical chrome
// (40px session tab strip + 28px status bar, matching SessionTabStrip and
// AppStatusBar) so the rail's available height is the app's, drives the
// expand toggle through a real click, and reports PASS/FAIL with the
// measured boxes. No app shell, no backend, no saved state.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import type { MarketPlugin } from "../../src/lib/ipc";
import { PluginDetailPage } from "../../src/features/plugins/hub/PluginDetailPage";
import { useMarketplaceStore } from "../../src/features/plugins/marketplace/store";
import { usePluginsStore } from "../../src/features/plugins/manager/usePlugins";

localStorage.setItem("ccgui-next.language", "zh");

/** The reported plugin: 22 grants, and a README whose PowerShell fence is
 *  wider than the 728px left column at a 1145px window. */
const PERMISSIONS = [
  "storage",
  "host:session",
  "ui:composer-status",
  "ui:markdown",
  "ui:settings-section",
  "ui:status-bar",
  "ui:command",
  "theme",
  "i18n",
  "events",
  "exec:node",
  "network:api.deepseek.com",
  "network:openrouter.ai",
  "network:api.openai.com",
  "network:api.anthropic.com",
  "network:api.siliconflow.cn",
  "network:dashscope.aliyuncs.com",
  "network:ark.cn-beijing.volces.com",
  "network:api.moonshot.cn",
  "network:api.zhipuai.cn",
  "network:api.minimax.chat",
  "network:api.baichuan-ai.com",
];

const ENTRY: MarketPlugin = {
  id: "model-switcher",
  repo: "Guardian-J/ccgui-plugin-model-switcher",
  name: "模型与供应商助手",
  description:
    "模型与 CLI 选择、供应商渠道切换、独立渠道管理、全局主题、会话模型显示、幕布链接跳转，以及可选的 Claude Agent SDK 提示词清洗。",
  author: "Guardian-J",
  tier: "js",
  version: "1.0.29",
  updatedAt: null,
  minAppVersion: "1.0.5",
  sdkVersion: "^0.3.11",
  permissions: PERMISSIONS,
  downloads: 290,
  screenshots: [],
};

// The over-wide line: same shape as the reported README (one command, no
// wrapping point). 118 characters of monospace at 13px is ~810px.
const WIDE_COMMAND =
  "Get-Content -Encoding utf8 -Raw preview/check-provider-protection.js | agent-browser --session model-switcher-ui eval --stdin";

const README = `## 关于这个插件

支持模型与 CLI 选择、供应商渠道切换。

### 本地预览

上述脚本位于本地 \`preview/\`。预览使用模拟宿主接口。

\`\`\`powershell
${WIDE_COMMAND}
\`\`\`

| 命令 | 用途 |
| --- | --- |
| \`pnpm typecheck\` | 检查 src 中的 TypeScript 类型 |

${Array.from(
  { length: 24 },
  (_, i) => `第 ${i + 1} 段：切换渠道后重载插件并核对左下角版本号是否更新。`,
).join("\n\n")}`;

window.__PREVIEW_README__ = README;

useMarketplaceStore.setState({
  entries: [ENTRY],
  loaded: true,
  error: null,
  updates: [],
});
usePluginsStore.setState({ installed: [], loaded: true, error: null, installing: null });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  get: () => T | null | undefined,
  what: string,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value != null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const round = (value: number) => Math.round(value * 10) / 10;
const box = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return {
    left: round(rect.left),
    right: round(rect.right),
    top: round(rect.top),
    bottom: round(rect.bottom),
    height: round(rect.height),
  };
};

/** The page's own vertical scroller — the detail body, above the tab strip. */
function scrollerOf(element: Element): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === "auto") return node;
  }
  return null;
}

/** Ink box of a <pre>'s text: its block box stays at the column width even
 *  when the inline content overflows, so overflow needs the range rect. */
function textInkBox(pre: Element): { left: number; right: number } {
  const range = document.createRange();
  range.selectNodeContents(pre);
  const rect = range.getBoundingClientRect();
  return { left: round(rect.left), right: round(rect.right) };
}

function Test() {
  useEffect(() => {
    let cancelled = false;
    async function run() {
      await document.fonts.ready;
      await waitFor(() => document.querySelector(".prose-chat pre"), "the README code block");
      await sleep(300);
      if (cancelled) return;

      const aside = document.querySelector("aside")!;
      const leftColumn = aside.previousElementSibling as HTMLElement;
      const scroller = scrollerOf(aside)!;
      const pre = document.querySelector<HTMLElement>(".prose-chat pre")!;

      // (1) Wide README line: nothing may paint outside the left column. The
      //     line itself is wider than the column, so the fence has to absorb
      //     its own overflow — a plain <pre> used to spill ~190px past the
      //     column and strike through the rail's 版本/链接 rows. `overflow:
      //     visible` still reports scrollWidth > clientWidth, so the scroll
      //     check needs the computed overflow as well.
      const prose = pre.closest<HTMLElement>(".prose-plugin-readme")!;
      const leftBox = box(leftColumn);
      const asideBox = box(aside);
      const widestBlock = Math.max(
        ...[...prose.children].map((child) => round(child.getBoundingClientRect().right)),
      );
      const ink = textInkBox(pre);
      const overflowX = getComputedStyle(pre).overflowX;
      const codeScrolls =
        (overflowX === "auto" || overflowX === "scroll") && pre.scrollWidth > pre.clientWidth;
      const codeContained = ink.right <= leftBox.right + 1 || codeScrolls;
      const blocksContained =
        widestBlock <= leftBox.right + 1 && round(box(pre).right) <= asideBox.left;

      // (2) Expanded rail: it must fit the viewport instead of being pinned
      //     with its bottom rows off-screen. Bring the page to the position
      //     where the sticky top takes over (the state a reader scrolls the
      //     rail in) and then scroll the rail alone to its end.
      const expand = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("展开全部"),
      );
      if (!expand) throw new Error("the 展开全部 toggle is missing");
      expand.click();
      await sleep(250);
      if (cancelled) return;

      const STICKY_TOP = 24; // lg:top-6
      const scrollerTop = scroller.getBoundingClientRect().top;
      const toPin = aside.getBoundingClientRect().top - scrollerTop - STICKY_TOP;
      if (toPin > 0) scroller.scrollTop += toPin;
      await sleep(60);
      const railBox = box(aside);
      const railInsideViewport = railBox.bottom <= window.innerHeight + 1;

      const railOwnsScroll = aside.scrollHeight > aside.clientHeight + 1;
      const beforeMain = scroller.scrollTop;
      if (railOwnsScroll) aside.scrollTop = aside.scrollHeight;
      else scroller.scrollTop = scroller.scrollHeight;
      await sleep(60);
      const lastLink = [...aside.querySelectorAll("a, button")].at(-1)!;
      const lastLinkBox = box(lastLink);
      const railReachesBottom = lastLinkBox.bottom <= window.innerHeight + 1;
      const mainStayed = scroller.scrollTop === beforeMain;

      const pass =
        codeContained && blocksContained && railOwnsScroll && railInsideViewport && railReachesBottom && mainStayed;

      document.querySelector("#result")!.textContent = JSON.stringify(
        {
          status: pass ? "PASS" : "FAIL",
          code: {
            widestBlock,
            inkRight: ink.right,
            preRight: round(box(pre).right),
            columnRight: leftBox.right,
            railLeft: asideBox.left,
            contained: codeContained,
            blocksContained,
            scrolls: codeScrolls,
            overflowX,
            scrollWidth: pre.scrollWidth,
            clientWidth: pre.clientWidth,
          },
          rail: {
            top: railBox.top,
            bottom: railBox.bottom,
            viewport: window.innerHeight,
            clientHeight: aside.clientHeight,
            scrollHeight: aside.scrollHeight,
            scrollable: railOwnsScroll,
            insideViewport: railInsideViewport,
            lastRowBottom: lastLinkBox.bottom,
            reachesBottom: railReachesBottom,
            mainScrollTop: scroller.scrollTop,
            mainScrollStayed: mainStayed,
          },
        },
        null,
        2,
      );
    }
    void run().catch((error) => {
      document.querySelector("#result")!.textContent = JSON.stringify(
        { status: "ERROR", error: String(error) },
        null,
        2,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden">
      {/* Session tab strip (h-10) + hub header (h-12) + status bar (h-7):
          the same stack the hub scroll area sits under in the app. */}
      <div className="flex h-10 shrink-0 items-center border-b border-separator-border px-4 text-body-2-regular text-text-secondary">
        会话标签条
      </div>
      <div className="min-h-0 flex-1">
        <PluginDetailPage id={ENTRY.id} entry={ENTRY} onClose={() => {}} />
      </div>
      <div className="flex h-7 shrink-0 items-center justify-end border-t border-separator-border px-3 text-caption-1-medium text-text-tertiary">
        状态栏
      </div>
    </div>
  );
}

declare global {
  interface Window {
    __PREVIEW_README__?: string;
  }
}

createRoot(document.getElementById("root")!).render(<Test />);