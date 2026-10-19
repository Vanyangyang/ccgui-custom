import { useFileTreeVirtualList } from "./useFileTreeVirtualList";
import { useFileTreeOperations } from "./useFileTreeOperations";
import { FileTreeBody } from "./FileTreeBody";
import { FileTreeOverlays } from "./FileTreeOverlays";

export function FileTree() {
  const { parentRef, virtualizer, visible } = useFileTreeVirtualList();
  const ops = useFileTreeOperations();

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto py-1">
      <FileTreeBody
        virtualizer={virtualizer}
        visible={visible}
        onContextMenu={ops.openContextMenu}
      />
      <FileTreeOverlays ops={ops} />
    </div>
  );
}
