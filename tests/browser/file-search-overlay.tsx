// Open /tests/browser/file-search-overlay.html with the Vite dev server
// running. Renders the real FileSearchOverlay with a mocked `list_file_index`
// inside the file panel's own width, so the folder scope can be checked by
// hand: searching `src/` must never surface `src-extra/`, the keyboard must
// drive the rows, and Escape must close.
//
// The scope is switched from the fixture toolbar (wide / src / src-extra /
// deep folder) instead of through the context menu, which needs a real tree.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import { FileSearchOverlay } from "../../src/features/files/FileSearchOverlay";
import { useFilesStore } from "../../src/features/files/store";

const WORKSPACE = "S:/AIWorker/proj";

const SCOPES: Array<{ label: string; dir: string }> = [
  { label: "工作区根", dir: WORKSPACE },
  { label: "src", dir: `${WORKSPACE}/src` },
  { label: "src-extra", dir: `${WORKSPACE}/src-extra` },
  { label: "src/features/files/deep", dir: `${WORKSPACE}/src/features/files/deep` },
];

interface FixtureBridge {
  state: { invokes: Array<{ cmd: string }> };
}
declare global {
  interface Window {
    __fixture?: FixtureBridge;
  }
}

function StoreReadout() {
  const searchRoot = useFilesStore((s) => s.searchRoot);
  const activeFilePath = useFilesStore((s) => s.activeFilePath);
  const selectedPath = useFilesStore((s) => s.selectedPath);
  const openFiles = useFilesStore((s) => s.openFiles);
  return (
    <pre
      id="store-readout"
      className="mx-2 w-fit rounded bg-background-tertiary-default p-2 text-caption-1-regular text-text-secondary"
    >
      {JSON.stringify(
        {
          searchRoot,
          activeFilePath,
          selectedPath,
          openFiles,
          invoked: window.__fixture?.state.invokes.map((i) => i.cmd),
        },
        null,
        1,
      )}
    </pre>
  );
}

function Fixture() {
  const [scope, setScope] = useState(SCOPES[1]!.dir);
  const searchRoot = useFilesStore((s) => s.searchRoot);

  // The panel normally roots the store at the active workspace on mount; a
  // scope button stands in for the tree's right-click → 搜索文件.
  useEffect(() => {
    useFilesStore.setState({ root: WORKSPACE, searchRoot: scope });
  }, [scope]);

  return (
    <div className="mx-auto mt-6 flex flex-col gap-3">
      <div className="flex gap-2 px-2">
        {SCOPES.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => setScope(s.dir)}
            className={
              s.dir === scope
                ? "cursor-pointer rounded bg-background-tertiary-active px-2 py-1 text-body-medium text-text-primary"
                : "cursor-pointer rounded bg-background-tertiary-default px-2 py-1 text-body-medium text-text-secondary"
            }
          >
            {s.label}
          </button>
        ))}
        <span className="px-2 py-1 text-caption-1-regular text-text-tertiary">
          scope = {scope}
        </span>
      </div>
      {/* The file panel is 280px wide in the app; the overlay lives inside it.
          Rendered only while `searchRoot` is set — same gate as FilesPanel. */}
      <div className="relative flex h-[420px] w-[280px] flex-col overflow-hidden rounded-xl border border-separator-border bg-background-primary-default">
        {searchRoot ? (
          <FileSearchOverlay searchRoot={searchRoot} />
        ) : (
          <p className="px-3 py-4 text-caption-1-regular text-text-tertiary">
            overlay closed — press a scope button to reopen
          </p>
        )}
      </div>
      <StoreReadout />
    </div>
  );
}

createRoot(document.getElementById("fixture")!).render(<Fixture />);
