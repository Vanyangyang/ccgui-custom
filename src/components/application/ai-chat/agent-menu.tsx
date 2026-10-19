"use client";

import { memo, useEffect, useMemo, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import Bot from "lucide-react/dist/esm/icons/bot";
import Plus from "lucide-react/dist/esm/icons/plus";
import {
  ComposerPickerMenu,
  PickerOption,
  type ComposerPickerMenuHandle,
} from "@/components/application/ai-chat/composer-picker-menu";
import {
  matchAgents,
  matchBuiltInAgents,
  useAgentStore,
} from "@/features/agents/agent-store";
import { type AgentConfig, type BuiltInAgentView } from "@/lib/ipc";

/**
 * `#` picker, rendered above the composer while a `#` trigger is active.
 * Rows are the user's agent personas plus the enabled built-in catalog
 * agents — grouped ("我的智能体", then one section per division) while the
 * query is empty, flat when filtering. A fixed "new agent" footer row
 * jumps to the settings page. Thin shell over ComposerPickerMenu — the
 * contentEditable keeps focus and owns the keyboard; keys arrive through
 * menuRef.
 */

/** Imperative key handling for the composer's keydown handler. */
export type AgentMenuHandle = ComposerPickerMenuHandle;

/** Sentinel id of the fixed footer row that opens the settings page. */
export const CREATE_NEW_AGENT_ID = "__create_new__";

/** A menu row: a custom persona, or a built-in catalog entry (no prompt —
 * resolved at send time — but a description summary and division badge). */
interface AgentMenuEntry extends AgentConfig {
  divisionLabel?: string;
  description?: string;
}

/** Section header between groups; keyboard navigation skips it (headers
 *  are not options — row indices stay contiguous). Same chrome as the `/`
 *  picker's kind headers. */
const GROUP_HEADER =
  "px-2 pb-1 pt-1.5 text-caption-1-medium text-text-tertiary select-none";

const Row = memo(function Row({
  entry,
  index,
  active,
  onSelect,
  onHover,
}: {
  entry: AgentMenuEntry;
  index: number;
  active: boolean;
  onSelect: (entry: AgentMenuEntry) => void;
  onHover: (index: number) => void;
}) {
  if (entry.id === CREATE_NEW_AGENT_ID) {
    return (
      <PickerOption active={active} onSelect={() => onSelect(entry)} onHover={() => onHover(index)}>
        <Plus aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
        <span className="shrink-0 text-body-regular text-text-primary">{entry.name}</span>
      </PickerOption>
    );
  }
  const builtIn = entry.source === "builtIn";
  const summary = (builtIn ? entry.description : entry.prompt)
    ?.replace(/\s+/g, " ")
    .trim();
  return (
    <PickerOption active={active} onSelect={() => onSelect(entry)} onHover={() => onHover(index)}>
      {entry.icon ? (
        <span aria-hidden className="w-4 shrink-0 text-center text-body-regular">
          {entry.icon}
        </span>
      ) : (
        <Bot aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
      )}
      <span className="shrink-0 text-body-regular text-text-primary">{entry.name}</span>
      {summary && (
        <span className="truncate text-body-regular text-text-tertiary" title={summary}>
          {summary}
        </span>
      )}
      {builtIn && entry.divisionLabel && (
        <span className="ml-auto shrink-0 text-caption-1-regular text-text-tertiary">
          {entry.divisionLabel}
        </span>
      )}
    </PickerOption>
  );
});

export function AgentMenu({
  query,
  /** Horizontal offset (px) of the `#` caret inside the composer wrapper. */
  left,
  onSelect,
  onClose,
  menuRef,
}: {
  query: string;
  left: number;
  onSelect: (entry: AgentConfig) => void;
  onClose: () => void;
  menuRef?: MutableRefObject<AgentMenuHandle | null>;
}) {
  const { t } = useTranslation();
  const agents = useAgentStore((s) => s.agents);
  const builtInAgents = useAgentStore((s) => s.builtInAgents);
  const builtInDivisions = useAgentStore((s) => s.builtInDivisions);
  const loaded = useAgentStore((s) => s.loaded);
  useEffect(() => {
    void useAgentStore.getState().refresh();
  }, []);

  // Items plus a parallel group-label array: with a query both sources
  // flatten into one list; without one, custom personas come first under
  // "我的智能体", then each division with enabled entries in catalog order.
  const { items, groups } = useMemo(() => {
    const filtering = query.trim().length > 0;
    const divisionLabelById = new Map(
      builtInDivisions.map((division) => [division.id, division.label]),
    );
    const toBuiltInEntry = (agent: BuiltInAgentView): AgentMenuEntry => ({
      id: agent.id,
      name: agent.name,
      icon: agent.icon ?? undefined,
      source: "builtIn",
      divisionLabel: divisionLabelById.get(agent.divisionId),
      description: agent.description,
    });

    const items: AgentMenuEntry[] = [];
    const groups: (string | null)[] = [];
    const push = (entry: AgentMenuEntry, group: string | null) => {
      items.push(entry);
      groups.push(group);
    };

    const customMatched = matchAgents(agents, query);
    const builtInMatched = matchBuiltInAgents(builtInAgents, query);
    if (filtering) {
      for (const agent of customMatched) push(agent, null);
      for (const agent of builtInMatched) push(toBuiltInEntry(agent), null);
    } else {
      const customGroup = t("chat.agentGroupCustom");
      for (const agent of customMatched) push(agent, customGroup);
      const byDivision = new Map<string, BuiltInAgentView[]>();
      for (const agent of builtInMatched) {
        const list = byDivision.get(agent.divisionId);
        if (list) list.push(agent);
        else byDivision.set(agent.divisionId, [agent]);
      }
      for (const division of builtInDivisions) {
        const list = byDivision.get(division.id);
        if (!list?.length) continue;
        for (const agent of list) push(toBuiltInEntry(agent), division.label);
      }
    }
    push({ id: CREATE_NEW_AGENT_ID, name: t("chat.agentCreate") }, null);
    return { items, groups };
  }, [agents, builtInAgents, builtInDivisions, query, t]);

  const hasMatches = items.length > 1;

  return (
    <ComposerPickerMenu
      left={left}
      width="w-[420px]"
      ariaLabel={t("chat.agents")}
      scope={query}
      loading={!loaded && !hasMatches}
      loadingText={t("chat.agentsLoading")}
      emptyText={t("chat.agentsEmpty")}
      items={items}
      rowKey={(entry) => entry.id}
      onSelect={onSelect}
      onClose={onClose}
      menuRef={menuRef}
      groupHeaderAt={(_entry, i) => {
        // No agent rows (the create row sits alone): paint the empty hint
        // as a non-selectable header above it.
        if (!hasMatches) {
          return i === 0 ? (
            <div className={GROUP_HEADER}>{t("chat.agentsEmpty")}</div>
          ) : null;
        }
        const group = groups[i];
        return group && (i === 0 || groups[i - 1] !== group) ? (
          <div className={GROUP_HEADER}>{group}</div>
        ) : null;
      }}
      renderRow={(entry, i, active, { onHover }) => (
        <Row
          entry={entry}
          index={i}
          active={active}
          onSelect={onSelect}
          onHover={onHover}
        />
      )}
    />
  );
}
