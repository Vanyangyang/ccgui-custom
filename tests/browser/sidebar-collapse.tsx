// Open /tests/browser/sidebar-collapse.html with the Vite dev server running.
// Drives the real AiChatSidebar and samples the「WORKTREES」group region frame
// by frame: collapsing the group, re-expanding it, and expanding one worktree
// child row must each move through intermediate heights (the grid-rows
// transition), not jump between two values in a single frame. Content must
// stay in the DOM while the region clips shut, so the shrink is visible.
// Static props, no app backend, no saved conversation.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import { AiChatSidebar } from "../../src/components/application/ai-chat/ai-chat-sidebar";
import type { AiChatRepo } from "../../src/components/application/ai-chat/ai-chat-sidebar";

const repos: AiChatRepo[] = [
  {
    id: "ws-parent",
    label: "parent-repo",
    defaultOpen: true,
    threads: [{ id: "t-parent", label: "parent thread", time: "1m" }],
    worktrees: [
      {
        id: "ws-wt-1",
        label: "pr-201-fix",
        worktree: { branch: "pr-201-fix", prNumber: 201 },
        defaultOpen: false,
        threads: [
          { id: "t-wt-1a", label: "worktree thread A", time: "2m" },
          { id: "t-wt-1b", label: "worktree thread B", time: "3m" },
        ],
      },
      {
        id: "ws-wt-2",
        label: "pr-202-fix",
        worktree: { branch: "pr-202-fix", prNumber: 202 },
        threads: [{ id: "t-wt-2a", label: "worktree thread C", time: "4m" }],
      },
    ],
  },
];

interface Sample {
  /** ms since the click, rounded. */
  t: number;
  /** Region height, rounded to 0.1px. */
  h: number;
  /** Whether the region's rows were still in the DOM at this sample. */
  content: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((el) =>
    (el.textContent ?? "").includes(text),
  );
  if (!button) throw new Error(`no button containing "${text}"`);
  return button;
}

/** The「WORKTREES · n」group root: group header row's parent. Its height owns
 *  both the header and the animated children region below it. */
function groupRoot(): HTMLElement {
  const header = buttonWithText("Worktrees");
  const root = header.parentElement?.parentElement;
  if (!root) throw new Error("no group root above the Worktrees header");
  return root;
}

/** The child row's own collapse region (a sibling of the row, inside the
 *  row wrapper). */
function childRegion(label: string): HTMLElement {
  const button = buttonWithText(label);
  const wrapper = button.parentElement?.parentElement;
  const region = wrapper?.querySelector<HTMLElement>('div[class*="grid-rows-"]');
  if (!wrapper || !region) throw new Error(`no collapse region beside ${label}`);
  return region;
}

/** Record the region height before the click, right after it, and once per
 *  animation frame for `ms`. */
async function sampleHeights(
  region: HTMLElement,
  ms: number,
  click: () => void,
  contentMarker: string,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  const start = performance.now();
  const hasContent = () => (region.textContent ?? "").includes(contentMarker);
  const record = () => {
    samples.push({
      t: Math.round(performance.now() - start),
      h: Math.round(region.getBoundingClientRect().height * 10) / 10,
      content: hasContent(),
    });
  };
  record();
  click();
  record();
  await new Promise<void>((resolve) => {
    const tick = () => {
      record();
      if (performance.now() - start >= ms) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return samples;
}

/** Count of sampled heights strictly between the first and last value: an
 *  instant jump yields 0, a transition yields one value per frame. */
function intermediateCount(samples: Sample[]): number {
  if (samples.length === 0) return 0;
  const first = samples[0].h;
  const last = samples[samples.length - 1].h;
  const low = Math.min(first, last);
  const high = Math.max(first, last);
  return samples.filter((s) => s.h > low + 0.5 && s.h < high - 0.5).length;
}

function describe(samples: Sample[]): string {
  const first = samples[0]?.h ?? 0;
  const last = samples[samples.length - 1]?.h ?? 0;
  return `${first} → ${last}px, ${intermediateCount(samples)} intermediate frames of ${samples.length}`;
}

function Harness() {
  const [status, setStatus] = useState("Running…");
  const [details, setDetails] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const failures: string[] = [];
      const lines: string[] = [];
      await sleep(500);

      const root = groupRoot();
      const groupOpenHeight = root.getBoundingClientRect().height;
      const groupContentVisible = root.textContent?.includes("pr-201-fix") === true;
      if (!groupContentVisible) failures.push("worktree rows missing before the first click");

      // 1. Collapse the group.
      const collapse = await sampleHeights(
        root,
        600,
        () => buttonWithText("Worktrees").click(),
        "pr-201-fix",
      );
      lines.push(`collapse group: ${describe(collapse)}`);
      if (intermediateCount(collapse) < 3) {
        failures.push(`group collapse jumped instead of animating: ${describe(collapse)}`);
      }
      if ((collapse[collapse.length - 1]?.h ?? Infinity) > groupOpenHeight - 40) {
        failures.push(`group did not collapse: ${describe(collapse)}`);
      }
      const midClose = (collapse.find((s) => s.t >= 80) ?? collapse[collapse.length - 1])!;
      lines.push(`at ${midClose.t}ms after collapse click → ${midClose.h}px, rows mounted: ${midClose.content}`);
      if (!midClose.content) {
        failures.push("rows unmounted before the close animation could show them");
      }
      if (collapse[collapse.length - 1]?.content !== false) {
        failures.push("collapsed rows never left the DOM");
      }

      // 2. Expand the group again — same requirement in the other direction.
      const expand = await sampleHeights(
        root,
        600,
        () => buttonWithText("Worktrees").click(),
        "pr-201-fix",
      );
      lines.push(`expand group: ${describe(expand)}`);
      if (intermediateCount(expand) < 3) {
        failures.push(`group expand jumped instead of animating: ${describe(expand)}`);
      }
      if (Math.abs((expand[expand.length - 1]?.h ?? 0) - groupOpenHeight) > 2) {
        failures.push(`group did not return to its open height: ${describe(expand)}`);
      }

      // 3. Expanding one worktree child grows its own region the same way.
      const region = childRegion("pr-201-fix");
      const closedHeight = region.getBoundingClientRect().height;
      const child = await sampleHeights(
        region,
        600,
        () => buttonWithText("pr-201-fix").click(),
        "worktree thread A",
      );
      lines.push(`expand worktree child: ${describe(child)}`);
      if (intermediateCount(child) < 3) {
        failures.push(`worktree child expand jumped instead of animating: ${describe(child)}`);
      }
      if ((child[child.length - 1]?.h ?? 0) <= closedHeight + 10) {
        failures.push(`worktree child threads did not appear: ${describe(child)}`);
      }
      if (!region.textContent?.includes("worktree thread A")) {
        failures.push("worktree child threads missing after expanding the row");
      }

      if (cancelled) return;
      setDetails(lines);
      setStatus(failures.length === 0 ? "PASS" : `FAIL: ${failures.join(" | ")}`);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const passed = status === "PASS";
  return (
    <main className="flex min-h-dvh gap-6 bg-background-primary-default p-6 font-mono text-body-2-regular">
      <div style={{ height: 720 }} className="flex shrink-0">
        <AiChatSidebar repos={repos} />
      </div>
      <div className="max-w-xl">
        <h1 className="mb-3 text-body-1-semibold">Worktree 展开/收起动效验证</h1>
        <p data-status={status} className={passed ? "text-status-green-text" : "text-text-error-primary"}>
          {status}
        </p>
        <ul className="mt-3 list-disc pl-5 text-text-secondary">
          {details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-3 text-text-tertiary">
          PASS 要求每次展开/收起都经过 ≥3 个中间帧高度，且收起过程中内容仍在 DOM 里。
        </p>
      </div>
    </main>
  );
}

createRoot(document.getElementById("fixture")!).render(<Harness />);
