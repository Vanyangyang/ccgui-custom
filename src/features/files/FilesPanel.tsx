import { useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { useFilesStore } from "./store";
import { FileTree } from "./FileTree";
import { FileSearchOverlay } from "./FileSearchOverlay";
import { useProjectContext } from "@/features/projects/store";

/**
 * Right-panel file browser rooted at the active workspace. Clicking a file
 * opens it as a tab in the center area (see ChatPage). The workspace search
 * overlay (tree right-click → Search) covers the tree while it is open.
 */
export function FilesPanel({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  const root = useFilesStore((s) => s.root);
  const setProjectRoots = useFilesStore((s) => s.setProjectRoots);
  const { roots } = useProjectContext(workspacePath);
  const searchRoot = useFilesStore((s) => s.searchRoot);

  // The tree always roots at the active workspace.
  useLayoutEffect(() => {
    setProjectRoots(workspacePath, roots);
  }, [workspacePath, roots, setProjectRoots]);

  // Guard against the store still pointing at a previously persisted root:
  // the tree only renders once it tracks this workspace.
  const ready = root === workspacePath;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {ready ? (
        <FileTree key={`${workspacePath}:${roots.map((root) => root.path).join("\n")}`} />
      ) : (
        <p className="px-3 py-4 text-caption-1-regular text-text-tertiary">
          {t("common.loading")}
        </p>
      )}
      {searchRoot ? <FileSearchOverlay searchRoot={searchRoot} /> : null}
    </div>
  );
}
