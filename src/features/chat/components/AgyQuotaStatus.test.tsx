import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ipc, type AgyQuotaSnapshot } from "@/lib/ipc";
import { AgyQuotaStatus } from "./AgyQuotaStatus";
import { AGY_VERTEX_LINKS } from "@/features/settings/agy-vertex-guardrail";
const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("@/lib/platform", () => ({ openExternal }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const NOW = 1_900_000_000;
const quota = (): AgyQuotaSnapshot => ({ status: "ready", source: "agy_usage", collectedAt: NOW, groups: [
  { id: "gemini", windows: { fiveHour: { usedPercentage: 0 }, sevenDay: { usedPercentage: 23.5 } } },
  { id: "third_party", windows: { fiveHour: { usedPercentage: 100 }, sevenDay: { usedPercentage: 40, resetsAt: NOW + 3660 } } },
] });
describe("AGY remaining usage status", () => {
  let container: HTMLDivElement, root: Root;
  const refresh = vi.fn(async () => {});
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    i18n.addResourceBundle("en", "translation", { chat: {
      agyQuotaPlan: "AGY usage", agyQuotaDetails: "AGY usage details", agyQuotaViewUsage: "View usage",
      agyQuotaRemainingSummary: "5h {{fiveHour}} · Week {{sevenDay}} remaining",
      agyQuotaRemaining: "{{percentage}} remaining", agyQuotaGemini: "Gemini", agyQuotaThirdParty: "Third-party",
      agyQuotaSource: "Native AGY /usage", agyQuotaUnavailable: "AGY usage unavailable",
      agyQuotaCooldown: "Refresh cooldown", agyQuotaQueryFailed: "Could not update AGY usage",
      agyQuotaCredits: "Antigravity credits", agyVertexCredits: "Vertex promotional credits",
      agyQuotaPromoTrial: "Free Trial", agyQuotaPromoGdp: "GDP monthly",
      agyQuotaPromoGuardrail: "No monthly cap · Unlimited RPM",
    } }, true, true);
    refresh.mockClear();
    openExternal.mockClear();
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  async function render(snapshot?: AgyQuotaSnapshot, model = "gemini-pro", loading = false, now = NOW) {
    await act(async () => root.render(<AgyQuotaStatus snapshot={snapshot} model={model} loading={loading} refresh={refresh} now={now} />));
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
    const fills = [...dialog.querySelectorAll<HTMLElement>(".bg-chart-track > div")].map(node => node.style.width);
    expect(fills).toEqual(["100%", "76.5%", "0%", "60%", "91%", "100%"]);
    expect(dialog.textContent).toContain(new Date((NOW + 3660) * 1000).toLocaleString("en"));
    expect(dialog.textContent).toContain("in 1h 1m");
    expect(dialog.textContent).toContain(new Date(NOW * 1000).toLocaleString("en"));
    expect(dialog.textContent).toContain("Native AGY /usage");
    expect(dialog.textContent).not.toContain("Account");
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => dialog.querySelector("button")!.click());
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("uses missing dashes, expires percentages, and labels stale and query errors", async () => {
    await render();
    expect(container.textContent).toBe("5h — · Week — remaining");
    const dialog = await open();
    expect(dialog.textContent).toContain("AGY usage unavailable");
    await render({ ...quota(), status: "stale", errorCode: "query_timeout" });
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("Stale");
    expect(dialog.textContent).toContain("Could not update AGY usage");
    await render({ ...quota(), status: "stale", errorCode: "refresh_cooldown" });
    expect(dialog.textContent).toContain("Refresh cooldown");
    await render(quota(), "gemini-pro", false, NOW + 3600);
    expect(container.textContent).toBe("5h — · Week — remaining");
    expect(dialog.textContent).toContain("over an hour old");
    expect(dialog.textContent).not.toContain(new Date(NOW * 1000).toLocaleString("en"));
    expect(dialog.textContent).toContain("$348.01 / $383.45 (91%)");
    expect(dialog.textContent).toContain("$51.13 (100%)");
  });
  it("supports keyboard dismissal and disables native refresh while loading", async () => {
    await render(quota(), "gemini-pro", true);
    const dialog = await open();
    expect(dialog.querySelector("button")?.disabled).toBe(true);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
  it("shows AI credits only for a valid snapshot", async () => {
    await render({ ...quota(), credits: { remaining: 1250.5 } });
    const dialog = await open();
    expect(dialog.textContent).toContain("Antigravity credits");
    expect(dialog.textContent).toContain("1,250.5");
    await render({ status: "unavailable", groups: [], errorCode: "auth_changed", credits: { remaining: 9 } });
    expect([...dialog.querySelectorAll("dt")].some(node => node.textContent === "Antigravity credits")).toBe(false);
    await render({ ...quota(), credits: { remaining: 0 } });
    expect(dialog.textContent).toMatch(/Antigravity credits\s*0/);
  });
  it.each(["ready", "missing", "unavailable", "expired"] as const)("keeps the separate Vertex credits and official link when native AGY quota is %s", async state => {
    const snapshot = state === "missing" ? undefined : state === "unavailable"
      ? { status: "unavailable" as const, groups: [], errorCode: "auth_changed" }
      : { ...quota(), credits: { remaining: 0 } };
    await render(snapshot, "gemini-4-argon", false, state === "expired" ? NOW + 3600 : NOW);
    const dialog = await open();
    const vertex = dialog.querySelector('section[aria-label="Vertex promotional credits"]');
    expect(vertex).not.toBeNull();
    expect(vertex!.textContent).toContain("$348.01 / $383.45 (91%)");
    expect(vertex!.textContent).toContain("$51.13 (100%)");
    expect(vertex!.textContent).toContain("No monthly cap · Unlimited RPM");
    expect(openExternal).not.toHaveBeenCalled();
    await act(async () => vertex!.querySelector("button")!.click());
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(AGY_VERTEX_LINKS.credits);
    expect(refresh).not.toHaveBeenCalled();
  });
  it("syncs Vertex promotional credits via WebView DOM scraper on refresh", async () => {
    const spy = vi.spyOn(ipc, "agyVertexCreditsRead").mockResolvedValueOnce({
      freeTrialCredit: "$310.00",
      freeTrialOriginalCredit: "$383.45",
      freeTrialRemainingPercent: 81,
      gdpMonthlyCredit: "$45.00",
      gdpMonthlyRemainingPercent: 88,
      collectedAt: NOW,
    });
    await render(quota());
    const dialog = await open();
    await act(async () => dialog.querySelector("button")!.click());
    expect(spy).toHaveBeenCalledWith({ force: true });
    const vertex = dialog.querySelector('section[aria-label="Vertex promotional credits"]');
    expect(vertex!.textContent).toContain("$310.00 / $383.45 (81%)");
    expect(vertex!.textContent).toContain("$45.00 (88%)");
    spy.mockRestore();
  });
});
