import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptCacheWindow } from "@/lib/ipc";
import { cacheWindowSummary, cacheWindowText, getPromptCacheHeatRatio, getSessionCacheHeat, nextCacheBoundary, promptCacheForEngine } from "./prompt-cache";
import { createInstance } from "i18next";
import { zh } from "@/i18n/zh";
import { en } from "@/i18n/en";
import { usePromptCacheHeat } from "./use-prompt-cache";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const start = 1_900_000_000_000;
const windowFor = (ttlSeconds: number): PromptCacheWindow => ({ startedAt: start, observedAt: start + 60_000, ttlSeconds, source: "anthropic-usage" });
afterEach(() => vi.useRealTimers());

describe("provider prompt-cache retention", () => {
  it.each(["zh", "en"])("shows local expiry endpoints with seconds in %s without inventing an exact deadline", async (lng) => {
    const i18n = createInstance();
    await i18n.init({ lng, resources: { zh: { translation: zh }, en: { translation: en } }, interpolation: { escapeValue: false } });
    const cache = windowFor(300);
    const date = (value: number) => new Intl.DateTimeFormat(lng, {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(new Date(value));
    const timeOnly = (value: number) => new Intl.DateTimeFormat(lng, {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(new Date(value));
    for (const heat of ["hot", "unknown", "cold"] as const) {
      const text = cacheWindowText(i18n.t, cache, heat);
      expect(text).toContain(`${date(start + 300_000)} – ${date(start + 360_000)}`);
      expect(text).toContain(lng === "zh" ? "预计保留窗口结束" : "Estimated retention window end");
    }
    const summaryHot = cacheWindowSummary(i18n.t, cache, "hot", start + 120_000);
    expect(summaryHot.statusLabel).toContain("5");
    expect(summaryHot.expiringSoon).toBe(false);
    expect(summaryHot.headline).toContain(lng === "zh" ? "4分00秒" : "4m 00s");
    expect(summaryHot.expiryRange).toBe(`${date(start + 300_000)} – ${timeOnly(start + 360_000)}`);
    expect(summaryHot.expirySpanLabel).toContain(lng === "zh" ? "1分00秒" : "1m 00s");
    expect(summaryHot.isReference).toBe(false);

    const summaryExpiring = cacheWindowSummary(i18n.t, cache, "hot", start + 276_000);
    expect(summaryExpiring.expiringSoon).toBe(true);
    expect(summaryExpiring.statusLabel).toContain(lng === "zh" ? "即将过期" : "Expiring soon");

    const exact = cacheWindowText(i18n.t, { ...cache, observedAt: start }, "hot");
    expect(exact).toContain(date(start + 300_000));
    expect(exact).not.toContain(" – ");
    const reference = cacheWindowText(i18n.t, { ...cache, source: "agy-vertex-reference", ttlSeconds: 900,
      reference: { maxTtlSeconds: 1200, cacheReadTokens: 0, promptTokens: 1000 } }, "unknown");
    expect(reference).toContain(`${date(start + 900_000)} – ${date(start + 1260_000)}`);
    expect(reference).toContain(lng === "zh" ? "非实际过期时间" : "not an actual expiry time");
    const refSummary = cacheWindowSummary(i18n.t, { ...cache, source: "agy-vertex-reference", ttlSeconds: 900,
      reference: { maxTtlSeconds: 1200, cacheReadTokens: 900, promptTokens: 1000 } }, "hot", start + 120_000);
    expect(refSummary.isReference).toBe(true);
    expect(refSummary.expiringSoon).toBe(false);
    expect(refSummary.statusLabel).toContain("15–20");
    expect(refSummary.headline).toContain(" – ");
    expect(refSummary.expirySpanLabel).toContain("15–20");

    const mixed = cacheWindowText(i18n.t, { ...cache, source: "anthropic-mixed" }, "hot");
    expect(mixed).toContain(date(start + 300_000));
    expect(mixed).toContain(i18n.t("chat.cacheWindowMixed"));
    for (const invalid of [undefined, { ...cache, ttlSeconds: NaN }, { ...cache, startedAt: 0 },
      { ...cache, observedAt: start - 1 }, { ...cache, ttlSeconds: Number.MAX_VALUE }]) {
      expect(cacheWindowText(i18n.t, invalid, "unknown")).toBe(i18n.t("chat.cacheWindowUnknown"));
      expect(cacheWindowSummary(i18n.t, invalid, "unknown").note).toBe(i18n.t("chat.cacheWindowUnknown"));
    }
  });
  it("uses an advisory AGY range and preserves the last measured miss", async () => {
    const cache: PromptCacheWindow = { ...windowFor(900), source: "agy-vertex-reference", reference: { maxTtlSeconds: 1200, cacheReadTokens: 900, promptTokens: 1000 } };
    expect(getSessionCacheHeat(cache, start + 10 * 60_000)).toBe("hot");
    expect(getSessionCacheHeat(cache, start + 17 * 60_000)).toBe("unknown");
    expect(getSessionCacheHeat(cache, start + 21 * 60_000)).toBe("cold");
    expect(nextCacheBoundary(cache, start + 17 * 60_000)).toBe(start + 21 * 60_000);
    expect(getPromptCacheHeatRatio(cache, start + 10 * 60_000, true, start + 10 * 60_000)).toBe(0.5);
    const missed = { ...cache, reference: { ...cache.reference!, cacheReadTokens: 0 } };
    expect(getSessionCacheHeat(missed, start + 2 * 60_000)).toBe("unknown");
    expect(getPromptCacheHeatRatio(missed, start + 2 * 60_000, true, start + 2 * 60_000)).toBe(0);
    const i18n = createInstance();
    await i18n.init({ lng: "zh", resources: { zh: { translation: zh } } });
    expect(cacheWindowText(i18n.t, cache, "hot")).toContain("15–20");
    expect(cacheWindowText(i18n.t, cache, "hot")).toContain("90%");
    expect(cacheWindowText(i18n.t, cache, "hot")).toContain("参考");
    expect(cacheWindowText(i18n.t, missed, "unknown")).toContain("上次请求未命中");
  });
  it("disables Cursor policy metadata and never renews heat from streaming or activity", () => {
    expect(promptCacheForEngine("cursor", windowFor(3600))).toBeUndefined();
    expect(getPromptCacheHeatRatio(undefined, start + 60_000, true, start + 60_000)).toBe(0);
    expect(getPromptCacheHeatRatio(windowFor(300), start + 10 * 60_000, true, start + 10 * 60_000)).toBe(0);
  });
  it.each([300, 1800, 3600])("uses the recorded %i-second window and preserves uncertain request timing", (ttl) => {
    const w = windowFor(ttl);
    expect(getSessionCacheHeat(w, start + ttl * 1000 - 1)).toBe("hot");
    expect(getSessionCacheHeat(w, start + ttl * 1000)).toBe("unknown");
    expect(getSessionCacheHeat(w, w.observedAt + ttl * 1000)).toBe("cold");
    expect(nextCacheBoundary(w, start + ttl * 1000)).toBe(w.observedAt + ttl * 1000);
  });
  it("does not reuse the former universal five-minute threshold", () => {
    expect(getSessionCacheHeat(windowFor(3600), start + 45 * 60_000)).toBe("hot");
    expect(getSessionCacheHeat(windowFor(1800), start + 20 * 60_000)).toBe("hot");
    expect(getSessionCacheHeat(windowFor(300), start + 20 * 60_000)).toBe("cold");
  });
  it("rejects missing, malformed and future evidence", () => {
    expect(getSessionCacheHeat(undefined, start)).toBe("unknown");
    for (const w of [{ ...windowFor(300), ttlSeconds: NaN }, { ...windowFor(300), startedAt: 0 }, { ...windowFor(300), observedAt: start - 1 }]) {
      expect(getSessionCacheHeat(w, start + 60_000)).toBe("unknown");
    }
    expect(getSessionCacheHeat(windowFor(300), start)).toBe("unknown");
  });
  it("expires idle rows, uses current time on session switches and cleans up timers", () => {
    vi.useFakeTimers(); vi.setSystemTime(start + 2 * 60_000);
    const host = document.createElement("div");
    const root = createRoot(host);
    const Probe = ({ value }: { value?: PromptCacheWindow }) => <span>{usePromptCacheHeat(value)}</span>;
    try {
      act(() => root.render(<Probe value={windowFor(300)} />));
      expect(host.textContent).toBe("hot");
      act(() => vi.advanceTimersByTime(3 * 60_000 + 2));
      expect(host.textContent).toBe("unknown");
      act(() => vi.advanceTimersByTime(60_000));
      expect(host.textContent).toBe("cold");
      act(() => root.render(<Probe value={windowFor(3600)} />));
      expect(host.textContent).toBe("hot");
      act(() => root.render(<Probe />));
      expect(host.textContent).toBe("unknown");
    } finally { act(() => root.unmount()); }
    expect(vi.getTimerCount()).toBe(0);
  });
});
