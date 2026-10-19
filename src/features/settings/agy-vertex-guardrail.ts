/** 【Vertex 防护】Antigravity 设置详情使用的本机接入事实。
 *  只放项目、模型和调用地址，不放 API 密钥。密钥留在本机文件里。 */
import { useCallback, useEffect, useState } from "react";
import { listenAgyVertexCreditsChanged } from "@/lib/events";
import { ipc, type AgyVertexCreditsSnapshot } from "@/lib/ipc";

export const AGY_VERTEX_GUARDRAIL = {
  projectId: "project-1141a96f-5ab2-42b3-a5d",
  projectName: "My First Project",
  billingAccountId: "01E559-FC92E9-D4E9E7",
  freeTrialCredit: "$348.01",
  freeTrialOriginalCredit: "$383.45",
  freeTrialRemainingPercent: 91,
  gdpMonthlyCredit: "$51.13",
  gdpMonthlyRemainingPercent: 100,
  location: "global",
  model: "gemini-4-argon",
  monthlyCapUsd: null,
  requestsPerMinute: null,
  /** 相对用户主目录，避免把某台机器的绝对路径写进界面。 */
  keyFileHint: ".gemini/vertex-gemini-4-argon.txt",
} as const;

const DEFAULT_CREDITS_SNAPSHOT: AgyVertexCreditsSnapshot = {
  freeTrialCredit: AGY_VERTEX_GUARDRAIL.freeTrialCredit,
  freeTrialOriginalCredit: AGY_VERTEX_GUARDRAIL.freeTrialOriginalCredit,
  freeTrialRemainingPercent: AGY_VERTEX_GUARDRAIL.freeTrialRemainingPercent,
  gdpMonthlyCredit: AGY_VERTEX_GUARDRAIL.gdpMonthlyCredit,
  gdpMonthlyRemainingPercent: AGY_VERTEX_GUARDRAIL.gdpMonthlyRemainingPercent,
};

let currentCreditsSnapshot: AgyVertexCreditsSnapshot = DEFAULT_CREDITS_SNAPSHOT;
let currentSyncing = false;
let activeSyncPromise: Promise<AgyVertexCreditsSnapshot> | null = null;
const subscribers = new Set<() => void>();

function notifySubscribers() {
  for (const listener of subscribers) listener();
}

function applyCreditsSnapshot(next: AgyVertexCreditsSnapshot | null | undefined) {
  if (!next || typeof next.freeTrialCredit !== "string") return;
  currentCreditsSnapshot = {
    freeTrialCredit: next.freeTrialCredit || DEFAULT_CREDITS_SNAPSHOT.freeTrialCredit,
    freeTrialOriginalCredit:
      next.freeTrialOriginalCredit || DEFAULT_CREDITS_SNAPSHOT.freeTrialOriginalCredit,
    freeTrialRemainingPercent:
      typeof next.freeTrialRemainingPercent === "number" &&
      Number.isFinite(next.freeTrialRemainingPercent)
        ? Math.max(0, Math.min(100, Math.round(next.freeTrialRemainingPercent)))
        : DEFAULT_CREDITS_SNAPSHOT.freeTrialRemainingPercent,
    gdpMonthlyCredit: next.gdpMonthlyCredit || DEFAULT_CREDITS_SNAPSHOT.gdpMonthlyCredit,
    gdpMonthlyRemainingPercent:
      typeof next.gdpMonthlyRemainingPercent === "number" &&
      Number.isFinite(next.gdpMonthlyRemainingPercent)
        ? Math.max(0, Math.min(100, Math.round(next.gdpMonthlyRemainingPercent)))
        : DEFAULT_CREDITS_SNAPSHOT.gdpMonthlyRemainingPercent,
    collectedAt: next.collectedAt,
    errorCode: next.errorCode,
  };
  notifySubscribers();
}

export async function syncAgyVertexCredits(): Promise<AgyVertexCreditsSnapshot> {
  if (typeof ipc?.agyVertexCreditsRead !== "function") {
    return currentCreditsSnapshot;
  }
  if (activeSyncPromise) return activeSyncPromise;
  currentSyncing = true;
  notifySubscribers();
  activeSyncPromise = (async () => {
    try {
      const next = await ipc.agyVertexCreditsRead({ force: true });
      applyCreditsSnapshot(next);
      return currentCreditsSnapshot;
    } catch {
      return currentCreditsSnapshot;
    } finally {
      activeSyncPromise = null;
      currentSyncing = false;
      notifySubscribers();
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

    if (typeof ipc?.agyVertexCreditsRead === "function") {
      void ipc
        .agyVertexCreditsRead({ force: false })
        .then((snap) => {
          if (!disposed) applyCreditsSnapshot(snap);
        })
        .catch(() => {});
    }

    if (typeof listenAgyVertexCreditsChanged === "function") {
      void listenAgyVertexCreditsChanged(() => {
        if (typeof ipc?.agyVertexCreditsRead === "function") {
          void ipc
            .agyVertexCreditsRead({ force: false })
            .then((snap) => {
              if (!disposed) applyCreditsSnapshot(snap);
            })
            .catch(() => {});
        }
      })
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

export function agyVertexEndpoint(): string {
  const guardrail = AGY_VERTEX_GUARDRAIL;
  return `https://aiplatform.googleapis.com/v1/projects/${guardrail.projectId}/locations/${guardrail.location}/publishers/google/models/${guardrail.model}:generateContent`;
}

export function agyVertexStreamEndpoint(): string {
  const guardrail = AGY_VERTEX_GUARDRAIL;
  return `https://aiplatform.googleapis.com/v1/projects/${guardrail.projectId}/locations/${guardrail.location}/publishers/google/models/${guardrail.model}:streamGenerateContent?alt=sse`;
}

export function agyVertexSampleCommand(): string {
  const endpoint = agyVertexEndpoint();
  const keyPath = AGY_VERTEX_GUARDRAIL.keyFileHint;
  return [
    `curl -X POST "${endpoint}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "x-goog-api-key: $(cat ~/${keyPath})" \\`,
    `  -d '{"contents":[{"role":"user","parts":[{"text":"Hello"}]}]}'`,
  ].join("\n");
}

export const AGY_VERTEX_LINKS = {
  credits: `https://console.cloud.google.com/billing/${AGY_VERTEX_GUARDRAIL.billingAccountId}/credits/all?authuser=0&organizationId=0`,
  billingOverview: `https://console.cloud.google.com/billing/${AGY_VERTEX_GUARDRAIL.billingAccountId}/overview?authuser=0&organizationId=0`,
  apiCredentials: `https://console.cloud.google.com/apis/credentials?project=${AGY_VERTEX_GUARDRAIL.projectId}`,
  vertexStudio: `https://console.cloud.google.com/vertex-ai/studio?project=${AGY_VERTEX_GUARDRAIL.projectId}`,
  budgets: `https://console.cloud.google.com/billing/budgets?project=${AGY_VERTEX_GUARDRAIL.projectId}`,
  quotas: `https://console.cloud.google.com/iam-admin/quotas?project=${AGY_VERTEX_GUARDRAIL.projectId}`,
  orgPolicies: `https://console.cloud.google.com/iam-admin/orgpolicies/list?project=${AGY_VERTEX_GUARDRAIL.projectId}`,
} as const;
