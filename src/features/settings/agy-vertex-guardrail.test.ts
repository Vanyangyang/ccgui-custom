import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ipc } from "@/lib/ipc";
import {
  agyVertexEndpoint,
  agyVertexSampleCommand,
  agyVertexStreamEndpoint,
  applyConfigSnapshot,
  applyCreditsSnapshot,
  DEFAULT_CONFIG_SNAPSHOT,
  DEFAULT_CREDITS_SNAPSHOT,
  DEFAULT_KEY_FILE_HINT,
  DEFAULT_LOCATION,
  DEFAULT_VERTEX_MODEL,
  fetchAgyVertexConfig,
  getAgyVertexBillingOverviewUrl,
  getAgyVertexCreditsSnapshot,
  getAgyVertexCreditsUrl,
  getAgyVertexProjectUrl,
  syncAgyVertexCredits,
  useAgyVertexCredits,
} from "./agy-vertex-guardrail";

const SYNTHETIC_ACCOUNT = "ABCDEF-123456-789ABC";
const SYNTHETIC_PROJECT = "project-example";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("agy-vertex-guardrail helper", () => {
  beforeEach(() => {
    applyCreditsSnapshot(DEFAULT_CREDITS_SNAPSHOT);
    applyConfigSnapshot(DEFAULT_CONFIG_SNAPSHOT);
    vi.clearAllMocks();
  });

  describe("defaults", () => {
    it("has unconfigured defaults without personal accounts or balances", () => {
      expect(DEFAULT_CONFIG_SNAPSHOT.configured).toBe(false);
      expect(DEFAULT_CONFIG_SNAPSHOT.projectId).toBeNull();
      expect(DEFAULT_CONFIG_SNAPSHOT.model).toBe(DEFAULT_VERTEX_MODEL);
      expect(DEFAULT_CONFIG_SNAPSHOT.keyFileHint).toBe(DEFAULT_KEY_FILE_HINT);

      expect(DEFAULT_CREDITS_SNAPSHOT.billingAccountId).toBeNull();
      expect(DEFAULT_CREDITS_SNAPSHOT.freeTrialCredit).toBeNull();
      expect(DEFAULT_CREDITS_SNAPSHOT.gdpMonthlyCredit).toBeNull();
      expect(DEFAULT_CREDITS_SNAPSHOT.errorCode).toBe("not_connected");
    });
  });

  describe("dynamic links", () => {
    it("returns generic billing URL when billing account is missing", () => {
      expect(getAgyVertexCreditsUrl(null)).toBe("https://console.cloud.google.com/billing");
      expect(getAgyVertexCreditsUrl("")).toBe("https://console.cloud.google.com/billing");
      expect(getAgyVertexBillingOverviewUrl(undefined)).toBe(
        "https://console.cloud.google.com/billing",
      );
    });

    it("returns account-specific billing URL when account is present without fixed authuser=0", () => {
      const url = getAgyVertexCreditsUrl(SYNTHETIC_ACCOUNT);
      expect(url).toBe(
        `https://console.cloud.google.com/billing/${SYNTHETIC_ACCOUNT}/credits/all`,
      );
      expect(url).not.toContain("authuser=0");

      const overview = getAgyVertexBillingOverviewUrl(SYNTHETIC_ACCOUNT);
      expect(overview).toBe(
        `https://console.cloud.google.com/billing/${SYNTHETIC_ACCOUNT}/overview`,
      );
    });

    it("attaches ?project= only when projectId is present", () => {
      expect(getAgyVertexProjectUrl("credentials", null)).toBe(
        "https://console.cloud.google.com/apis/credentials",
      );
      expect(getAgyVertexProjectUrl("credentials", SYNTHETIC_PROJECT)).toBe(
        `https://console.cloud.google.com/apis/credentials?project=${SYNTHETIC_PROJECT}`,
      );
      expect(getAgyVertexProjectUrl("budgets", null)).toBe(
        "https://console.cloud.google.com/billing/budgets",
      );
      expect(getAgyVertexProjectUrl("budgets", SYNTHETIC_PROJECT)).toBe(
        `https://console.cloud.google.com/billing/budgets?project=${SYNTHETIC_PROJECT}`,
      );
    });
  });

  describe("endpoints and sample commands", () => {
    it("returns null for endpoint and sample command when projectId is not configured", () => {
      expect(agyVertexEndpoint(null)).toBeNull();
      expect(agyVertexStreamEndpoint("")).toBeNull();
      expect(agyVertexSampleCommand(null)).toBeNull();
    });

    it("constructs correct endpoints and curl command when projectId is configured", () => {
      const endpoint = agyVertexEndpoint(SYNTHETIC_PROJECT, DEFAULT_LOCATION, DEFAULT_VERTEX_MODEL);
      expect(endpoint).toBe(
        `https://aiplatform.googleapis.com/v1/projects/${SYNTHETIC_PROJECT}/locations/${DEFAULT_LOCATION}/publishers/google/models/${DEFAULT_VERTEX_MODEL}:generateContent`,
      );

      const stream = agyVertexStreamEndpoint(SYNTHETIC_PROJECT, DEFAULT_LOCATION, DEFAULT_VERTEX_MODEL);
      expect(stream).toBe(
        `https://aiplatform.googleapis.com/v1/projects/${SYNTHETIC_PROJECT}/locations/${DEFAULT_LOCATION}/publishers/google/models/${DEFAULT_VERTEX_MODEL}:streamGenerateContent?alt=sse`,
      );

      const sample = agyVertexSampleCommand(
        SYNTHETIC_PROJECT,
        DEFAULT_LOCATION,
        DEFAULT_VERTEX_MODEL,
        DEFAULT_KEY_FILE_HINT,
      );
      expect(sample).toContain(`curl -X POST "${endpoint}"`);
      // The key file also holds project/location/model lines; only api_key= is sent.
      expect(sample).toContain(`$(sed -n 's/^api_key=//p' ~/${DEFAULT_KEY_FILE_HINT})`);
      expect(sample).not.toContain("$(cat ");
      expect(sample).not.toContain("AQ.");
      expect(sample).not.toContain("AIza");
    });
  });

  describe("credits snapshot application and synchronization", () => {
    it("clears old credits when snapshot contains error or missing credits", () => {
      // 初始设置有金额
      applyCreditsSnapshot({
        billingAccountId: SYNTHETIC_ACCOUNT,
        freeTrialCredit: "$100.00",
        freeTrialOriginalCredit: "$200.00",
        freeTrialRemainingPercent: 50,
        gdpMonthlyCredit: "$50.00",
        gdpMonthlyRemainingPercent: 100,
      });

      // 接收取消错误
      applyCreditsSnapshot({
        billingAccountId: SYNTHETIC_ACCOUNT,
        freeTrialCredit: null,
        freeTrialOriginalCredit: null,
        freeTrialRemainingPercent: null,
        gdpMonthlyCredit: null,
        gdpMonthlyRemainingPercent: null,
        errorCode: "sync_cancelled",
      });

      // 验证旧金额被清空
      const snap = getAgyVertexCreditsSnapshot();
      expect(snap.freeTrialCredit).toBeNull();
      expect(snap.gdpMonthlyCredit).toBeNull();
      expect(snap.errorCode).toBe("sync_cancelled");
    });

    it("keeps the backend's string rejection code", async () => {
      const spy = vi.spyOn(ipc, "agyVertexCreditsRead").mockRejectedValueOnce("vertex_sync_in_progress");
      await syncAgyVertexCredits();
      expect(getAgyVertexCreditsSnapshot().errorCode).toBe("vertex_sync_in_progress");
      spy.mockRestore();
    });

    it("does not let a passive cache read that resolves after a sync restore the old account", async () => {
      const oldAccount = {
        billingAccountId: "111111-111111-111111",
        freeTrialCredit: "$9.00",
        freeTrialOriginalCredit: "$10.00",
        freeTrialRemainingPercent: 90,
        gdpMonthlyCredit: null,
        gdpMonthlyRemainingPercent: null,
        collectedAt: 1,
      };
      const newAccount = { ...oldAccount, billingAccountId: SYNTHETIC_ACCOUNT, freeTrialCredit: "$1.00", collectedAt: 2 };
      let resolvePassive!: (value: typeof oldAccount) => void;
      const spy = vi.spyOn(ipc, "agyVertexCreditsRead").mockImplementation(({ force } = {}) =>
        force
          ? Promise.resolve(newAccount)
          : new Promise((resolve) => { resolvePassive = resolve; }),
      );
      const host = document.createElement("div");
      const root = createRoot(host);
      function Probe() {
        useAgyVertexCredits();
        return null;
      }
      await act(async () => root.render(createElement(Probe)));
      await act(async () => { await syncAgyVertexCredits(); });
      expect(getAgyVertexCreditsSnapshot().billingAccountId).toBe(SYNTHETIC_ACCOUNT);
      await act(async () => resolvePassive(oldAccount));
      expect(getAgyVertexCreditsSnapshot().billingAccountId).toBe(SYNTHETIC_ACCOUNT);
      expect(getAgyVertexCreditsSnapshot().freeTrialCredit).toBe("$1.00");
      act(() => root.unmount());
      spy.mockRestore();
    });

    it("deduplicates concurrent sync requests", async () => {
      let resolveFn: (val: unknown) => void;
      const deferred = new Promise((resolve) => {
        resolveFn = resolve;
      });

      const spy = vi.spyOn(ipc, "agyVertexCreditsRead").mockImplementation(async () => {
        return (await deferred) as any;
      });

      const p1 = syncAgyVertexCredits();
      const p2 = syncAgyVertexCredits();
      expect(p1).toBe(p2);
      expect(spy).toHaveBeenCalledTimes(1);

      resolveFn!({
        billingAccountId: SYNTHETIC_ACCOUNT,
        freeTrialCredit: "$100.00",
        freeTrialOriginalCredit: "$200.00",
        freeTrialRemainingPercent: 50,
        gdpMonthlyCredit: "$50.00",
        gdpMonthlyRemainingPercent: 100,
      });
      await p1;
      spy.mockRestore();
    });
  });

  describe("config reading", () => {
    it("loads metadata from ipc.agyVertexConfigRead without fallback to maintainer data", async () => {
      const spy = vi.spyOn(ipc, "agyVertexConfigRead").mockResolvedValueOnce({
        configured: true,
        projectId: SYNTHETIC_PROJECT,
        location: "us-central1",
        model: "gemini-4-argon",
        keyFileHint: ".gemini/custom-key.txt",
      });

      const conf = await fetchAgyVertexConfig();
      expect(conf.configured).toBe(true);
      expect(conf.projectId).toBe(SYNTHETIC_PROJECT);
      expect(conf.location).toBe("us-central1");
      expect(conf.keyFileHint).toBe(".gemini/custom-key.txt");
      spy.mockRestore();
    });

    it("safely handles config read failure without maintainer fallback", async () => {
      const spy = vi.spyOn(ipc, "agyVertexConfigRead").mockRejectedValueOnce(new Error("io error"));
      const conf = await fetchAgyVertexConfig();
      expect(conf.configured).toBe(false);
      expect(conf.projectId).toBeNull();
      expect(conf.errorCode).toBe("config_read_failed");
      spy.mockRestore();
    });
  });
});
