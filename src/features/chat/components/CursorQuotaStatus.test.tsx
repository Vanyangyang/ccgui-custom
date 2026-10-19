import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import type { CursorQuotaSnapshot } from "@/lib/ipc";
import { CURSOR_USAGE_URL } from "../cursor-quota";
import { CursorQuotaStatus } from "./CursorQuotaStatus";

const openExternal = vi.fn((_url: string) => {});
vi.mock("@/lib/platform", () => ({ openExternal: (url: string) => openExternal(url) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const snapshot = (): CursorQuotaSnapshot => ({
  status: "ready", collectedAt: 1_900_000_000, planName: "Ultra", resetsAt: 1_900_003_600,
  includedPercent: 91.52, includedUsedCents: 36609, includedLimitCents: 40000,
  autoPercent: 12.15, apiPercent: 1.58, onDemand: { kind: "disabled" },
  includedMessage: "You've used 92% of your included usage",
});

describe("Cursor quota status", () => {
  let container: HTMLDivElement, root: Root;
  const refresh = vi.fn(async () => {});
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    i18n.addResourceBundle("en", "translation", { chat: {
      cursorQuotaPlan: "Cursor usage", cursorQuotaDetails: "Cursor usage details",
      cursorQuotaSummary: "Auto {{auto}} · Other models {{api}}",
      cursorUsageView: "View Cursor usage", cursorQuotaIncluded: "Included", cursorQuotaIncludedHint: "plan",
      cursorQuotaAuto: "Auto", cursorQuotaAutoHint: "first-party", cursorQuotaApi: "API", cursorQuotaApiHint: "other models",
      cursorQuotaOnDemand: "On-Demand", cursorQuotaOnDemandOff: "Off", cursorQuotaScope: "Account period",
      cursorQuotaOpen: "Open", quotaRefresh: "Refresh", quotaRefreshing: "Refreshing",
      quotaIdentityUnknown: "Unknown", quotaResetAt: "Resets {{time}}", quotaStale: "Stale", quotaStaleShort: "stale",
      cursorQuotaAuth: "Sign in", cursorQuotaUnsupported: "Unsupported", cursorQuotaQueryFailed: "Failed",
    } }, true, true);
    openExternal.mockClear();
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it("shows rounded buckets and opens the official page without credentials", async () => {
    await act(async () => root.render(<CursorQuotaStatus snapshot={snapshot()} loading={false} refresh={refresh} now={1_900_000_000} />));
    expect(container.textContent).toBe("Auto 12% · Other models 2%");
    await act(async () => container.querySelector("button")!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Ultra");
    expect(dialog.textContent).not.toContain("Included");
    expect(dialog.textContent).not.toContain("$366.09");
    expect(dialog.textContent).not.toContain("On-Demand");
    expect(dialog.textContent).toContain("Auto");
    expect(dialog.textContent).toContain("other models");
    const open = [...dialog.querySelectorAll("button")].find(button => button.textContent?.includes("Open"))!;
    await act(async () => open.click());
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(CURSOR_USAGE_URL);
    expect([...new URL(CURSOR_USAGE_URL).searchParams.keys()]).toEqual(["tab"]);
  });
});
