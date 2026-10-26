import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ipc, type AgyQuotaSnapshot, type AgyVertexCreditsSnapshot } from "@/lib/ipc";
import { AgyQuotaStatus } from "./AgyQuotaStatus";
import {
  applyCreditsSnapshot,
  DEFAULT_CREDITS_SNAPSHOT,
  getAgyVertexCreditsUrl,
  syncAgyVertexCredits,
} from "@/features/settings/agy-vertex-guardrail";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("@/lib/platform", () => ({ openExternal }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOW = 1_900_000_000;
const SYNTHETIC_ACCOUNT = "ABCDEF-123456-789ABC";

const quota = (): AgyQuotaSnapshot => ({
  status: "ready",
  source: "agy_usage",
  collectedAt: NOW,
  groups: [
    {
      id: "gemini",
      windows: { fiveHour: { usedPercentage: 0 }, sevenDay: { usedPercentage: 23.5 } },
    },
    {
      id: "third_party",
      windows: {
        fiveHour: { usedPercentage: 100 },
        sevenDay: { usedPercentage: 40, resetsAt: NOW + 3660 },
      },
    },
  ],
});

describe("AGY remaining usage status", () => {
  let container: HTMLDivElement, root: Root;
  const refresh = vi.fn(async () => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let creditsMock: any;

  beforeEach(async () => {
    // 重置全局 credits 快照为初始未连接状态
    applyCreditsSnapshot(DEFAULT_CREDITS_SNAPSHOT);

    // 默认 mock ipc.agyVertexCreditsRead 返回当前 snapshot
    creditsMock = vi.spyOn(ipc, "agyVertexCreditsRead").mockImplementation(async ({ force } = {}) => {
      if (!force) return DEFAULT_CREDITS_SNAPSHOT;
      return DEFAULT_CREDITS_SNAPSHOT;
    });

    await i18n.changeLanguage("en");
    i18n.addResourceBundle(
      "en",
      "translation",
      {
        chat: {
          agyQuotaPlan: "AGY usage",
          agyQuotaDetails: "AGY usage details",
          agyQuotaViewUsage: "View usage",
          agyQuotaRemainingSummary: "5h {{fiveHour}} · Week {{sevenDay}} remaining",
          agyQuotaRemaining: "{{percentage}} remaining",
          agyQuotaGemini: "Gemini",
          agyQuotaThirdParty: "Third-party",
          agyQuotaSource: "Read-only AGY quota API",
          agyQuotaUnavailable: "AGY usage unavailable",
          agyQuotaCooldown: "Refresh cooldown",
          agyQuotaQueryFailed: "Could not update AGY usage",
          agyQuotaManualWarning: "Reads existing credentials without refreshing or writing them back",
          agyQuotaCredits: "Antigravity credits",
          agyVertexCredits: "Vertex promotional credits",
          agyQuotaPromoTrial: "Free Trial",
          agyQuotaPromoGdp: "GDP monthly",
          agyQuotaPromoGuardrail: "Google Cloud promo credits",
        },
        settings: {
          agyVertexNotConnected: "Not connected",
          agyVertexNotSynced: "Not synced",
          agyVertexStepsGuide: "1. Sign in to Google → 2. Select billing account → 3. Sync credits",
          agyVertexSignInSync: "Sign in with Google to sync credits",
          agyVertexSwitchAccount: "Switch billing account",
          agyVertexSyncing: "Syncing credits…",
          agyVertexGuardrailOpenCredits: "View credits",
          agyVertexErrorCancelled: "Sign-in or account selection cancelled",
          agyVertexErrorPermissionDenied: "No billing or credit permissions for the selected account",
        },
      },
      true,
      true,
    );
    refresh.mockClear();
    openExternal.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    creditsMock.mockRestore();
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(
    snapshot?: AgyQuotaSnapshot,
    model = "gemini-pro",
    loading = false,
    now = NOW,
  ) {
    await act(async () =>
      root.render(
        <AgyQuotaStatus
          snapshot={snapshot}
          model={model}
          loading={loading}
          refresh={refresh}
          now={now}
        />,
      ),
    );
  }

  async function open() {
    await act(async () => container.querySelector("button")!.click());
    return document.querySelector('[role="dialog"]')!;
  }

  it("shows remaining = 100 - used and switches groups for known models", async () => {
    await render(quota());
    expect(container.textContent).toBe("5h 100% · Week 76.5% remaining");
    await render(quota(), "claude-sonnet-4");
    expect(container.textContent).toContain("5h 0% · Week 60% remaining");
    expect(container.querySelector("time")).toBeNull();
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("reset");
    await render(quota(), "gpt-oss-120b");
    expect(container.textContent).toContain("Week 60% remaining");
  });

  it("does not guess an unknown model; details show both independent groups", async () => {
    await render(quota(), "unrecognized");
    expect(container.textContent).toBe("View usage");
    expect(container.querySelector("time")).toBeNull();
    const dialog = await open();
    const groups = dialog.querySelectorAll("section");
    expect(groups[0].textContent).toContain("100% remaining");
    expect(groups[0].textContent).toContain("76.5% remaining");
    expect(groups[1].textContent).toContain("0% remaining");
    expect(groups[1].textContent).toContain("60% remaining");
    const fills = [...dialog.querySelectorAll<HTMLElement>(".bg-chart-track > div")].map(
      (node) => node.style.width,
    );
    // 初始状态下无 Vertex 赠金进度条，只有原生 4 项
    expect(fills).toEqual(["100%", "76.5%", "0%", "60%"]);
    expect(dialog.textContent).toContain(new Date((NOW + 3660) * 1000).toLocaleString("en"));
    expect(dialog.textContent).toContain("in 1h 1m");
    expect(dialog.textContent).toContain(new Date(NOW * 1000).toLocaleString("en"));
    expect(dialog.textContent).toContain("Read-only AGY quota API");
    expect(dialog.textContent).toContain("Reads existing credentials without refreshing or writing them back");
    expect(dialog.textContent).not.toContain("Account");
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => dialog.querySelector("button")!.click());
    expect(refresh).toHaveBeenCalledOnce();
    // Refreshing the native quota must not open the Google sign-in window.
    expect(creditsMock).not.toHaveBeenCalledWith({ force: true });
  });

  it("uses missing dashes, retains old percentages, and labels stale and query errors", async () => {
    await render();
    expect(container.textContent).toBe("5h — · Week — remaining");
    const dialog = await open();
    expect(dialog.textContent).toContain("AGY usage unavailable");
    await render({ ...quota(), status: "stale", errorCode: "query_timeout" });
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("Stale");
    expect(dialog.textContent).toContain(i18n.t("chat.agyQuotaTimeout"));
    await render({ ...quota(), status: "stale", errorCode: "refresh_cooldown" });
    expect(dialog.textContent).toContain("Refresh cooldown");
    for (const [errorCode, key] of [["auth_missing", "AuthMissing"], ["auth_invalid", "AuthInvalid"], ["auth_read_failed", "AuthReadFailed"], ["auth_expired", "AuthExpired"], ["auth_changed", "AuthChanged"], ["unsupported_auth_context", "UnsupportedContext"], ["unsupported_auth_platform", "UnsupportedPlatform"], ["quota_forbidden", "Forbidden"], ["quota_rate_limited", "RateLimited"], ["invalid_response", "InvalidResponse"]]) {
      await render({ status: "unavailable", groups: [], errorCode });
      expect(dialog.textContent).toContain(i18n.t(`chat.agyQuota${key}`));
    }
    await render(quota(), "gemini-pro", false, NOW + 3600);
    expect(container.textContent).toContain("Stale");
    expect(dialog.textContent).toContain(new Date(NOW * 1000).toLocaleString("en"));
    // 初始无余额时不回退到固定维护者个人数据
    expect(dialog.textContent).toContain("Not connected");
  });

  it("supports keyboard dismissal and disables native refresh while loading", async () => {
    await render(quota(), "gemini-pro", true);
    const dialog = await open();
    expect(dialog.querySelector("button")?.disabled).toBe(true);
    await act(async () =>
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
  it("shows unknown Argon quota with its title when its independent group is missing", async () => {
    const data = quota();
    data.groups.push({ id: "gemini_argon", windows: { fiveHour: { usedPercentage: 80 } } });
    await render(data, "gemini-4-argon");
    expect(container.textContent).toBe("5h 20% · Week — remaining");
    const dialog = await open();
    expect(dialog.querySelector('section[aria-label="Gemini 4 Argon"]')?.textContent).toContain("20% remaining");
    await render(quota(), "gemini-4-argon");
    expect(container.textContent).toBe("5h — · Week — remaining");
    expect(dialog.querySelector('section[aria-label="Gemini 4 Argon"]')?.textContent).toContain("— remaining");
    expect(dialog.querySelector('section[aria-label="Gemini 4 Argon"]')?.textContent).not.toContain("100%");
  });
  it("keeps the Argon title and unknown quota when disabled windows have been omitted", async () => {
    const data = quota();
    data.groups.push({ id: "gemini_argon", windows: {} });
    await render(data, "gemini-4-argon-pro");
    expect(container.textContent).toBe("5h — · Week — remaining");
    const dialog = await open();
    const argon = dialog.querySelector('section[aria-label="Gemini 4 Argon"]');
    expect(argon).not.toBeNull();
    expect([...argon!.querySelectorAll("dd")].map(node => node.textContent)).toEqual(["— remaining", "— remaining"]);
  });
  it.each(["en", "zh"])("explains expired login in %s without suggesting another OAuth flow", async language => {
    await i18n.changeLanguage(language);
    await render({ status: "unavailable", groups: [], errorCode: "auth_expired" });
    const dialog = await open();
    expect(dialog.textContent).toContain(language === "zh" ? "请在 AGY 中恢复登录" : "Restore your login in AGY");
  });

  it("shows AI credits only for a valid snapshot", async () => {
    await render({ ...quota(), credits: { remaining: 1250.5 } });
    const dialog = await open();
    expect(dialog.textContent).toContain("Antigravity credits");
    expect(dialog.textContent).toContain("1,250.5");
    await render({ ...quota(), credits: { remaining: 1250.5 } }, "gemini-pro", false, NOW + 3600);
    expect(dialog.textContent).not.toContain("1,250.5");
    expect(container.textContent).toContain("Stale");
    await render({
      status: "unavailable",
      groups: [],
      errorCode: "auth_changed",
      credits: { remaining: 9 },
    });
    expect(
      [...dialog.querySelectorAll("dt")].some((node) => node.textContent === "Antigravity credits"),
    ).toBe(false);
    await render({ ...quota(), credits: { remaining: 0 } });
    expect(dialog.textContent).toMatch(/Antigravity credits\s*0/);
  });

  it.each(["ready", "missing", "unavailable", "expired"] as const)(
    "keeps the separate Vertex credits section with generic link when not connected and native AGY quota is %s",
    async (state) => {
      const snapshot =
        state === "missing"
          ? undefined
          : state === "unavailable"
            ? { status: "unavailable" as const, groups: [], errorCode: "auth_changed" }
            : { ...quota(), credits: { remaining: 0 } };
      await render(snapshot, "gemini-4-argon", false, state === "expired" ? NOW + 3600 : NOW);
      const dialog = await open();
      const vertex = dialog.querySelector('section[aria-label="Vertex promotional credits"]');
      expect(vertex).not.toBeNull();
      // 初始未连接状态：不显示任何硬编码个人账号或余额
      expect(vertex!.textContent).toContain("Not connected");
      expect(vertex!.textContent).toContain("Sign in with Google to sync credits");
      expect(openExternal).not.toHaveBeenCalled();
      const openBtn = vertex!.querySelectorAll("button")[1];
      await act(async () => openBtn.click());
      expect(openExternal).toHaveBeenCalledWith("https://console.cloud.google.com/billing");
    },
  );

  it("syncs Vertex promotional credits via WebView DOM scraper on refresh and displays synthetic account", async () => {
    await render(quota());
    const dialog = await open();

    creditsMock.mockImplementationOnce(async () => ({
      billingAccountId: SYNTHETIC_ACCOUNT,
      freeTrialCredit: "$120.00",
      freeTrialOriginalCredit: "$300.00",
      freeTrialRemainingPercent: 40,
      gdpMonthlyCredit: "$50.00",
      gdpMonthlyRemainingPercent: 100,
      collectedAt: NOW,
    }));

    await act(async () => {
      await syncAgyVertexCredits();
    });
    expect(creditsMock).toHaveBeenCalledWith({ force: true });
    const vertex = dialog.querySelector('section[aria-label="Vertex promotional credits"]');
    expect(vertex!.textContent).toContain(SYNTHETIC_ACCOUNT);
    expect(vertex!.textContent).toContain("$120.00 / $300.00 (40%)");
    expect(vertex!.textContent).toContain("$50.00 (100%)");

    // 点击外链应携带选中结算账号
    const openBtn = vertex!.querySelectorAll("button")[1];
    await act(async () => openBtn.click());
    expect(openExternal).toHaveBeenCalledWith(getAgyVertexCreditsUrl(SYNTHETIC_ACCOUNT));
  });

  it("clears old credits and reports localized failure when sync is cancelled or permission denied", async () => {
    // 1. 先模拟一次成功同步
    const initialSnap: AgyVertexCreditsSnapshot = {
      billingAccountId: SYNTHETIC_ACCOUNT,
      freeTrialCredit: "$100.00",
      freeTrialOriginalCredit: "$200.00",
      freeTrialRemainingPercent: 50,
      gdpMonthlyCredit: "$50.00",
      gdpMonthlyRemainingPercent: 100,
    };
    creditsMock.mockResolvedValue(initialSnap);
    await act(async () => {
      applyCreditsSnapshot(initialSnap);
    });
    await render(quota());
    let dialog = await open();
    let vertex = dialog.querySelector('section[aria-label="Vertex promotional credits"]')!;
    expect(vertex.textContent).toContain("$100.00");

    // 2. 模拟用户取消
    creditsMock.mockResolvedValueOnce({
      billingAccountId: SYNTHETIC_ACCOUNT,
      freeTrialCredit: null,
      freeTrialOriginalCredit: null,
      freeTrialRemainingPercent: null,
      gdpMonthlyCredit: null,
      gdpMonthlyRemainingPercent: null,
      errorCode: "sync_cancelled",
    });

    await act(async () => {
      await syncAgyVertexCredits();
    });

    // 验证旧值被清除，不展示 $100.00，展示取消提示
    expect(vertex.textContent).not.toContain("$100.00");
    expect(vertex.textContent).toContain("Sign-in or account selection cancelled");

    // 3. 模拟无权限
    creditsMock.mockResolvedValueOnce({
      billingAccountId: null,
      freeTrialCredit: null,
      freeTrialOriginalCredit: null,
      freeTrialRemainingPercent: null,
      gdpMonthlyCredit: null,
      gdpMonthlyRemainingPercent: null,
      errorCode: "permission_denied",
    });

    await act(async () => {
      await syncAgyVertexCredits();
    });
    expect(vertex.textContent).not.toContain("$100.00");
    expect(vertex.textContent).toContain("No billing or credit permissions");
  });
});
