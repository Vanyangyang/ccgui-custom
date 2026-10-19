import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Bot from "lucide-react/dist/esm/icons/bot";
import Library from "lucide-react/dist/esm/icons/library";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Plus from "lucide-react/dist/esm/icons/plus";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import {
  SettingsCard,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { Button } from "@/components/base/buttons/button";
import { EmptyState } from "@/components/base/empty-state";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { ConfirmDialog } from "@/components/dialogs";
import { useAgentStore } from "@/features/agents/agent-store";
import type { AgentConfig } from "@/lib/ipc";
import { ROW } from "../CliChannelRow";
import { AgentEditorDialog, type AgentEditorValue } from "./AgentEditorDialog";
import { BuiltInAgentsPane } from "./BuiltInAgentsPane";

/** First 80 chars of the agent's prompt, flattened to one line for the row. */
const promptSummary = (prompt?: string): string => {
  const flat = (prompt ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
};

/** Same affordance the message rows use: bare icon, hover-revealed chrome. */
const ICON_BUTTON =
  "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary";

function AgentRow({
  agent,
  onEdit,
  onDelete,
}: {
  agent: AgentConfig;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const summary = promptSummary(agent.prompt);
  return (
    <div className={ROW}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-2lg bg-background-tertiary-default text-foreground-icon-primary">
        {agent.icon ? (
          <span className="text-base leading-none" aria-hidden>
            {agent.icon}
          </span>
        ) : (
          <Bot className="size-4" aria-hidden />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="truncate text-body-regular text-text-primary">{agent.name}</p>
        {summary && (
          <p className="truncate text-body-2-regular text-text-secondary" title={summary}>
            {summary}
          </p>
        )}
      </div>
      <button
        type="button"
        aria-label={t("settings.agentEdit")}
        title={t("settings.agentEdit")}
        onClick={onEdit}
        className={ICON_BUTTON}
      >
        <Pencil className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t("settings.agentDelete")}
        title={t("settings.agentDelete")}
        onClick={onDelete}
        className={ICON_BUTTON}
      >
        <Trash2 className="size-4" aria-hidden />
      </button>
    </div>
  );
}

/**
 * Agent library pane: a pill-tab switcher between the user's custom
 * personas (card rows with edit/delete affordances, a create button, and
 * the editor/confirm dialogs) and the bundled built-in catalog
 * (BuiltInAgentsPane). Data lives in useAgentStore; mutations close their
 * dialog immediately and surface failures via the pane's error line (same
 * optimistic pattern as WorkspacesSection). Copying a built-in agent lands
 * back on the custom tab with a transient success notice.
 */
export function AgentsPane() {
  const { t } = useTranslation();
  const agents = useAgentStore((s) => s.agents);
  const loaded = useAgentStore((s) => s.loaded);

  const [tab, setTab] = useState<"custom" | "builtIn">("custom");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentConfig | "new" | null>(null);
  const [deleting, setDeleting] = useState<AgentConfig | null>(null);

  // The store's first refresh is lazy — kick it off on mount.
  useEffect(() => {
    if (!useAgentStore.getState().loaded) {
      useAgentStore.getState().refresh().catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    }
  }, []);

  // Success notice auto-dismisses (same pattern as ProxySection).
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const reportFailure = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const submitEditor = (value: AgentEditorValue) => {
    const target = editing;
    setEditing(null);
    setError(null);
    if (target === "new") {
      void useAgentStore.getState().create(value).catch(reportFailure);
    } else if (target) {
      void useAgentStore.getState().update(target.id, value).catch(reportFailure);
    }
  };

  const confirmDelete = () => {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    setError(null);
    void useAgentStore.getState().remove(target.id).catch(reportFailure);
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <PillTabList className="self-start">
        <PillTab
          variant="gray"
          icon={Bot}
          isSelected={tab === "custom"}
          onSelect={() => setTab("custom")}
        >
          {t("settings.agentTabCustom")}
        </PillTab>
        <PillTab
          variant="gray"
          icon={Library}
          isSelected={tab === "builtIn"}
          onSelect={() => setTab("builtIn")}
        >
          {t("settings.agentTabBuiltIn")}
        </PillTab>
      </PillTabList>

      {notice && (
        <p role="status" className="text-body-2-regular text-state-success-text">
          {notice}
        </p>
      )}

      {tab === "builtIn" ? (
        <BuiltInAgentsPane
          onCopied={() => {
            setTab("custom");
            setNotice(t("settings.agentBuiltInCopied"));
          }}
        />
      ) : (
        <div className="flex w-full flex-col gap-2">
          {error && (
            <p role="alert" className="text-body-regular text-text-error-primary">
              {t("common.error")}: {error}
            </p>
          )}

          <div className="flex items-center justify-between gap-3">
            <SettingsSectionLabel>
              {t("settings.agentPromptTabAgents")}
              <span className="ml-2 text-body-2-regular font-normal text-text-tertiary">
                {t("settings.agentSectionDesc")}
              </span>
            </SettingsSectionLabel>
            <Button
              size="small"
              leadingIcon={Plus}
              onClick={() => setEditing("new")}
              className="shrink-0"
            >
              {t("settings.agentNew")}
            </Button>
          </div>

          {loaded && agents.length === 0 ? (
            <EmptyState className="flex-col gap-1 rounded-2xl border border-dashed border-border-button-default px-4 py-8">
              <p className="text-body-medium text-text-primary">{t("settings.agentEmptyTitle")}</p>
              <p className="text-body-2-regular text-text-secondary">{t("settings.agentEmptyDesc")}</p>
            </EmptyState>
          ) : (
            <SettingsCard>
              {agents.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  onEdit={() => setEditing(agent)}
                  onDelete={() => setDeleting(agent)}
                />
              ))}
            </SettingsCard>
          )}

          {editing && (
            <AgentEditorDialog
              initial={editing === "new" ? undefined : editing}
              onSubmit={submitEditor}
              onCancel={() => setEditing(null)}
            />
          )}
          {deleting && (
            <ConfirmDialog
              danger
              message={t("settings.agentDeleteConfirm", { name: deleting.name })}
              onConfirm={confirmDelete}
              onCancel={() => setDeleting(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
