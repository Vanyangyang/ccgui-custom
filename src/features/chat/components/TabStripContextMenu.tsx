import X from "lucide-react/dist/esm/icons/x";
import CircleX from "lucide-react/dist/esm/icons/circle-x";
import Columns2 from "lucide-react/dist/esm/icons/columns-2";
import { useTranslation } from "react-i18next";
import { ContextMenu } from "@/components/context-menu";
import { useSplitStore } from "../split/store";

/** Tab right-click menu (close all / close others, plus 退出分屏 while the
 *  conversation area is tiled), anchored at the pointer like every other
 *  context menu in the app. */
export function TabStripContextMenu({
  menu,
  onCloseAll,
  onCloseInactive,
  onDismiss,
}: {
  /** Anchor position; null when the menu is closed. */
  menu: { x: number; y: number } | null;
  onCloseAll?: () => void;
  onCloseInactive?: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  // 分屏布局存在时多一条出口：右键页签条即可回到单栏（格子标题栏的关闭
  // 按钮也能逐格退出，这里是一次性收掉全部）。
  const split = useSplitStore((s) => s.root !== null);
  const resetLayout = useSplitStore((s) => s.resetLayout);
  if (!menu || (!onCloseAll && !onCloseInactive && !split)) return null;
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      ariaLabel={t("chat.closeAllTabs")}
      entries={[
        ...(split
          ? [
              {
                id: "reset-split",
                label: t("chat.unsplit"),
                icon: <Columns2 className="size-4" aria-hidden />,
                onSelect: resetLayout,
              },
              "separator" as const,
            ]
          : []),
        ...(onCloseInactive
          ? [
              {
                id: "close-inactive",
                label: t("chat.closeInactiveTabs"),
                icon: <CircleX className="size-4" aria-hidden />,
                onSelect: onCloseInactive,
              },
            ]
          : []),
        ...(onCloseInactive && onCloseAll ? ["separator" as const] : []),
        ...(onCloseAll
          ? [
              {
                id: "close-all",
                label: t("chat.closeAllTabs"),
                icon: <X className="size-4" aria-hidden />,
                onSelect: onCloseAll,
              },
            ]
          : []),
      ]}
      onClose={onDismiss}
    />
  );
}
