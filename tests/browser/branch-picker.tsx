// Open /tests/browser/branch-picker.html with the Vite dev server running.
// Regression for the branch dropdown no-op: the panel's cached branch list
// used to carry an isCurrent flag that lagged behind external (CLI)
// checkouts; clicking the stale-"current" row closed the menu without
// checking out. Current must be judged against the displayed branch
// (status.branch), so the click always runs checkout. Mounts the real
// ChangesPanelHeader; only the store's checkout is stubbed (it would invoke
// Tauri IPC). No app, no backend.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import { ChangesPanelHeader } from "../../src/features/git/ChangesPanelHeader";
import { useGitStore } from "../../src/features/git/store";
import type { BranchInfo } from "../../src/lib/ipc";

localStorage.setItem("ccgui-next.language", "zh");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(reason: string): never {
  throw new Error(reason);
}

const branches: BranchInfo[] = [
  "fix/git-changes-preview-layout",
  "main",
  "v1.0.0",
  "v1.0.1",
  "v1.0.3",
  "v1.0.4",
  "v1.0.4-base",
  "v1.0.5",
  "v1.0.6",
].map((name) => ({ name }));
const calls: string[] = [];

// Stub the store's checkout: records instead of invoking Tauri IPC.
useGitStore.setState({
  checkout: async (workspacePath: string, branch: string) => {
    calls.push(`checkout:${workspacePath}:${branch}`);
  },
});

/** Realistic press: pointerdown, pointerup, then click — like a mouse. */
function press(el: Element) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  el.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, button: 0 }),
  );
  el.dispatchEvent(
    new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y, button: 0 }),
  );
  (el as HTMLElement).click();
}

function Harness() {
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ width: 320 }}>
      <ChangesPanelHeader
        workspacePath="/ws/repo"
        notRepo={false}
        branch="fix/git-changes-preview-layout"
        ahead={undefined}
        behind={undefined}
        branches={branches}
        pending={{}}
        error={error}
        run={(key, action) => {
          calls.push(`run:${key}`);
          void Promise.resolve()
            .then(action)
            .catch((err: unknown) => setError(String(err)));
        }}
        onDismissError={() => setError(null)}
      />
    </div>
  );
}

async function main() {
  const root = createRoot(document.getElementById("root")!);
  root.render(<Harness />);
  await sleep(300);

  // 1. Open the branch dropdown.
  const trigger = document.querySelector<HTMLElement>("[data-testid='branch-trigger']")
    ?? [...document.querySelectorAll<HTMLElement>("button")].find((b) =>
      b.textContent?.includes("fix/git-changes-preview-layout"),
    );
  if (!trigger) fail("branch trigger not found");
  press(trigger);
  await sleep(300);

  const search = document.querySelector<HTMLInputElement>(
    "input[placeholder='搜索分支…']",
  );
  if (!search) fail("search input not found — popover did not open");

  // 2. Type the filter.
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(search, "1.0.6");
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(200);

  // 3. Click the v1.0.6 row.
  const row = [...document.querySelectorAll<HTMLElement>("button")].find(
    (b) => b.textContent?.trim() === "v1.0.6",
  );
  if (!row) fail("v1.0.6 row not found after filtering");
  press(row);
  await sleep(300);

  const readout = document.getElementById("readout")!;
  readout.textContent = JSON.stringify({ calls });

  if (!calls.includes("run:checkout")) {
    fail(`clicking the branch row did not run checkout: ${JSON.stringify(calls)}`);
  }
  if (!calls.includes("checkout:/ws/repo:v1.0.6")) {
    fail(`store checkout not called with v1.0.6: ${JSON.stringify(calls)}`);
  }

  document.title = "PASS";
  const badge = document.createElement("div");
  badge.id = "verdict";
  badge.textContent = "PASS";
  document.body.appendChild(badge);
}

main().catch((error) => {
  document.title = "FAIL";
  const badge = document.createElement("div");
  badge.id = "verdict";
  badge.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
  document.body.appendChild(badge);
});
