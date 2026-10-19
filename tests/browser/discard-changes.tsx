// Open /tests/browser/discard-changes.html with the Vite dev server running.
// Smoke test for the changes panel's discard (撤销更改) action: worktree-side
// rows (unstaged/untracked) get a discard button, staged rows do not; the
// button opens a danger confirmation and only confirming calls the store's
// discard with the row's path. Mounts the real ChangesPanel; store mutations
// are stubbed (they would invoke Tauri IPC). No app, no backend.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import { ChangesPanel } from "../../src/features/git/ChangesPanel";
import { useGitStore } from "../../src/features/git/store";
import { useFilesStore } from "../../src/features/files/store";
import type { GitStatus } from "../../src/lib/ipc";

localStorage.setItem("ccgui-next.language", "zh");

function sleep(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function fail(reason: string): never {
  throw new Error(reason);
}

const WORKSPACE = "/tmp/discard-fixture";
const status: GitStatus = {
  branch: "main",
  staged: [{ path: "staged.txt", status: "M", additions: 3, deletions: 1 }],
  unstaged: [
    { path: "dirty.txt", status: "M", additions: 5, deletions: 2 },
    { path: "src/also-dirty.ts", status: "M", additions: 1, deletions: 0 },
  ],
  untracked: [{ path: ".zcodeignore", status: "??", additions: 72, deletions: 0 }],
};
const discarded: string[][] = [];

// Stub store actions: refresh/loadBranches would invoke Tauri IPC; discard
// records instead of mutating a repo.
useGitStore.setState({
  statusByWorkspace: { [WORKSPACE]: status },
  branchesByWorkspace: { [WORKSPACE]: [{ name: "main" }] },
  refresh: () => Promise.resolve(),
  loadBranches: () => Promise.resolve(),
  discard: (_workspace, files) => {
    discarded.push(files);
    return Promise.resolve();
  },
});
useFilesStore.setState({ selectedPath: null, repositories: {} });

/** Realistic press: pointerdown, pointerup, then click — like a mouse. */
function press(el: Element) {
  for (const type of ["pointerdown", "pointerup", "click"]) {
    el.dispatchEvent(
      new (window as unknown as Record<string, typeof MouseEvent>)[
        type.startsWith("pointer") ? "PointerEvent" : "MouseEvent"
      ](type, { bubbles: true, cancelable: true }),
    );
  }
}

async function main() {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <div style={{ width: 320, height: 480, display: "flex" }}>
      <ChangesPanel workspacePath={WORKSPACE} className="flex-1" />
    </div>,
  );
  await sleep(300);

  const readout = (msg: string) => {
    document.getElementById("readout")!.textContent = msg;
  };

  // Row discard buttons: exactly the unstaged + untracked rows, not staged.
  const discardButtons = () =>
    Array.from(document.querySelectorAll('button[aria-label="撤销更改"]'));
  if (discardButtons().length !== 3) {
    fail(`expected 3 discard buttons, got ${discardButtons().length}`);
  }
  // Group discard: one red 全部撤销 per worktree-side group header.
  const groupDiscard = Array.from(document.querySelectorAll("button")).filter(
    (b) => b.textContent === "全部撤销",
  );
  if (groupDiscard.length !== 2) {
    fail(`expected 2 group discard buttons, got ${groupDiscard.length}`);
  }
  if (!groupDiscard.every((b) => b.className.includes("text-text-error-primary"))) {
    fail("group discard buttons are not red");
  }

  // Clicking discard on the untracked row opens the confirmation dialog
  // naming the file; cancelling discards nothing.
  const untrackedRow = Array.from(document.querySelectorAll("li")).find((li) =>
    li.textContent?.includes(".zcodeignore"),
  );
  if (!untrackedRow) fail("untracked row not rendered");
  press(untrackedRow.querySelector('button[aria-label="撤销更改"]')!);
  await sleep(100);
  const dialogText = document.body.textContent ?? "";
  if (!dialogText.includes(".zcodeignore")) fail("dialog does not name the file");
  const cancel = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "取消",
  );
  if (!cancel) fail("cancel button missing");
  press(cancel);
  await sleep(100);
  if (discarded.length !== 0) fail("cancel still discarded");

  // Confirming discards exactly that path.
  press(untrackedRow.querySelector('button[aria-label="撤销更改"]')!);
  await sleep(100);
  const confirm = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "确认",
  );
  if (!confirm) fail("confirm button missing");
  press(confirm);
  await sleep(100);
  if (discarded.length !== 1 || discarded[0]!.join() !== ".zcodeignore") {
    fail(`discard called with ${JSON.stringify(discarded)}`);
  }
  if (document.body.textContent?.includes("确定要撤销")) {
    fail("dialog did not close after confirm");
  }

  // Group discard on 未暂存: the dialog cites the file count, confirm sends
  // both group paths in one call.
  const unstagedHeader = Array.from(document.querySelectorAll("section")).find((s) =>
    s.textContent?.includes("未暂存"),
  );
  if (!unstagedHeader) fail("unstaged section not rendered");
  press(
    Array.from(unstagedHeader.querySelectorAll("button")).find(
      (b) => b.textContent === "全部撤销",
    )!,
  );
  await sleep(100);
  if (!document.body.textContent?.includes("2 个文件")) {
    fail("group dialog does not cite the file count");
  }
  press(
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "确认")!,
  );
  await sleep(100);
  if (discarded.length !== 2 || discarded[1]!.join() !== "dirty.txt,src/also-dirty.ts") {
    fail(`group discard called with ${JSON.stringify(discarded)}`);
  }

  readout("PASS");
}

main().catch((error) => {
  document.getElementById("readout")!.textContent = `FAIL: ${String(error)}`;
});
