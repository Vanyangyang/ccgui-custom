import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    usageSummary: vi.fn(),
    usageWindowTotals: vi.fn(),
    usageClear: vi.fn(),
    claudeQuotaRead: vi.fn(),
    codexQuotaRead: vi.fn(),
    agyQuotaRead: vi.fn(),
  },
}));

vi.mock("@/lib/events", () => ({
  listenUsageChanged: vi.fn(() => Promise.resolve(() => {})),
  listenClaudeQuotaChanged: vi.fn(() => Promise.resolve(() => {})),
  listenCodexQuotaChanged: vi.fn(() => Promise.resolve(() => {})),
  listenAgyQuotaChanged: vi.fn(() => Promise.resolve(() => {})),
}));

import i18n from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { UsageSection } from "./UsageSection";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function todayLocalKey(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

describe("UsageSection", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("zh");
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("renders concise cache breakdown, Claude free cache read with reference cost in parentheses, and inline 5h/weekly inferred USD quota limits", async () => {
    const today = todayLocalKey();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(ipc.usageSummary).mockResolvedValue([
      {
        day: today,
        engine: "codex",
        model: "gpt-6-astra",
        input: 200_000,
        output: 12_000,
        cacheRead: 1_500_000,
        cacheWrite: 0,
        requests: 5,
      },
      {
        day: today,
        engine: "agy",
        model: "gemini-4-argon",
        input: 300_000,
        output: 8_000,
        cacheRead: 1_000_000,
        cacheWrite: 0,
        requests: 4,
      },
      {
        day: today,
        engine: "claude",
        model: "opus",
        input: 50_000,
        output: 3_400,
        cacheRead: 350_000,
        cacheWrite: 0,
        requests: 3,
      },
    ]);

    vi.mocked(ipc.claudeQuotaRead).mockResolvedValue({
      status: "ready",
      collectedAt: nowSec - 5,
      windows: {
        fiveHour: { usedPercentage: 2, resetsAt: nowSec + 3600 },
        sevenDay: { usedPercentage: 20, resetsAt: nowSec + 86400 * 3 },
      },
    });
    vi.mocked(ipc.codexQuotaRead).mockResolvedValue({
      status: "ready",
      collectedAt: nowSec - 5,
      windows: {
        fiveHour: { usedPercentage: 10, resetsAt: nowSec + 3600 },
        sevenDay: { usedPercentage: 25, resetsAt: nowSec + 86400 * 4 },
      },
    });
    vi.mocked(ipc.agyQuotaRead).mockResolvedValue({
      status: "unavailable",
      groups: [],
    });

    vi.mocked(ipc.usageWindowTotals).mockResolvedValue([
      {
        windowId: "claude:fiveHour",
        engine: "claude",
        model: "opus",
        input: 200_000,
        output: 40_000,
        cacheRead: 2_000_000,
        cacheWrite: 0,
        requests: 3,
      },
      {
        windowId: "claude:sevenDay",
        engine: "claude",
        model: "opus",
        input: 2_000_000,
        output: 600_000,
        cacheRead: 10_000_000,
        cacheWrite: 0,
        requests: 20,
      },
      {
        windowId: "codex:fiveHour",
        engine: "codex",
        model: "gpt-6-astra",
        input: 1_000_000,
        output: 150_000,
        cacheRead: 4_000_000,
        cacheWrite: 0,
        requests: 5,
      },
      {
        windowId: "codex:sevenDay",
        engine: "codex",
        model: "gpt-6-astra",
        input: 4_000_000,
        output: 600_000,
        cacheRead: 16_000_000,
        cacheWrite: 0,
        requests: 25,
      },
    ]);

    await act(async () => {
      root.render(<UsageSection />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = host.textContent ?? "";
    expect(text).toContain("等效消耗");
    expect(text).toContain("新输入");
    expect(text).toContain("缓存命中");
    expect(text).toContain("命中率");
    // Claude free cache read with reference cost in parentheses
    expect(text).toContain("免费 ($0.18)");
    // Inline concise 5h & weekly limit badges on CLI rows
    expect(text).toContain("5h $2.00 / ~$100 (2%)");
    expect(text).toContain("周额度 $25.00 / ~$125 (20%)");
    expect(text).toContain("5h $5.00 / ~$50.00 (10%)");
    expect(text).toContain("周额度 $20.00 / ~$80.00 (25%)");
  });
});
