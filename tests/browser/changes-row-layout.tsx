// Open /tests/browser/changes-row-layout.html with the Vite dev server running.
// Regression for the changes-panel row layout: rows used to reserve four
// permanent trailing columns (fixed 4.5rem stats, new-file dot slot, discard
// slot, action slot) that sat empty on most rows — e.g. a staged "+3"-only
// row wasted its whole right side. Now the grid is status | path | stats
// (content-sized), the new-file dot lives inside the stats cell, and the
// row actions float as an absolutely positioned overlay revealed on hover
// or keyboard focus, so the path and stats use the full row width.
// Mounts the real ChangesPanel; store actions that would invoke Tauri IPC
// are stubbed. No app, no backend.
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

const WORKSPACE = "/tmp/row-layout-fixture";
const status: GitStatus = {
  branch: "main",
  staged: [
    // Screenshot repro: additions-only staged row, used to leave the whole
    // reserved right side empty.
    { path: "src/engine/motion.ts", status: "M", additions: 3, deletions: 0 },
    { path: "src/engine/pi_flow.ts", status: "M", additions: 1, deletions: 1 },
    { path: "src/ai-chat/client.ts", status: "M", additions: 30, deletions: 4 },
    { path: "src/components/error.tsx", status: "A", additions: 30, deletions: 0 },
  ],
  unstaged: [{ path: "src/dirty.ts", status: "M", additions: 5, deletions: 2 }],
  untracked: [{ path: "src/new-file.ts", status: "??", additions: 72, deletions: 0 }],
};

useGitStore.setState({
  statusByWorkspace: { [WORKSPACE]: status },
  branchesByWorkspace: { [WORKSPACE]: [{ name: "main" }] },
  refresh: () => Promise.resolve(),
  loadBranches: () => Promise.resolve(),
});
useFilesStore.setState({ selectedPath: null, repositories: {} });

function rowOf(text: string): HTMLLIElement {
  const row = Array.from(document.querySelectorAll("li")).find((li) =>
    li.textContent?.includes(text),
  );
  if (!row) fail(`row for ${text} not rendered`);
  return row as HTMLLIElement;
}

async function main() {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <div style={{ width: 320, height: 480, display: "flex" }}>
      <ChangesPanel workspacePath={WORKSPACE} className="flex-1" />
    </div>,
  );
  await sleep(300);

  // 1. The row grid has exactly three tracks: status letter, path, stats.
  const row = rowOf("motion.ts");
  const tracks = getComputedStyle(row).gridTemplateColumns.split(" ");
  if (tracks.length !== 3) {
    fail(`expected 3 grid tracks, got ${tracks.length} (${tracks.join("|")})`);
  }

  // 2. Stats sit at the row's right padding edge even for an additions-only
  //    row — no reserved space where "−0" / buttons would have been.
  const addSpan = Array.from(row.querySelectorAll("span")).find(
    (s) => s.textContent === "+3",
  );
  if (!addSpan) fail("additions stat not rendered");
  const statsCell = addSpan.parentElement!;
  const liRight = row.getBoundingClientRect().right;
  const statsRight = statsCell.getBoundingClientRect().right;
  if (Math.abs(liRight - 12 - statsRight) > 2) {
    fail(`stats do not reach the right edge (gap ${liRight - 12 - statsRight}px)`);
  }

  // 3. Row actions are an absolutely positioned overlay, hidden until the
  //    row is hovered or the button gains keyboard focus.
  const unstageBtn = row.querySelector('button[aria-label="取消暂存"]');
  if (!unstageBtn) fail("unstage action not rendered");
  const overlay = unstageBtn.parentElement!;
  if (getComputedStyle(overlay).position !== "absolute") {
    fail("row actions are not an overlay");
  }
  if (getComputedStyle(overlay).opacity !== "0") fail("overlay visible without hover");
  if (getComputedStyle(overlay).pointerEvents !== "none") {
    fail("hidden overlay still intercepts clicks");
  }
  (unstageBtn as HTMLButtonElement).focus();
  await sleep(50);
  if (getComputedStyle(overlay).opacity !== "1") {
    fail("overlay not revealed on keyboard focus");
  }
  (unstageBtn as HTMLButtonElement).blur();

  // 4. Staged rows get exactly one action (unstage); unstaged rows get two
  //    (discard + stage) inside the same overlay.
  if (overlay.querySelectorAll("button").length !== 1) {
    fail("staged row should have exactly one overlay action");
  }
  const dirtyRow = rowOf("dirty.ts");
  const dirtyOverlay = dirtyRow.querySelector('button[aria-label="暂存"]')!.parentElement!;
  if (dirtyOverlay.querySelectorAll("button").length !== 2) {
    fail("unstaged row should have discard + stage actions");
  }

  // 5. The untracked row's new-file dot now lives inside the stats cell
  //    instead of its own reserved column.
  const newRow = rowOf("new-file.ts");
  const dot = newRow.querySelector('span[role="img"][aria-label="新文件"]');
  if (!dot) fail("new-file dot not rendered");
  const newAddSpan = Array.from(newRow.querySelectorAll("span")).find(
    (s) => s.textContent === "+72",
  );
  if (!newAddSpan) fail("untracked stats missing");
  if (!newAddSpan.parentElement!.contains(dot)) {
    fail("new-file dot is not inside the stats cell");
  }

  document.getElementById("readout")!.textContent = "PASS";
}

main().catch((error) => {
  document.getElementById("readout")!.textContent = `FAIL: ${String(error)}`;
});
