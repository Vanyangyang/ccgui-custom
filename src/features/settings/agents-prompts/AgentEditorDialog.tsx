import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/input/textarea";
import { ModalShell } from "@/components/dialogs";
import { cx } from "@/utils/cx";
import type { AgentConfig } from "@/lib/ipc";

/** Emoji quick-pick row under the icon field — one click fills the input. */
const QUICK_ICONS = ["🤖", "🧠", "🛠️", "🎨", "📝", "🔍", "🧪", "📊", "🚀", "💡", "🐛", "📚"];

const NAME_MAX = 64;
const PROMPT_MAX = 100000;

export interface AgentEditorValue {
  name: string;
  prompt?: string;
  icon?: string;
}

/**
 * Create/edit one agent. The parent owns the store mutation (and its error
 * reporting); this dialog only collects and validates the fields, then calls
 * onSubmit with trimmed values.
 */
export function AgentEditorDialog({
  initial,
  onSubmit,
  onCancel,
}: {
  /** Present in edit mode; absent creates a new agent. */
  initial?: AgentConfig;
  onSubmit: (value: AgentEditorValue) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");

  const trimmedName = name.trim();
  const valid =
    trimmedName.length > 0 && trimmedName.length <= NAME_MAX && prompt.length <= PROMPT_MAX;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit({
      name: trimmedName,
      icon: icon.trim() || undefined,
      prompt: prompt.trim() || undefined,
    });
  };

  return (
    <ModalShell
      onClose={onCancel}
      label={initial ? t("settings.agentDialogEdit") : t("settings.agentDialogNew")}
      className="w-[480px]"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input
          label={t("settings.agentName")}
          placeholder={t("settings.agentNamePlaceholder")}
          value={name}
          onChange={setName}
          maxLength={NAME_MAX}
          size="small"
          autoFocus
        />
        <div className="flex flex-col gap-1.5">
          <Input
            label={t("settings.agentIcon")}
            placeholder={t("settings.agentIconPlaceholder")}
            value={icon}
            onChange={setIcon}
            size="small"
          />
          <div className="flex flex-wrap gap-1 px-1">
            {QUICK_ICONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={emoji}
                onClick={() => setIcon(emoji)}
                className={cx(
                  "flex size-8 cursor-pointer items-center justify-center rounded-lg text-base",
                  "transition-colors hover:bg-background-secondary-hover",
                  "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                  icon === emoji && "bg-background-tertiary-default",
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
        <TextArea
          label={t("settings.agentPromptLabel")}
          placeholder={t("settings.agentPromptPlaceholder")}
          value={prompt}
          onChange={setPrompt}
          maxLength={PROMPT_MAX}
          rows={8}
        />
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="secondary" size="small" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="small" disabled={!valid}>
            {initial ? t("common.confirm") : t("common.create")}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}
