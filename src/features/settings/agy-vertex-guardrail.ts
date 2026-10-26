/**
 * 【Vertex 防护与 BYOK 接入】
 * 引导用户连接自己的 Google Cloud 结算账号并读取本机 Vertex 接入元信息。
 * 绝不硬编码任何个人账号、项目或固定余额。
 */
import { useCallback, useEffect, useState } from "react";
import { listenAgyVertexCreditsChanged } from "@/lib/events";
import {
  ipc,
  type AgyVertexConfigSnapshot,
  type AgyVertexCreditsSnapshot,
} from "@/lib/ipc";

export const DEFAULT_VERTEX_MODEL = "gemini-4-argon";
export const DEFAULT_KEY_FILE_HINT = ".gemini/vertex-gemini-4-argon.txt";
export const DEFAULT_LOCATION = "global";

export const DEFAULT_CREDITS_SNAPSHOT: AgyVertexCreditsSnapshot = {
  billingAccountId: null,
  freeTrialCredit: null,
  freeTrialOriginalCredit: null,
  freeTrialRemainingPercent: null,
  gdpMonthlyCredit: null,
  gdpMonthlyRemainingPercent: null,
  collectedAt: undefined,
  errorCode: "not_connected",
};

export const DEFAULT_CONFIG_SNAPSHOT: AgyVertexConfigSnapshot = {
  configured: false,
  projectId: null,
  location: DEFAULT_LOCATION,
  model: DEFAULT_VERTEX_MODEL,
  keyFileHint: DEFAULT_KEY_FILE_HINT,
};

let currentCreditsSnapshot: AgyVertexCreditsSnapshot = DEFAULT_CREDITS_SNAPSHOT;
let currentSyncing = false;
let activeSyncPromise: Promise<AgyVertexCreditsSnapshot> | null = null;
let syncSequence = 0;
const subscribers = new Set<() => void>();

function notifySubscribers() {
  for (const listener of subscribers) listener();
}

export function getAgyVertexCreditsSnapshot(): AgyVertexCreditsSnapshot {
  return currentCreditsSnapshot;
}

/**
 * 校验并更新赠金快照。
 * 取消、无权限或错误时不保留旧余额，清空为 null。
 */
export function applyCreditsSnapshot(next: AgyVertexCreditsSnapshot | null | undefined) {
  if (!next) return;

  const hasError = Boolean(next.errorCode && next.errorCode !== "ok");
  const hasCredits =
    typeof next.freeTrialCredit === "string" || typeof next.gdpMonthlyCredit === "string";

  if (hasError || !hasCredits) {
    currentCreditsSnapshot = {
      billingAccountId: next.billingAccountId ?? null,
      freeTrialCredit: null,
      freeTrialOriginalCredit: null,
      freeTrialRemainingPercent: null,
      gdpMonthlyCredit: null,
      gdpMonthlyRemainingPercent: null,
      collectedAt: next.collectedAt,
      errorCode: next.errorCode || (hasCredits ? undefined : "not_connected"),
    };
  } else {
    currentCreditsSnapshot = {
      billingAccountId: next.billingAccountId ?? null,
      freeTrialCredit: next.freeTrialCredit ?? null,
      freeTrialOriginalCredit: next.freeTrialOriginalCredit ?? null,
      freeTrialRemainingPercent:
        typeof next.freeTrialRemainingPercent === "number" &&
        Number.isFinite(next.freeTrialRemainingPercent)
          ? Math.max(0, Math.min(100, Math.round(next.freeTrialRemainingPercent)))
          : null,
      gdpMonthlyCredit: next.gdpMonthlyCredit ?? null,
      gdpMonthlyRemainingPercent:
        typeof next.gdpMonthlyRemainingPercent === "number" &&
        Number.isFinite(next.gdpMonthlyRemainingPercent)
          ? Math.max(0, Math.min(100, Math.round(next.gdpMonthlyRemainingPercent)))
          : null,
      collectedAt: next.collectedAt,
      errorCode: undefined,
    };
  }
  notifySubscribers();
}

/**
 * 同步 Google Cloud 赠金（打开网页登录 / 选择结算账号，自动抓取 Credits）。
 * 开始前先清除旧余额；请求中防重复；慢旧请求不会覆盖新结果。
 */
export function syncAgyVertexCredits(): Promise<AgyVertexCreditsSnapshot> {
  if (typeof ipc?.agyVertexCreditsRead !== "function") {
    return Promise.resolve(currentCreditsSnapshot);
  }
  if (activeSyncPromise) return activeSyncPromise;

  currentSyncing = true;
  const seq = ++syncSequence;

  // 开始时清除旧余额
  currentCreditsSnapshot = {
    ...DEFAULT_CREDITS_SNAPSHOT,
    billingAccountId: currentCreditsSnapshot.billingAccountId,
    errorCode: undefined,
  };
  notifySubscribers();

  activeSyncPromise = (async () => {
    try {
      const next = await ipc.agyVertexCreditsRead({ force: true });
      if (seq === syncSequence) {
        applyCreditsSnapshot(next);
      }
      return currentCreditsSnapshot;
    } catch (err) {
      if (seq === syncSequence) {
        // Tauri rejects with the backend's string code, e.g. vertex_sync_in_progress.
        const code = typeof err === "string" ? err : err instanceof Error ? err.message : "";
        currentCreditsSnapshot = {
          ...DEFAULT_CREDITS_SNAPSHOT,
          billingAccountId: null,
          errorCode: code.trim() || "sync_failed",
        };
        notifySubscribers();
      }
      return currentCreditsSnapshot;
    } finally {
      if (seq === syncSequence) {
        activeSyncPromise = null;
        currentSyncing = false;
        notifySubscribers();
      }
    }
  })();
  return activeSyncPromise;
}

export function useAgyVertexCredits() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const onUpdate = () => setTick((n) => n + 1);
    subscribers.add(onUpdate);

    let disposed = false;
    let unlisten: (() => void) | undefined;

    // A passive read started before (or during) a sync may resolve after it and
    // carry the previous account's balance; the sync's own result wins.
    const readCached = () => {
      if (typeof ipc?.agyVertexCreditsRead !== "function") return;
      const seq = syncSequence;
      void ipc
        .agyVertexCreditsRead({ force: false })
        .then((snap) => {
          if (!disposed && snap && seq === syncSequence && !currentSyncing) {
            applyCreditsSnapshot(snap);
          }
        })
        .catch(() => {});
    };

    readCached();

    if (typeof listenAgyVertexCreditsChanged === "function") {
      void listenAgyVertexCreditsChanged(readCached)
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(() => {});
    }

    return () => {
      disposed = true;
      subscribers.delete(onUpdate);
      unlisten?.();
    };
  }, []);

  const sync = useCallback(() => syncAgyVertexCredits(), []);

  return {
    credits: currentCreditsSnapshot,
    syncing: currentSyncing,
    sync,
  };
}

/* ───────────────────── 本机 Vertex 配置元信息 ───────────────────── */

let currentConfigSnapshot: AgyVertexConfigSnapshot = DEFAULT_CONFIG_SNAPSHOT;
let configLoaded = false;
let activeConfigPromise: Promise<AgyVertexConfigSnapshot> | null = null;
const configSubscribers = new Set<() => void>();

function notifyConfigSubscribers() {
  for (const listener of configSubscribers) listener();
}

export function applyConfigSnapshot(conf: AgyVertexConfigSnapshot | null | undefined) {
  if (!conf || typeof conf !== "object") {
    currentConfigSnapshot = DEFAULT_CONFIG_SNAPSHOT;
  } else {
    currentConfigSnapshot = {
      configured: Boolean(conf.configured),
      projectId: conf.projectId ? String(conf.projectId).trim() : null,
      location: conf.location?.trim() || DEFAULT_LOCATION,
      model: conf.model?.trim() || DEFAULT_VERTEX_MODEL,
      keyFileHint: conf.keyFileHint?.trim() || DEFAULT_KEY_FILE_HINT,
      errorCode: conf.errorCode,
    };
  }
  configLoaded = true;
  notifyConfigSubscribers();
}

export function fetchAgyVertexConfig(): Promise<AgyVertexConfigSnapshot> {
  if (typeof ipc?.agyVertexConfigRead !== "function") {
    return Promise.resolve(currentConfigSnapshot);
  }
  if (activeConfigPromise) return activeConfigPromise;

  activeConfigPromise = (async () => {
    try {
      const conf = await ipc.agyVertexConfigRead();
      applyConfigSnapshot(conf);
    } catch {
      currentConfigSnapshot = {
        ...DEFAULT_CONFIG_SNAPSHOT,
        errorCode: "config_read_failed",
      };
      configLoaded = true;
      notifyConfigSubscribers();
    } finally {
      activeConfigPromise = null;
    }
    return currentConfigSnapshot;
  })();
  return activeConfigPromise;
}

export function useAgyVertexConfig() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const onUpdate = () => setTick((n) => n + 1);
    configSubscribers.add(onUpdate);

    if (!configLoaded && !activeConfigPromise) {
      void fetchAgyVertexConfig();
    }

    return () => {
      configSubscribers.delete(onUpdate);
    };
  }, []);

  const reload = useCallback(() => fetchAgyVertexConfig(), []);

  return {
    config: currentConfigSnapshot,
    reload,
  };
}

/* ───────────────────── 动态链接与 Endpoint ───────────────────── */

const GOOGLE_BILLING_BASE = "https://console.cloud.google.com/billing";

/**
 * 结算账号赠金明细外链。
 * 若 billingAccountId 存在，跳转到该账号赠金明细；未连接时使用通用控制台链接。
 * 绝不硬编码 authuser=0 或固定账号。
 */
export function getAgyVertexCreditsUrl(billingAccountId?: string | null): string {
  const account = billingAccountId?.trim();
  if (account) {
    return `${GOOGLE_BILLING_BASE}/${encodeURIComponent(account)}/credits/all`;
  }
  return GOOGLE_BILLING_BASE;
}

/**
 * 结算总览外链。
 */
export function getAgyVertexBillingOverviewUrl(billingAccountId?: string | null): string {
  const account = billingAccountId?.trim();
  if (account) {
    return `${GOOGLE_BILLING_BASE}/${encodeURIComponent(account)}/overview`;
  }
  return GOOGLE_BILLING_BASE;
}

export type VertexProjectLinkType =
  | "freeTrial"
  | "vertexApi"
  | "credentials"
  | "studio"
  | "budgets"
  | "quotas"
  | "policies";

/**
 * 项目控制台外链。只有真实 projectId 存在时才拼接 ?project= 参数。
 */
export function getAgyVertexProjectUrl(
  type: VertexProjectLinkType,
  projectId?: string | null,
): string {
  const pid = projectId?.trim();
  const query = pid ? `?project=${encodeURIComponent(pid)}` : "";

  switch (type) {
    case "freeTrial":
      return "https://console.cloud.google.com/freetrial";
    case "vertexApi":
      return `https://console.cloud.google.com/apis/library/aiplatform.googleapis.com${query}`;
    case "credentials":
      return `https://console.cloud.google.com/apis/credentials${query}`;
    case "studio":
      return pid
        ? `https://console.cloud.google.com/vertex-ai/studio${query}`
        : "https://console.cloud.google.com/vertex-ai";
    case "budgets":
      return `https://console.cloud.google.com/billing/budgets${query}`;
    case "quotas":
      return `https://console.cloud.google.com/iam-admin/quotas${query}`;
    case "policies":
      return `https://console.cloud.google.com/iam-admin/orgpolicies/list${query}`;
  }
}

/**
 * 单次调用地址。未配置 projectId 时返回 null。
 */
export function agyVertexEndpoint(
  projectId?: string | null,
  location?: string | null,
  model?: string | null,
): string | null {
  const pid = projectId?.trim();
  if (!pid) return null;
  const loc = location?.trim() || DEFAULT_LOCATION;
  const m = model?.trim() || DEFAULT_VERTEX_MODEL;
  return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(pid)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(m)}:generateContent`;
}

/**
 * 流式调用地址。未配置 projectId 时返回 null。
 */
export function agyVertexStreamEndpoint(
  projectId?: string | null,
  location?: string | null,
  model?: string | null,
): string | null {
  const pid = projectId?.trim();
  if (!pid) return null;
  const loc = location?.trim() || DEFAULT_LOCATION;
  const m = model?.trim() || DEFAULT_VERTEX_MODEL;
  return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(pid)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse`;
}

/**
 * 示例 curl 测试命令。未配置 projectId 时返回 null。
 */
export function agyVertexSampleCommand(
  projectId?: string | null,
  location?: string | null,
  model?: string | null,
  keyFileHint?: string | null,
): string | null {
  const endpoint = agyVertexEndpoint(projectId, location, model);
  if (!endpoint) return null;
  const keyPath = keyFileHint?.trim() || DEFAULT_KEY_FILE_HINT;
  return [
    `curl -X POST "${endpoint}" \\`,
    `  -H "Content-Type: application/json" \\`,
    // The key file holds project=/location=/model=/api_key= lines; send only the key.
    `  -H "x-goog-api-key: $(sed -n 's/^api_key=//p' ~/${keyPath})" \\`,
    `  -d '{"contents":[{"role":"user","parts":[{"text":"Hello"}]}]}'`,
  ].join("\n");
}
