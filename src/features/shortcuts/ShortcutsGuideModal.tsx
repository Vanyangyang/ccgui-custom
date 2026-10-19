import { useTranslation } from "react-i18next";
import { ModalShell } from "@/components/dialogs";
import { Button } from "@/components/base/buttons/button";
import { Kbd } from "@/components/base/kbd";
import { useChatStore } from "@/features/chat/store";
import {
  resolveShortcut,
  shortcutActions,
  type ShortcutCategory,
} from "./actions";
import { splitShortcutForPlatform } from "./shortcuts";
import { useShortcutsStore } from "./store";

const CATEGORY_ORDER: ShortcutCategory[] = [
  "sessions",
  "app",
  "panels",
  "editor",
  "view",
];

function GuideRow({ label, value }: { label: string; value: string }) {
  const keys = splitShortcutForPlatform(value);
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-body-regular text-text-primary">{label}</span>
      <span className="flex shrink-0 items-center gap-0.5">
        {keys ? (
          keys.map((part) => <Kbd key={part}>{part}</Kbd>)
        ) : (
          <Kbd>{value}</Kbd>
        )}
      </span>
    </div>
  );
}

/**
 * 快捷键指南弹窗：从 shortcutActions 元数据表 + 当前设置实时生成（未绑定
 * 的动作不展示），末尾附输入框的发送/换行两行（随 composerSendShortcut
 * 动态变化）。入口是命令面板的 builtin:openShortcutsGuide。
 */
export function ShortcutsGuideModal() {
  const { t } = useTranslation();
  const open = useShortcutsStore((s) => s.guideOpen);
  const setGuideOpen = useShortcutsStore((s) => s.setGuideOpen);
  const values = useShortcutsStore((s) => s.values);
  const sendShortcut = useChatStore((s) => s.sendShortcut);

  if (!open) return null;

  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    rows: shortcutActions
      .filter((action) => action.category === category)
      .map((action) => ({
        label: t(action.labelKey),
        value: resolveShortcut(action, values),
      }))
      .filter((row): row is { label: string; value: string } =>
        Boolean(row.value),
      ),
  })).filter((group) => group.rows.length > 0);

  const sendWithCmdEnter = sendShortcut === "cmdEnter";

  return (
    <ModalShell
      onClose={() => setGuideOpen(false)}
      label={t("shortcuts.guide.title")}
      className="flex max-h-[80vh] w-[26rem] flex-col p-0"
    >
      <div className="border-b border-separator-border px-5 pb-3 pt-4">
        <h2 className="text-title-2-medium text-text-primary">
          {t("shortcuts.guide.title")}
        </h2>
        <p className="mt-0.5 text-body-2-regular text-text-secondary">
          {t("shortcuts.guide.description")}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {groups.map((group) => (
          <div key={group.category} className="pb-2">
            <p className="pb-1 pt-2 text-body-2-medium text-text-tertiary">
              {t(`shortcuts.groups.${group.category}`)}
            </p>
            {group.rows.map((row) => (
              <GuideRow key={row.label} label={row.label} value={row.value} />
            ))}
          </div>
        ))}
        <div className="pb-2">
          <p className="pb-1 pt-2 text-body-2-medium text-text-tertiary">
            {t("shortcuts.guide.composerGroup")}
          </p>
          <GuideRow
            label={t("shortcuts.guide.sendMessage")}
            value={sendWithCmdEnter ? "cmd+enter" : "enter"}
          />
          <GuideRow
            label={t("shortcuts.guide.insertNewline")}
            value={sendWithCmdEnter ? "enter" : "shift+enter"}
          />
        </div>
      </div>
      <div className="flex justify-end border-t border-separator-border px-5 py-3">
        <Button
          size="small"
          variant="secondary"
          onClick={() => {
            setGuideOpen(false);
            window.location.hash = "#/settings?page=shortcuts";
          }}
        >
          {t("shortcuts.guide.openSettings")}
        </Button>
      </div>
    </ModalShell>
  );
}
