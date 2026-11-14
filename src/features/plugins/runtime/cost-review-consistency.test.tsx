import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostTaskCostApproval } from "@ccgui/plugin-sdk";
import i18n from "@/lib/i18n";
import { ipc, type SessionMeta } from "@/lib/ipc";
import { CrossSessionCostApproval } from "@/features/chat/components/CrossSessionCostApproval";
import { useCrossSessionActivityStore, type CrossSessionCommunicationRecord } from "@/features/chat/cross-session";
import { sessionKey, useChatStore } from "@/features/chat/store";
import { EMPTY_SESSION } from "@/features/chat/store/stream";
import { projectTaskCostApprovals } from "./task-cost-review";
import { costReviewDialogTelemetry } from "./cost-review-dialog";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/transport", () => ({ invoke: native.invoke, isWeb: false, listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/ipc", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...original, ipc: { ...original.ipc, loadSessionPage: vi.fn() } };
});

const now = Date.parse("2026-10-28T12:00:00Z");
const sender = { engine: "codex", sessionId: "consistency-parent", workspacePath: "G:/cost-consistency" };
const fullMessage = "中文😀".repeat(450) + "\n尾部决定完整消息的估算👩🏽‍💻";
let node: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  await i18n.changeLanguage("zh");
  useCrossSessionActivityStore.getState().reset();
  useChatStore.setState({ sessions: [], bySession: {}, openTabs: [], archivedSessionKeys: {}, models: {} });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  useCrossSessionActivityStore.getState().reset();
  useChatStore.setState({ sessions: [], bySession: {}, openTabs: [], archivedSessionKeys: {}, models: {} });
  vi.useRealTimers();
});

function fixture(engine = "agy", model = "gemini-4-argon", cacheReadTokens = 10_000) {
  const target = { engine, sessionId: "consistency-child", workspacePath: sender.workspacePath };
  const key = sessionKey(engine, target.sessionId, target.workspacePath);
  const usage = engine === "agy"
    ? { context_usage_kind: "last_prompt", context_usage: { input_tokens: 353_093 } }
    : { input_tokens: 353_093 };
  const held: CrossSessionCommunicationRecord = {
    scopedId: "leader:consistency-branch", requestId: "consistency-request", sender, target,
    kind: "subtask", message: fullMessage, status: "awaiting_cost_approval", acceptedAt: now - 3_600_000, updatedAt: now - 3_600_000,
    leaderCostApproval: { branchId: "consistency-branch", requestId: "native-consistency-request", model },
    costReview: {
      capturedAt: now - 3_600_000, model: "stale-captured-model", cacheHeat: "hot", targetStatus: "idle",
      cache: { startedAt: now - 3_600_000, observedAt: now - 3_590_000, ttlSeconds: 900, source: "agy-vertex-reference",
        reference: { promptTokens: 353_093, cacheReadTokens, maxTtlSeconds: 1200 } },
      context: { kind: "unknown", capacityKnown: false, reference: false, modelMismatch: false },
    },
  };
  useCrossSessionActivityStore.getState().upsertRecord(held);
  useChatStore.setState({
    sessions: [{ ...target, model: "different-tab-model", filePath: "/synthetic-no-read.jsonl", promptCache: null } as SessionMeta],
    openTabs: [{ ...target, model: "different-tab-model" }],
    bySession: { [key]: { ...EMPTY_SESSION, activeModel: "different-tab-model", usage,
      messages: [{ seq: 1, role: "assistant", text: "synthetic", ts: null, model, usage }] } },
  });
  return held;
}

async function displayedApproval(held: CrossSessionCommunicationRecord) {
  await act(async () => root.render(<CrossSessionCostApproval record={held} />));
  const projected = projectTaskCostApprovals([sender]);
  expect(projected.items).toHaveLength(1);
  const approval = projected.items[0];
  const lines = approval.requestEstimate?.displayLines;
  expect(lines?.length).toBeGreaterThan(0);
  expect([...node.querySelectorAll('[data-testid="pending-request-cost"] > p')].map(p => p.textContent)).toEqual(lines!.slice(0, 3));
  expect([...node.querySelectorAll('[data-testid="pending-request-cost"] p')].map(p => p.textContent)).toEqual(lines);
  expect(node.querySelector('[data-testid="pending-request-cost"] details summary')?.textContent).toBe(i18n.t("crossSession.pendingEstimateDetails"));
  const confirmation = costReviewDialogTelemetry(approval, i18n.getFixedT("zh"));
  for (const line of lines!) expect(confirmation.split("\n")).toContain(line);
  expect(node.textContent).toContain(held.leaderCostApproval!.model);
  expect(node.textContent).not.toContain("different-tab-model");
  expect(node.textContent).not.toContain("stale-captured-model");
  expect(approval.model).toBe(held.leaderCostApproval!.model);
  expect(approval.truncated).toBe(true);
  expect(Array.from(approval.message)).toHaveLength(1200);
  expect(approval.requestEstimate?.textCharacters).toBe(Array.from(fullMessage).length);
  expect(approval.requestEstimate?.textUtf8Bytes).toBe(new TextEncoder().encode(fullMessage).length);
  expect(approval.requestEstimate?.textUtf8Bytes).toBeGreaterThan(new TextEncoder().encode(approval.message).length);
  expect(ipc.loadSessionPage).not.toHaveBeenCalled();
  expect(native.invoke).not.toHaveBeenCalled();
  expect(useCrossSessionActivityStore.getState().records[0].status).toBe("awaiting_cost_approval");
  return { approval, confirmation };
}

function expectHistoricalPrice(approval: HostTaskCostApproval) {
  const bytes = new TextEncoder().encode(fullMessage).length;
  expect(approval.usageKind).toBe("last_request");
  expect(approval.used).toBe(353_093);
  expect(approval.requestEstimate?.contextBasis).toBe("last_request");
  expect(approval.requestEstimate?.inputTokens).toEqual({ lower: 353_093 + Math.ceil(bytes / 4), upper: 353_093 + bytes });
  expect(approval.requestEstimate?.inputUsd?.lower).toBeCloseTo((353_093 * 0.1 + Math.ceil(bytes / 4) * 2) / 1_000_000, 10);
  expect(approval.requestEstimate?.inputUsd?.upper).toBeCloseTo((353_093 + bytes) * 2 / 1_000_000, 10);
}

describe("native card, plugin projection and system confirmation cost consistency", () => {
  it("shows the same known original image count in the native card, plugin projection and confirmation", async () => {
    const held = { ...fixture(), imageRefs: [`task-image:${"a".repeat(64)}`, `task-image:${"b".repeat(64)}`] };
    useCrossSessionActivityStore.getState().upsertRecord(held);
    const { approval, confirmation } = await displayedApproval(held);
    expect(approval.requestEstimate?.imageCount).toBe(2);
    expect(approval.imageRefs).toEqual(held.imageRefs);
    expect(node.textContent).toContain(i18n.t("crossSession.pendingImages", { count: 2 }));
    expect(confirmation).toContain(i18n.t("crossSession.pendingImages", { count: 2 }));
  });
  it("uses the full Unicode message and historical AGY usage while rechecking captured-hot cache expiry", async () => {
    const held = fixture();
    const { approval, confirmation } = await displayedApproval(held);
    expectHistoricalPrice(approval);
    expect(held.costReview?.cacheHeat).toBe("hot");
    expect(approval.cacheHeat).toBe("cold");
    const cold = i18n.t("crossSession.costCacheCold");
    expect(node.textContent).toContain(cold);
    expect(confirmation).toContain(cold);
    expect(node.textContent).not.toContain(i18n.t("crossSession.costCacheHot"));
    expect(confirmation).not.toContain(i18n.t("crossSession.costCacheHot"));
  });

  it("keeps zero historical cache reads unknown across all views without zeroing the request price", async () => {
    const { approval, confirmation } = await displayedApproval(fixture("agy", "gemini-4-argon", 0));
    expectHistoricalPrice(approval);
    expect(approval.cacheReference?.cacheReadTokens).toBe(0);
    expect(approval.cacheHeat).toBe("unknown");
    expect(node.textContent).toContain(i18n.t("crossSession.costCacheUnknown"));
    expect(confirmation).toContain(i18n.t("crossSession.costCacheUnknown"));
    expect(confirmation).toContain(i18n.t("crossSession.costDialogCacheReference", { prompt: (353_093).toLocaleString(), read: "0" }));
    expect(approval.requestEstimate?.inputUsd?.lower).toBeGreaterThan(0);
  });

  it("keeps GPT persistent-cache policy separate from unverified price and never displays a false zero quote", async () => {
    const { approval, confirmation } = await displayedApproval(fixture("codex", "gpt-6-astra"));
    expect(approval.cacheExpiryDisabled).toBe(true);
    expect(approval.requestEstimate?.unavailableReason).toBe("model_price_unverified");
    expect(approval.requestEstimate?.pricing).toBeUndefined();
    expect(approval.requestEstimate?.inputUsd).toBeUndefined();
    const missingPrice = i18n.t("crossSession.pendingPriceMissing");
    expect(node.textContent).toContain(missingPrice);
    expect(confirmation).toContain(missingPrice);
    expect(confirmation).toContain(i18n.t("crossSession.costCacheExpiryDisabled"));
    expect(node.textContent).not.toContain("$0");
    expect(confirmation).not.toContain("$0");
    for (const key of ["costCacheCold", "costCacheHot", "costCacheUnknown"]) {
      expect(node.textContent).not.toContain(i18n.t(`crossSession.${key}`));
      expect(confirmation).not.toContain(i18n.t(`crossSession.${key}`));
    }
  });
});
