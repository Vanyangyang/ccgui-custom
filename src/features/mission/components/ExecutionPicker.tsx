import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import { Button } from "@/components/base/buttons/button";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { cx } from "@/utils/cx";
import { useDismissOnOutsidePress } from "@/utils/use-dismiss-on-outside-press";
import { useChatStore } from "@/features/chat/store";
import { ipc, type EngineCatalog, type EngineInfo, type Workspace } from "@/lib/ipc";
import { resolveMissionExecution, type MissionExecutionInvalidReason } from "../runtime";
import { useMissionStore } from "../store";
import type { MissionFlow, MissionRun, MissionRunExecution } from "../types";
import { engineDisplayName } from "./execution-format";

/**
 * 流程级执行环境（方案之外的用户确认方案 B）：
 *  - 默认跟随当前聊天会话（含模型/渠道/effort 覆盖）；
 *  - 在选择器里改任意一项即固定到本流程，之后「运行流程」直接用固定配置；
 *  - 运行模式显示启动时固定的快照（只读），进行中的运行不受后续修改影响。
 */

/** 运行摘要里的只读环境说明（快照语义）。 */
export function RunEnvironment({ execution }: { execution: MissionRunExecution }) {
  const { t } = useTranslation();
  return (
    <span title={t("mission.executionRunSnapshot")}>
      {t("mission.runExecution", {
        engine: engineDisplayName(execution.engine),
        model: execution.model ?? t("mission.executionModelDefaultShort"),
      })}
    </span>
  );
}

export function ExecutionPicker({
  flow,
  run,
}: {
  flow: MissionFlow;
  /** 运行视图传入当前运行：显示启动时固定的快照，不再可编辑。 */
  run?: MissionRun | null;
}) {
  const { t } = useTranslation();
  const { engines, workspaces, active } = useChatStore(
    useShallow((s) => ({ engines: s.engines, workspaces: s.workspaces, active: s.active })),
  );
  const setFlowExecution = useMissionStore((s) => s.setFlowExecution);
  const resolution = useMemo(
    () => resolveMissionExecution(flow),
    [flow, engines, workspaces, active],
  );
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDialogElement>(null);
  useDismissOnOutsidePress(open, () => setOpen(false), [triggerRef, popoverRef]);

  const effective = resolution.execution;
  const usableEngines = useMemo(
    () => engines.filter((info) => info.available && info.enabled),
    [engines],
  );
  const catalogState = useEngineCatalog(open, effective?.engine, effective?.workspacePath);
  const snapshot = run?.execution ?? null;
  const pinned = flow.execution !== null && flow.execution !== undefined;

  const apply = useCallback(
    (patch: Partial<MissionRunExecution>): void => {
      const base: MissionRunExecution = effective ?? {
        engine: usableEngines[0]?.id ?? "",
        workspacePath: workspaces[0]?.path ?? "",
        model: null,
        providerId: null,
        effort: null,
      };
      setFlowExecution(flow.id, { ...base, ...patch });
    },
    [effective, usableEngines, workspaces, setFlowExecution, flow.id],
  );
  const unpin = useCallback((): void => {
    setFlowExecution(flow.id, null);
    setOpen(false);
  }, [flow.id, setFlowExecution]);

  // 运行快照：只读展示，说明这次跑在什么环境上。
  if (run && snapshot) return <ExecutionSnapshotChip execution={snapshot} />;
  if (resolution.invalidReason) {
    return (
      <ExecutionProblemChip reason={resolution.invalidReason} stored={flow.execution} />
    );
  }
  if (usableEngines.length === 0) return <NoEnginesChip />;

  const chipLabel = executionChipLabel(
    effective,
    catalogState.catalog,
    t("mission.executionModelDefaultShort"),
  );

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("mission.executionTitle")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cx(
          "inline-flex max-w-[300px] cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-caption-1-regular transition-colors",
          pinned
            ? "border-status-blue-text/40 bg-status-blue-background/20 text-text-secondary"
            : "border-separator-border text-text-secondary hover:bg-background-secondary-hover",
        )}
      >
        {effective && <EngineIcon engine={effective.engine} size={13} />}
        <span className="truncate">{chipLabel}</span>
        {!pinned && (
          <span className="shrink-0 text-text-tertiary">
            · {t("mission.executionFollowSession")}
          </span>
        )}
        <ChevronDown className="size-3 shrink-0 text-text-tertiary" aria-hidden />
      </button>

      {open && (
        <ExecutionPopover
          effective={effective}
          pinned={pinned}
          engines={usableEngines}
          workspaces={workspaces}
          catalog={catalogState.catalog}
          loading={catalogState.loading}
          loadFailed={catalogState.loadFailed}
          onApply={apply}
          onUnpin={unpin}
        />
      )}
    </div>
  );
}

/** 打开弹层时拉取所选引擎/工作区的模型目录（失败降级为「默认模型」）。 */
function useEngineCatalog(
  open: boolean,
  engine: string | undefined,
  workspacePath: string | undefined,
): { catalog: EngineCatalog | null; loading: boolean; loadFailed: boolean } {
  const [catalog, setCatalog] = useState<EngineCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!open || !engine || !workspacePath) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void ipc
      .listEngineModels(engine, workspacePath)
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch(() => {
        if (!cancelled) {
          setCatalog(null);
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, engine, workspacePath]);

  return { catalog, loading, loadFailed };
}

function executionChipLabel(
  effective: MissionRunExecution | null,
  catalog: EngineCatalog | null,
  fallback: string,
): string {
  if (!effective) return fallback;
  const model = effective.model
    ? catalog?.models.find((entry) => entry.id === effective.model)?.name ?? effective.model
    : fallback;
  return `${engineDisplayName(effective.engine)} · ${model}`;
}

/** 运行快照 chip：这次运行固定在哪个引擎/模型上。 */
function ExecutionSnapshotChip({ execution }: { execution: MissionRunExecution }) {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-separator-border bg-background-secondary-default px-2 py-1 text-caption-1-regular text-text-secondary"
      title={t("mission.executionRunSnapshot")}
    >
      <EngineIcon engine={execution.engine} size={13} />
      <span className="whitespace-nowrap">
        {engineDisplayName(execution.engine)} ·{" "}
        {execution.model ?? t("mission.executionModelDefaultShort")}
      </span>
    </span>
  );
}

/** 固定配置失效（引擎不可用/工作区丢失）时的说明 chip。 */
function ExecutionProblemChip({
  reason,
  stored,
}: {
  reason: MissionExecutionInvalidReason;
  stored: MissionRunExecution | null | undefined;
}) {
  const { t } = useTranslation();
  return (
    <span className="rounded-md border border-status-rose-text/40 bg-status-rose-background/30 px-2 py-1 text-caption-1-regular text-status-rose-text">
      {reason === "engineUnavailable"
        ? t("mission.issueEngineUnavailable", { engine: stored?.engine ?? "" })
        : t("mission.issueWorkspaceMissing", { path: stored?.workspacePath ?? "" })}
    </span>
  );
}

/** 没有任何可用引擎时的说明 chip。 */
function NoEnginesChip() {
  const { t } = useTranslation();
  return (
    <span className="rounded-md border border-separator-border px-2 py-1 text-caption-1-regular text-text-tertiary">
      {t("mission.executionNoEngines")}
    </span>
  );
}

/** 执行环境弹层：引擎 / 模型 / 工作区三个下拉 + 跟随会话说明。 */
function ExecutionPopover({
  effective,
  pinned,
  engines,
  workspaces,
  catalog,
  loading,
  loadFailed,
  onApply,
  onUnpin,
}: {
  effective: MissionRunExecution | null;
  pinned: boolean;
  engines: EngineInfo[];
  workspaces: Workspace[];
  catalog: EngineCatalog | null;
  loading: boolean;
  loadFailed: boolean;
  onApply: (patch: Partial<MissionRunExecution>) => void;
  onUnpin: () => void;
}) {
  const { t } = useTranslation();
  return (
    <dialog
      open
      aria-label={t("mission.executionTitle")}
      className="absolute right-0 left-auto top-full z-30 m-0 w-80 max-h-none max-w-none translate-y-1.5 rounded-xl border border-border-button-default bg-background-primary-default p-3 shadow-xl"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption-1-medium uppercase tracking-wide text-text-tertiary">
          {t("mission.executionTitle")}
        </span>
        {pinned && (
          <Button size="xs" variant="ghost" onClick={onUnpin}>
            {t("mission.executionUnpin")}
          </Button>
        )}
      </div>
      {!pinned && (
        <p className="mt-1 text-caption-1-regular text-text-tertiary">
          {t("mission.executionFollowSessionOn")}
        </p>
      )}

      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="text-caption-1-medium text-text-secondary">
            {t("mission.executionEngine")}
          </span>
          <select
            className="mt-1 w-full rounded-md border border-border-button-default bg-background-primary-default px-2 py-1.5 text-body-2-regular text-text-primary outline-none focus:border-status-blue-text/60"
            value={effective?.engine ?? engines[0]?.id ?? ""}
            onChange={(event) =>
              onApply({
                engine: event.target.value,
                model: null,
                providerId: null,
                effort: null,
              })
            }
          >
            {engines.map((info) => (
              <option key={info.id} value={info.id}>
                {engineDisplayName(info.id)}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-caption-1-medium text-text-secondary">
            {t("mission.executionModel")}
          </span>
          <select
            className="mt-1 w-full rounded-md border border-border-button-default bg-background-primary-default px-2 py-1.5 text-body-2-regular text-text-primary outline-none focus:border-status-blue-text/60 disabled:opacity-60"
            value={effective?.model ?? ""}
            disabled={loading}
            onChange={(event) => onApply({ model: event.target.value || null })}
          >
            <option value="">{t("mission.executionModelDefault")}</option>
            {(catalog?.models ?? []).map((model) => (
              <option key={model.id} value={model.id}>
                {model.name ?? model.id}
              </option>
            ))}
            {/* 已固定但目录里不存在的模型（例如远端 catalog 变化）仍可选回。 */}
            {effective?.model &&
              !(catalog?.models ?? []).some((model) => model.id === effective.model) && (
                <option value={effective.model}>{effective.model}</option>
              )}
          </select>
        </label>

        <label className="block">
          <span className="text-caption-1-medium text-text-secondary">
            {t("mission.executionWorkspace")}
          </span>
          <select
            className="mt-1 w-full rounded-md border border-border-button-default bg-background-primary-default px-2 py-1.5 text-body-2-regular text-text-primary outline-none focus:border-status-blue-text/60 disabled:opacity-60"
            value={effective?.workspacePath ?? ""}
            disabled={workspaces.length === 0}
            onChange={(event) => onApply({ workspacePath: event.target.value })}
          >
            {workspaces.length === 0 && <option value="">{t("mission.executionNoWorkspace")}</option>}
            {workspaces.map((workspace) => (
              <option key={workspace.path} value={workspace.path}>
                {workspace.name}
              </option>
            ))}
            {effective &&
              !workspaces.some((workspace) => workspace.path === effective.workspacePath) && (
                <option value={effective.workspacePath}>
                  {effective.workspacePath}
                </option>
              )}
          </select>
        </label>
      </div>

      {loadFailed && (
        <p className="mt-2 text-caption-1-regular text-status-yellow-text">
          {t("mission.executionModelLoadFailed")}
        </p>
      )}
      <p className="mt-2 text-caption-1-regular leading-relaxed text-text-tertiary">
        {t("mission.executionHint")}
      </p>
    </dialog>
  );
}
