/**
 * Antigravity (agy)「BYOK 挂载识别与额度概览」区块 — 模仿 pi/omp 供应商认证与自定义模型挂载体验：
 *
 * 1. 赠金余额与账户额度 (agyByokBalance)：
 *    - 引导用户登录自己的 Google 账号并选择结算账号；未连接或无真实数据时不展示固定余额。
 *    - 展示 Antigravity 原生 `/credits` 与 `/usage` 实时额度摘要，支持遵循 UI 规范的转圈→对号刷新反馈。
 * 2. BYOK 挂载识别与模型接入 (agyByokMount)：
 *    - 自动识别本机 Vertex AI 接入配置与本机密钥文件状态（仅展示路径提示与状态点，绝不读取或回显真实密钥）。
 *    - 支持一键将 Vertex / BYOK 模型挂载到 AGY 聊天模型选择器，并可在「沿用 API 命名」与「自定义显示名称」之间切换。
 *    - 仅在真实 metadata 存在且输入的 model 匹配时才允许自动同步生成供应商渠道。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Boxes from "lucide-react/dist/esm/icons/boxes";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import KeyRound from "lucide-react/dist/esm/icons/key-round";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import {
  ActionFeedbackIcon,
  useActionFeedback,
} from "@/components/base/action-feedback";
import {
  SettingsCard,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import {
  ipc,
  type AgyQuotaSnapshot,
  type AppSettings,
  type OfficialConfigFile,
} from "@/lib/ipc";
import { openExternal } from "@/lib/platform";
import { cx } from "@/utils/cx";
import {
  agyVertexEndpoint,
  DEFAULT_VERTEX_MODEL,
  getAgyVertexBillingOverviewUrl,
  getAgyVertexCreditsUrl,
  useAgyVertexConfig,
  useAgyVertexCredits,
} from "./agy-vertex-guardrail";
import { Badge } from "./CliChannelRow";
import { BrandIcon, ROW, StatusDot, TEXT_BTN } from "./PiFamilyAuthShared";
import { CLI_CONFIG_CHANGED_EVENT, notifyCliConfigChanged } from "./providers";
import type { CliConfigState } from "./useCliConfig";

const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary disabled:opacity-40";

const VERTEX_CHANNEL_ID = "agy-vertex-byok";
const DEFAULT_VERTEX_ALIAS = "Gemini 4 Argon (Vertex)";

type NamingMode = "keep_api" | "custom_alias";

export function AgyByokSection({ cli }: { cli: CliConfigState }) {
  const { t } = useTranslation();
  const mounted = useRef(true);
  const quotaTimers = useRef(new Set<number>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      quotaTimers.current.forEach(timer => window.clearTimeout(timer));
      quotaTimers.current.clear();
    };
  }, []);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [officialFiles, setOfficialFiles] = useState<OfficialConfigFile[]>([]);
  const [quota, setQuota] = useState<AgyQuotaSnapshot | null>(null);
  const {
    credits: vertexCredits,
    sync: syncVertexCredits,
    syncing: vertexSyncing,
  } = useAgyVertexCredits();
  const { config: vertexConfig } = useAgyVertexConfig();
  const [loadError, setLoadError] = useState<string | null>(null);

  // Inline mount / naming editor state
  const [editorOpen, setEditorOpen] = useState(false);
  const [namingMode, setNamingMode] = useState<NamingMode>("custom_alias");
  const [draftModelId, setDraftModelId] = useState<string>(
    vertexConfig.model || DEFAULT_VERTEX_MODEL,
  );
  const [draftAlias, setDraftAlias] = useState<string>(DEFAULT_VERTEX_ALIAS);
  const [syncChannel, setSyncChannel] = useState<boolean>(true);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // 当配置加载更新且当前未编辑时，同步 draftModelId
  useEffect(() => {
    if (!editorOpen) {
      setDraftModelId(vertexConfig.model || DEFAULT_VERTEX_MODEL);
    }
  }, [editorOpen, vertexConfig.model]);

  const loadState = useCallback(
    async (forceQuota = false) => {
      let quotaTimer: number | undefined;
      try {
        const [appSettings, files, quotaSnap] = await Promise.all([
          ipc.getAppSettings(),
          ipc.officialConfigRead("agy").catch(() => [] as OfficialConfigFile[]),
          Promise.race([
            ipc.agyQuotaRead({ force: forceQuota, cacheOnly: !forceQuota }).catch(() => null),
            new Promise<null>(resolve => {
              quotaTimer = window.setTimeout(() => resolve(null), 40_000);
              quotaTimers.current.add(quotaTimer);
            }),
          ]),
        ]);
        if (!mounted.current) return false;
        setSettings(appSettings);
        setOfficialFiles(files);
        setQuota(quotaSnap?.status === "ready" ? quotaSnap : null);
        const failed = forceQuota && quotaSnap?.status !== "ready";
        const errorKey = quotaSnap?.errorCode === "slash_unexpanded" ? "chat.agyQuotaSlashUnexpanded"
          : quotaSnap?.errorCode === "cli_version_unavailable" ? "chat.agyQuotaVersionUnavailable"
          : quotaSnap?.errorCode === "probe_history_full" ? "chat.agyQuotaHistoryFull"
          : quotaSnap?.errorCode === "probe_history_unavailable" ? "chat.agyQuotaHistoryUnavailable"
          : "settings.agyByokRefreshFailed";
        setLoadError(failed ? t(errorKey) : null);
        return !failed;
      } catch (e) {
        if (mounted.current) setLoadError(String(e));
        return false;
      } finally {
        window.clearTimeout(quotaTimer);
        if (quotaTimer !== undefined) quotaTimers.current.delete(quotaTimer);
      }
    },
    [t],
  );

  useEffect(() => {
    void loadState(false);
    const onConfigChanged = () => {
      void loadState(false);
    };
    window.addEventListener(CLI_CONFIG_CHANGED_EVENT, onConfigChanged);
    return () => window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, onConfigChanged);
  }, [loadState]);

  const refreshFeedback = useActionFeedback({ spin: true });
  const nativeQuotaFeedback = useActionFeedback({ spin: true });

  const customModels = useMemo(
    () => settings?.customModels?.agy ?? [],
    [settings],
  );
  const customLabels = useMemo(
    () => settings?.customModelLabels?.agy ?? {},
    [settings],
  );

  const activeModel = vertexConfig.model || DEFAULT_VERTEX_MODEL;
  const isVertexMounted = customModels.includes(activeModel);
  const vertexMountedAlias = customLabels[activeModel]?.trim() ?? "";
  const hasVertexChannel = useMemo(
    () => cli.entries.some((e) => e.id === VERTEX_CHANNEL_ID || e.model === activeModel),
    [cli.entries, activeModel],
  );

  const openEditorForModel = useCallback(
    (modelId: string) => {
      const existingAlias = customLabels[modelId]?.trim() ?? "";
      setDraftModelId(modelId);
      if (existingAlias && existingAlias !== modelId) {
        setNamingMode("custom_alias");
        setDraftAlias(existingAlias);
      } else if (modelId === activeModel && !customModels.includes(modelId)) {
        setNamingMode("custom_alias");
        setDraftAlias(DEFAULT_VERTEX_ALIAS);
      } else {
        setNamingMode("keep_api");
        setDraftAlias(modelId === activeModel ? DEFAULT_VERTEX_ALIAS : "");
      }
      setActionError(null);
      setEditorOpen(true);
    },
    [activeModel, customLabels, customModels],
  );

  const toggleEditor = useCallback(() => {
    if (editorOpen) {
      setEditorOpen(false);
      setActionError(null);
      return;
    }
    openEditorForModel(activeModel);
  }, [activeModel, editorOpen, openEditorForModel]);

  const saveMount = useCallback(
    async (opts?: {
      modelId?: string;
      mode?: NamingMode;
      alias?: string;
      createChannel?: boolean;
    }) => {
      const targetId = (opts?.modelId ?? draftModelId).trim();
      if (!targetId) {
        setActionError(t("settings.agyByokErrorModelEmpty"));
        return;
      }
      const mode = opts?.mode ?? namingMode;
      const rawAlias = (opts?.alias ?? draftAlias).trim();
      const effectiveAlias = mode === "custom_alias" && rawAlias ? rawAlias : "";
      const canSyncChannel = Boolean(vertexConfig.configured && vertexConfig.projectId);
      const shouldSyncChannel =
        opts?.createChannel != null ? opts.createChannel : (syncChannel && canSyncChannel);

      // 需求：未配置 API 时同步 Vertex 渠道不可用并说明先配置自己的项目与 API 密钥。
      // 自动建渠道必须使用真实本机 metadata 并校验输入 model 匹配该配置，不能为任意新别名建错误目标。
      if (opts?.createChannel && !canSyncChannel) {
        setActionError(t("settings.agyByokErrorNoConfig"));
        return;
      }
      if (shouldSyncChannel) {
        if (!vertexConfig.configured || !vertexConfig.projectId) {
          setActionError(t("settings.agyByokErrorNoConfig"));
          return;
        }
        if (targetId !== vertexConfig.model) {
          setActionError(t("settings.agyByokErrorModelMismatch"));
          return;
        }
      }

      setSaving(true);
      setActionError(null);
      try {
        const latest = await ipc.getAppSettings();
        const prevModels = latest.customModels?.agy ?? [];
        const nextModels = prevModels.includes(targetId)
          ? prevModels
          : [...prevModels, targetId];

        const prevLabels = { ...(latest.customModelLabels?.agy ?? {}) };
        if (effectiveAlias && effectiveAlias !== targetId) {
          prevLabels[targetId] = effectiveAlias;
        } else {
          delete prevLabels[targetId];
        }

        const nextSettings: AppSettings = {
          ...latest,
          customModels: {
            ...(latest.customModels ?? {}),
            agy: nextModels,
          },
          customModelLabels: {
            ...(latest.customModelLabels ?? {}),
            agy: prevLabels,
          },
        };
        await ipc.updateAppSettings(nextSettings);

        if (shouldSyncChannel && vertexConfig.projectId) {
          const endpoint = agyVertexEndpoint(
            vertexConfig.projectId,
            vertexConfig.location,
            targetId,
          );
          const channelName =
            effectiveAlias || `${vertexConfig.projectId} (${targetId})`;
          await cli.mutate(() =>
            ipc.upsertProvider("agy", VERTEX_CHANNEL_ID, {
              name: channelName,
              remark: `${vertexConfig.projectId} · ~/${vertexConfig.keyFileHint}`,
              baseUrl: endpoint || "",
              apiKey: "",
              model: targetId,
            }),
          );
        }

        if (!mounted.current) return;
        setSettings(nextSettings);
        setEditorOpen(false);
        notifyCliConfigChanged();
      } catch (e) {
        if (mounted.current) setActionError(String(e));
      } finally {
        if (mounted.current) setSaving(false);
      }
    },
    [cli, draftAlias, draftModelId, namingMode, syncChannel, t, vertexConfig],
  );

  const handleUnmount = useCallback(
    async (modelId: string) => {
      setSaving(true);
      setActionError(null);
      try {
        const latest = await ipc.getAppSettings();
        const prevModels = latest.customModels?.agy ?? [];
        const nextModels = prevModels.filter((m) => m !== modelId);
        const prevLabels = { ...(latest.customModelLabels?.agy ?? {}) };
        delete prevLabels[modelId];

        const nextSettings: AppSettings = {
          ...latest,
          customModels: {
            ...(latest.customModels ?? {}),
            agy: nextModels,
          },
          customModelLabels: {
            ...(latest.customModelLabels ?? {}),
            agy: prevLabels,
          },
        };
        await ipc.updateAppSettings(nextSettings);
        if (!mounted.current) return;
        setSettings(nextSettings);
        notifyCliConfigChanged();
      } catch (e) {
        if (mounted.current) setActionError(String(e));
      } finally {
        if (mounted.current) setSaving(false);
      }
    },
    [],
  );

  const officialPath =
    officialFiles[0]?.path || "~/.gemini/antigravity-cli/settings.json";
  const geminiWindow = quota?.groups?.find((g) => g.id === "gemini")?.windows;
  const geminiFiveHourRemaining =
    geminiWindow?.fiveHour != null
      ? Math.max(0, Math.min(100, Math.round(100 - geminiWindow.fiveHour.usedPercentage)))
      : null;

  const creditsUrl = getAgyVertexCreditsUrl(vertexCredits.billingAccountId);
  const billingOverviewUrl = getAgyVertexBillingOverviewUrl(vertexCredits.billingAccountId);

  const hasCreditsData =
    vertexCredits.freeTrialCredit != null || vertexCredits.gdpMonthlyCredit != null;

  return (
    <div className="flex w-full flex-col gap-6" data-testid="agy-byok-section">
      {/* ── 1. 赠金余额与账户额度 ── */}
      <div className="flex w-full flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SettingsSectionLabel anchor="agyByokBalance">
            {t("settings.agyByokBalanceTitle")}
            <span className="ml-2 text-body-2-regular font-normal text-text-tertiary">
              {vertexCredits.billingAccountId
                ? t("settings.agyByokBalanceHint", {
                    account: vertexCredits.billingAccountId,
                  })
                : t("settings.agyByokNotConnected")}
            </span>
          </SettingsSectionLabel>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label={t("settings.agyByokRefresh")}
              title={t("settings.agyByokRefresh")}
              disabled={refreshFeedback.feedback === "running" || vertexSyncing}
              onClick={() => {
                let failed = false;
                void refreshFeedback.start(
                  async () => {
                    void syncVertexCredits();
                    failed = !(await loadState(false));
                  },
                  () => failed,
                );
              }}
              className="flex items-center gap-1.5 rounded-lg border border-border-button-default px-2.5 py-1 text-body-2-medium text-text-primary hover:bg-background-secondary-hover disabled:opacity-50"
            >
              <ActionFeedbackIcon
                icon={RefreshCw}
                feedback={refreshFeedback.feedback}
                spin
                iconClassName="size-3.5"
              />
              {vertexSyncing ? t("settings.agyVertexSyncing") : t("settings.agyByokRefresh")}
            </button>
            <button
              type="button"
              onClick={() => void openExternal(creditsUrl)}
              className="flex items-center gap-1 rounded-lg border border-border-button-default px-2.5 py-1 text-body-2-medium text-text-primary hover:bg-background-secondary-hover"
            >
              <ExternalLink className="size-3.5 text-foreground-icon-secondary" aria-hidden />
              {t("settings.agyVertexGuardrailOpenCredits")}
            </button>
            <button
              type="button"
              onClick={() => void openExternal(billingOverviewUrl)}
              className="flex items-center gap-1 rounded-lg border border-border-button-default px-2.5 py-1 text-body-2-medium text-text-primary hover:bg-background-secondary-hover"
            >
              <ExternalLink className="size-3.5 text-foreground-icon-secondary" aria-hidden />
              {t("settings.agyVertexGuardrailOpenBilling")}
            </button>
          </div>
        </div>

        <SettingsCard>
          {/* Google Cloud Promotional Credits row */}
          <div className={ROW}>
            <BrandIcon iconSrc={null} />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="truncate text-body-regular text-text-primary">
                  {t("settings.agyByokPromoTitle")}
                </p>
                <Badge>{t("settings.agyByokBillingCurrency")}</Badge>
              </div>
              <code className="w-fit truncate rounded border border-dashed border-border-button-default px-1 py-px text-[11px] text-text-tertiary">
                {vertexConfig.projectId || t("settings.agyVertexNoProject")}
              </code>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {hasCreditsData ? (
                <>
                  {vertexCredits.freeTrialCredit && (
                    <span className="rounded bg-background-tertiary px-2 py-0.5 font-mono text-body-2-medium text-notification-success-foreground">
                      {t("settings.agyByokFreeTrialBadge", {
                        amount: `${vertexCredits.freeTrialCredit}${
                          vertexCredits.freeTrialOriginalCredit
                            ? ` / ${vertexCredits.freeTrialOriginalCredit}`
                            : ""
                        }${
                          vertexCredits.freeTrialRemainingPercent != null
                            ? ` (${vertexCredits.freeTrialRemainingPercent}%)`
                            : ""
                        }`,
                      })}
                    </span>
                  )}
                  {vertexCredits.gdpMonthlyCredit && (
                    <span className="rounded bg-background-tertiary px-2 py-0.5 font-mono text-body-2-medium text-text-primary">
                      {t("settings.agyByokGdpBadge", {
                        amount: `${vertexCredits.gdpMonthlyCredit}${
                          vertexCredits.gdpMonthlyRemainingPercent != null
                            ? ` (${vertexCredits.gdpMonthlyRemainingPercent}%)`
                            : ""
                        }`,
                      })}
                    </span>
                  )}
                </>
              ) : (
                <span className="rounded bg-background-tertiary px-2 py-0.5 text-body-2-regular text-text-tertiary">
                  {vertexCredits.errorCode && vertexCredits.errorCode !== "not_connected"
                    ? vertexCredits.errorCode === "sync_cancelled"
                      ? t("settings.agyVertexErrorCancelled")
                      : vertexCredits.errorCode === "permission_denied"
                        ? t("settings.agyVertexErrorPermissionDenied")
                        : vertexCredits.errorCode
                    : t("settings.agyVertexNotSynced")}
                </span>
              )}
            </div>
          </div>

          {/* Antigravity Native AI Credits & Quota row */}
          <div className={ROW}>
            <BrandIcon iconSrc={null} />
            <div className="flex min-w-0 flex-1 flex-col">
              <p className="truncate text-body-regular text-text-primary">
                {t("settings.agyByokNativeQuotaTitle")}
              </p>
              <code className="w-fit truncate rounded border border-dashed border-border-button-default px-1 py-px text-[11px] text-text-tertiary">
                /credits · /usage
              </code>
              <p className="text-caption-1-regular text-text-tertiary">{t("chat.agyQuotaManualWarning")}</p>
            </div>
            <span className="flex items-center gap-1.5 text-body-2-regular text-text-secondary">
              <StatusDot on={quota?.status === "ready"} />
              {quota?.credits != null
                ? t("settings.agyByokNativeCreditsValue", {
                    count: quota.credits.remaining,
                  })
                : t("settings.agyByokNativeCreditsFallback")}
            </span>
            {geminiFiveHourRemaining != null && (
              <code className="shrink-0 rounded bg-background-tertiary px-1.5 py-0.5 text-[11px] text-text-secondary">
                {t("settings.agyByokGeminiRemaining", {
                  pct: geminiFiveHourRemaining,
                })}
              </code>
            )}
            <button
              type="button"
              aria-label={t("chat.agyQuotaManualRefresh")}
              disabled={nativeQuotaFeedback.feedback === "running"}
              onClick={() => {
                let failed = false;
                void nativeQuotaFeedback.start(async () => { failed = !(await loadState(true)); }, () => failed);
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border-button-default px-2.5 py-1 text-body-2-medium text-text-primary hover:bg-background-secondary-hover disabled:opacity-50"
            >
              <ActionFeedbackIcon icon={RefreshCw} feedback={nativeQuotaFeedback.feedback} spin iconClassName="size-3.5" />
              {t("chat.agyQuotaManualRefresh")}
            </button>
          </div>
        </SettingsCard>
        <p className="px-1 text-caption-1-regular text-text-tertiary">
          {t("settings.agyVertexStepsGuide")} · {t("settings.agyVertexBillingSourceNote")}
        </p>
      </div>

      {/* ── 2. BYOK 挂载识别与模型接入 ── */}
      <div className="flex w-full flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SettingsSectionLabel anchor="agyByokMount">
            {t("settings.agyByokMountTitle")}
            <span className="ml-2 text-body-2-regular font-normal text-text-tertiary">
              {t("settings.agyByokMountHint", {
                path: `~/${vertexConfig.keyFileHint}`,
              })}
            </span>
          </SettingsSectionLabel>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={toggleEditor}
              className="shrink-0 rounded-lg border border-border-button-default px-2.5 py-1 text-body-2-medium text-text-primary hover:bg-background-secondary-hover"
            >
              {editorOpen
                ? t("settings.piAuthCollapse")
                : t("settings.agyByokMountConfigure")}
            </button>
          </div>
        </div>

        <SettingsCard>
          {loadError ? (
            <div
              className={cx(ROW, "text-body-regular text-text-error-primary")}
              role="alert"
            >
              {loadError}
            </div>
          ) : null}

          {/* Detected local Vertex BYOK mount row */}
          <div>
            <div className={cx(ROW, editorOpen && "border-b-0")}>
              <BrandIcon iconSrc={null} />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="truncate text-body-regular text-text-primary">
                    {t("settings.agyByokVertexRowTitle", {
                      project: vertexConfig.projectId || t("settings.agyVertexNoProject"),
                      model: vertexMountedAlias || activeModel,
                    })}
                  </p>
                  {isVertexMounted && (
                    <Badge>
                      {vertexMountedAlias
                        ? t("settings.agyByokCustomNameBadge")
                        : t("settings.agyByokKeepApiNameBadge")}
                    </Badge>
                  )}
                  {hasVertexChannel && (
                    <Badge>{t("settings.agyByokChannelSyncedBadge")}</Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <code className="w-fit truncate rounded border border-dashed border-border-button-default px-1 py-px text-[11px] text-text-tertiary">
                    {activeModel}
                  </code>
                  <code className="w-fit truncate rounded border border-dashed border-border-button-default px-1 py-px text-[11px] text-text-tertiary">
                    ~/{vertexConfig.keyFileHint}
                  </code>
                </div>
              </div>

              <span className="flex shrink-0 items-center gap-1.5 text-body-2-regular text-text-secondary">
                <StatusDot on={isVertexMounted} />
                {isVertexMounted
                  ? t("settings.agyByokMounted")
                  : t("settings.agyByokDetectedReady")}
              </span>

              {vertexConfig.configured ? (
                <span
                  className="flex size-5 shrink-0 items-center justify-center text-notification-success-foreground"
                  role="img"
                  aria-label={t("settings.agyByokKeyDetected")}
                  title={t("settings.agyByokKeyDetected")}
                >
                  <KeyRound className="size-3.5" aria-hidden />
                </span>
              ) : null}

              {!isVertexMounted ? (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    void saveMount({
                      modelId: activeModel,
                      mode: "custom_alias",
                      alias: DEFAULT_VERTEX_ALIAS,
                      createChannel: Boolean(vertexConfig.configured && vertexConfig.projectId),
                    })
                  }
                  className="shrink-0 rounded-lg bg-accent-500 px-2.5 py-1 text-body-2-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {t("settings.agyByokQuickMount")}
                </button>
              ) : null}

              <button
                type="button"
                className={TEXT_BTN}
                onClick={() => openEditorForModel(activeModel)}
              >
                {editorOpen && draftModelId === activeModel
                  ? t("settings.piAuthCollapse")
                  : t("settings.agyByokConfigureNaming")}
              </button>

              {isVertexMounted ? (
                <button
                  type="button"
                  disabled={saving}
                  className={cx(TEXT_BTN, "hover:text-text-error-primary")}
                  onClick={() => void handleUnmount(activeModel)}
                >
                  {t("settings.agyByokUnmount")}
                </button>
              ) : null}
            </div>

            {/* Inline Mount & Naming Editor */}
            {editorOpen ? (
              <div className="border-b border-separator-border px-2 py-3 last:border-b-0">
                <p className="mb-2 text-body-2-medium text-text-secondary">
                  {t("settings.agyByokEditorTitle")}
                </p>

                {/* Naming Mode Selector */}
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="text-body-2-regular text-text-secondary">
                    {t("settings.agyByokNamingModeLabel")}
                  </span>
                  <button
                    type="button"
                    aria-pressed={namingMode === "keep_api"}
                    onClick={() => setNamingMode("keep_api")}
                    className={cx(
                      "rounded-lg border px-2.5 py-1 text-body-2-medium transition-colors duration-150",
                      namingMode === "keep_api"
                        ? "border-accent-500 bg-accent-500/10 text-text-primary"
                        : "border-border-button-default text-text-secondary hover:bg-background-secondary-hover",
                    )}
                  >
                    {t("settings.agyByokNamingKeepApi")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={namingMode === "custom_alias"}
                    onClick={() => {
                      setNamingMode("custom_alias");
                      if (!draftAlias.trim() && draftModelId === activeModel) {
                        setDraftAlias(DEFAULT_VERTEX_ALIAS);
                      }
                    }}
                    className={cx(
                      "rounded-lg border px-2.5 py-1 text-body-2-medium transition-colors duration-150",
                      namingMode === "custom_alias"
                        ? "border-accent-500 bg-accent-500/10 text-text-primary"
                        : "border-border-button-default text-text-secondary hover:bg-background-secondary-hover",
                    )}
                  >
                    {t("settings.agyByokNamingCustom")}
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="agy-byok-model-id"
                      className="mb-1 block text-body-2-medium text-text-secondary"
                    >
                      {t("settings.agyByokModelIdLabel")}
                    </label>
                    <input
                      id="agy-byok-model-id"
                      type="text"
                      value={draftModelId}
                      onChange={(e) => setDraftModelId(e.target.value)}
                      placeholder={activeModel}
                      className="h-9 w-full rounded-lg bg-background-tertiary px-2.5 font-mono text-body-2-regular text-text-primary outline-none placeholder:text-text-tertiary"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="agy-byok-display-name"
                      className="mb-1 block text-body-2-medium text-text-secondary"
                    >
                      {t("settings.agyByokDisplayNameLabel")}
                    </label>
                    <input
                      id="agy-byok-display-name"
                      type="text"
                      value={namingMode === "custom_alias" ? draftAlias : ""}
                      disabled={namingMode === "keep_api"}
                      onChange={(e) => {
                        setNamingMode("custom_alias");
                        setDraftAlias(e.target.value);
                      }}
                      placeholder={
                        namingMode === "keep_api"
                          ? t("settings.agyByokDisplayNameKeepPlaceholder", {
                              model: draftModelId.trim() || activeModel,
                            })
                          : t("settings.agyByokDisplayNamePlaceholder")
                      }
                      className="h-9 w-full rounded-lg bg-background-tertiary px-2.5 text-body-2-regular text-text-primary outline-none placeholder:text-text-tertiary disabled:opacity-50"
                    />
                  </div>
                </div>

                <label
                  className={cx(
                    "mt-2.5 flex items-center gap-2 text-body-2-regular text-text-secondary",
                    !vertexConfig.configured || !vertexConfig.projectId
                      ? "cursor-not-allowed opacity-50"
                      : "cursor-pointer",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={syncChannel && Boolean(vertexConfig.configured && vertexConfig.projectId)}
                    disabled={!vertexConfig.configured || !vertexConfig.projectId}
                    onChange={(e) => setSyncChannel(e.target.checked)}
                    className="size-3.5 rounded border-border-button-default"
                  />
                  <span>{t("settings.agyByokSyncChannelLabel")}</span>
                </label>
                {!vertexConfig.configured || !vertexConfig.projectId ? (
                  <p className="mt-1 text-caption-1-regular text-text-tertiary">
                    {t("settings.agyByokSyncChannelDisabledHint")}
                  </p>
                ) : null}

                <p className="mt-1.5 text-body-2-regular text-text-tertiary">
                  {t("settings.agyByokEditorHint", {
                    model: draftModelId.trim() || activeModel,
                  })}
                </p>

                {actionError ? (
                  <p
                    className="mt-1.5 text-body-2-regular text-text-error-primary"
                    role="alert"
                  >
                    {actionError}
                  </p>
                ) : null}

                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveMount()}
                    className="rounded-lg bg-accent-500 px-3 py-1 text-body-2-medium text-white disabled:opacity-50"
                  >
                    {saving
                      ? t("settings.piAuthSaving")
                      : t("settings.agyByokSaveMount")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditorOpen(false)}
                    className="rounded-lg border border-border-button-default px-3 py-1 text-body-2-medium text-text-primary"
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Other mounted custom models in customModels.agy */}
          {customModels
            .filter((m) => m !== activeModel)
            .map((modelId) => {
              const alias = customLabels[modelId]?.trim() ?? "";
              return (
                <div key={modelId} className={ROW}>
                  <BrandIcon iconSrc={null} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate text-body-regular text-text-primary">
                        {alias || modelId}
                      </p>
                      <Badge>
                        {alias
                          ? t("settings.agyByokCustomNameBadge")
                          : t("settings.agyByokKeepApiNameBadge")}
                      </Badge>
                    </div>
                    <code className="w-fit truncate rounded border border-dashed border-border-button-default px-1 py-px text-[11px] text-text-tertiary">
                      {modelId}
                    </code>
                  </div>
                  <span className="flex shrink-0 items-center gap-1 text-body-2-regular text-text-tertiary">
                    1
                    <Boxes className="size-3.5" aria-hidden />
                  </span>
                  <span aria-hidden className="h-4 w-px shrink-0 bg-separator-border" />
                  <button
                    type="button"
                    aria-label={t("settings.cliEdit")}
                    title={t("settings.cliEdit")}
                    disabled={saving}
                    onClick={() => openEditorForModel(modelId)}
                    className={ICON_BUTTON}
                  >
                    <Pencil className="size-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    aria-label={t("settings.cliDelete")}
                    title={t("settings.cliDelete")}
                    disabled={saving}
                    onClick={() => void handleUnmount(modelId)}
                    className={cx(ICON_BUTTON, "hover:text-text-error-primary")}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </div>
              );
            })}

          <div className="flex flex-wrap items-center gap-2 py-2 pr-2.5 text-[11px] text-text-tertiary">
            <code className="min-w-0 truncate">{officialPath}</code>
            <span className="shrink-0">·</span>
            <code className="min-w-0 truncate">~/{vertexConfig.keyFileHint}</code>
            <span className="shrink-0">·</span>
            <span className="min-w-0 truncate">{t("settings.agyByokFooterHint")}</span>
          </div>
        </SettingsCard>
      </div>
    </div>
  );
}
