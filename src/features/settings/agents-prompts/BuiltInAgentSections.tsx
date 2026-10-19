import { useTranslation } from "react-i18next";
import Bot from "lucide-react/dist/esm/icons/bot";
import Copy from "lucide-react/dist/esm/icons/copy";
import Eye from "lucide-react/dist/esm/icons/eye";
import { Button } from "@/components/base/buttons/button";
import { Switch } from "@/components/base/switch/switch";
import { ModalShell } from "@/components/dialogs";
import type {
  BuiltInAgentDivisionView,
  BuiltInAgentPrompt,
  BuiltInAgentView,
} from "@/lib/ipc";
import { cx } from "@/utils/cx";
import { ROW } from "../CliChannelRow";

/** Same affordance the agent rows use: bare icon, hover-revealed chrome. */
const ICON_BUTTON =
  "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary";

/** Division filter chip (全部 + one per division). */
const chipClass = (active: boolean) =>
  cx(
    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption-1-regular transition-colors",
    active
      ? "border-border-button-active bg-background-tertiary-default text-text-primary"
      : "border-border-button-default text-text-secondary hover:bg-background-secondary-hover",
  );

/** Small division badge: color swatch from the catalog + localized label. */
function DivisionBadge({
  division,
}: {
  division: BuiltInAgentDivisionView | undefined;
}) {
  if (!division) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border-button-default px-1.5 py-0.5 text-caption-1-regular text-text-tertiary">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: division.color }}
      />
      {division.label}
    </span>
  );
}

export interface PromptViewState {
  agent: BuiltInAgentView;
  prompt: BuiltInAgentPrompt | null;
  error: string | null;
}

/** One catalog row: icon, name + division badge, description, prompt
 *  viewer / copy-as-custom affordances, and the enable switch. */
export function BuiltInAgentRow({
  agent,
  division,
  pending,
  copying,
  onViewPrompt,
  onCopy,
  onToggle,
}: {
  agent: BuiltInAgentView;
  division: BuiltInAgentDivisionView | undefined;
  pending: boolean;
  copying: boolean;
  onViewPrompt: (agent: BuiltInAgentView) => void;
  onCopy: (agent: BuiltInAgentView) => void;
  onToggle: (agent: BuiltInAgentView, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
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
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex items-center gap-2 text-body-regular text-text-primary">
          <span className="truncate">{agent.name}</span>
          <DivisionBadge division={division} />
        </p>
        {agent.description && (
          <p
            className="truncate text-body-2-regular text-text-secondary"
            title={agent.description}
          >
            {agent.description}
          </p>
        )}
      </div>
      <button
        type="button"
        aria-label={t("settings.agentBuiltInViewPrompt")}
        title={t("settings.agentBuiltInViewPrompt")}
        onClick={() => onViewPrompt(agent)}
        className={ICON_BUTTON}
      >
        <Eye className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={t("settings.agentBuiltInCopy")}
        title={t("settings.agentBuiltInCopy")}
        disabled={copying}
        onClick={() => onCopy(agent)}
        className={cx(ICON_BUTTON, "disabled:cursor-default disabled:opacity-50")}
      >
        <Copy className="size-4" aria-hidden />
      </button>
      <Switch
        size="sm"
        aria-label={t("settings.agentBuiltInToggle", { name: agent.name })}
        isSelected={agent.enabled}
        isDisabled={pending}
        onChange={(enabled) => onToggle(agent, enabled)}
      />
    </div>
  );
}

/** Division filter chips (全部 + one per division) plus the per-division
 *  bulk enable/disable actions shown while a division is selected. */
export function DivisionFilterChips({
  divisions,
  selectedId,
  enabledCount,
  totalCount,
  divisionPending,
  onSelect,
  onToggleDivision,
}: {
  divisions: BuiltInAgentDivisionView[];
  selectedId: string | null;
  enabledCount: number;
  totalCount: number;
  divisionPending: boolean;
  onSelect: (id: string | null) => void;
  onToggleDivision: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      aria-label={t("settings.agentBuiltInDivisions")}
    >
      <button
        type="button"
        className={chipClass(selectedId === null)}
        onClick={() => onSelect(null)}
      >
        {t("settings.agentBuiltInAll")}
        <span className="text-text-tertiary">
          {enabledCount}/{totalCount}
        </span>
      </button>
      {divisions.map((division) => (
        <button
          key={division.id}
          type="button"
          className={chipClass(selectedId === division.id)}
          onClick={() =>
            onSelect(selectedId === division.id ? null : division.id)
          }
        >
          <span
            aria-hidden
            className="size-1.5 rounded-full"
            style={{ backgroundColor: division.color }}
          />
          {division.label}
          <span className="text-text-tertiary">
            {division.enabledCount}/{division.count}
          </span>
        </button>
      ))}
      {selectedId && (
        <span className="ml-auto flex items-center gap-1">
          <Button
            size="small"
            variant="secondary"
            disabled={divisionPending}
            onClick={() => onToggleDivision(true)}
          >
            {t("settings.agentBuiltInEnableDivision")}
          </Button>
          <Button
            size="small"
            variant="secondary"
            disabled={divisionPending}
            onClick={() => onToggleDivision(false)}
          >
            {t("settings.agentBuiltInDisableDivision")}
          </Button>
        </span>
      )}
    </div>
  );
}

/** Read-only prompt viewer modal with a copy-as-custom action. */
export function PromptPreviewModal({
  state,
  copying,
  onClose,
  onCopy,
}: {
  state: PromptViewState;
  copying: boolean;
  onClose: () => void;
  onCopy: (agent: BuiltInAgentView) => void;
}) {
  const { t } = useTranslation();
  return (
    <ModalShell
      onClose={onClose}
      label={state.agent.name}
      className="flex max-h-[calc(100dvh-64px)] w-[560px] max-w-[calc(100vw-32px)] flex-col"
    >
      <p className="flex items-center gap-2 text-title-3-medium text-text-primary">
        {state.agent.icon && <span aria-hidden>{state.agent.icon}</span>}
        {state.agent.name}
      </p>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-2lg bg-background-tertiary-default p-3">
        {state.error ? (
          <p role="alert" className="text-body-regular text-text-error-primary">
            {state.error}
          </p>
        ) : state.prompt ? (
          <pre className="whitespace-pre-wrap font-mono text-body-2-regular text-text-secondary">
            {state.prompt.prompt}
          </pre>
        ) : (
          <p className="text-body-regular text-text-tertiary">
            {t("settings.agentBuiltInPromptLoading")}
          </p>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button
          size="small"
          leadingIcon={Copy}
          disabled={!state.prompt || copying}
          onClick={() => onCopy(state.agent)}
        >
          {t("settings.agentBuiltInCopy")}
        </Button>
      </div>
    </ModalShell>
  );
}
