// Real footer + quota component, synthetic data and IPC. No native app or API.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { StatusBar } from "../../src/components/application/ai-chat/ai-chat-composer";
import { ClaudeQuotaStatus } from "../../src/features/chat/components/ClaudeQuotaStatus";
import type { ClaudeQuotaSnapshot } from "../../src/lib/ipc";
import i18n from "../../src/lib/i18n";
import "../../src/index.css";

const locale = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "zh";
await i18n.changeLanguage(locale);
const now = new Date(2026, 9, 2, 21, 0).getTime() / 1000;
const snapshot: ClaudeQuotaSnapshot = {
  status: "ready", collectedAt: now,
  account: { email: "reader@example.com", plan: "Claude Team" },
  windows: {
    fiveHour: { usedPercentage: 31, resetsAt: new Date(2026, 9, 2, 23, 49).getTime() / 1000 },
    sevenDay: { usedPercentage: 4, resetsAt: new Date(2026, 9, 5, 3, 59).getTime() / 1000 },
  },
};
function Fixture() {
  const [result, setResult] = useState("RUNNING");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await document.fonts.ready;
      await new Promise(resolve => setTimeout(resolve, 300));
      if (cancelled) return;
      const layouts = [...document.querySelectorAll<HTMLElement>("[data-quota-frame]")].map(frame => {
        const bounds = frame.getBoundingClientRect();
        const times = [...frame.querySelectorAll("time")];
        const summary = [...frame.querySelectorAll("span")].find(node => node.textContent === "5h 31% · 7d 4%");
        const summaryBounds = summary?.getBoundingClientRect();
        const visible = times.length === 2 && times.every(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
        });
        const wideOrder = frame.clientWidth < 700 || Boolean(summaryBounds && times.every(node => node.getBoundingClientRect().right < summaryBounds.left));
        return { width: frame.clientWidth, overflow: frame.scrollWidth > frame.clientWidth + 1, visible, wideOrder };
      });
      const passed = layouts.length === 3 && layouts.every(row => !row.overflow && row.visible && row.wideOrder);
      document.documentElement.dataset.result = passed ? "PASS" : "FAIL";
      setResult(JSON.stringify({ passed, locale, layouts }, null, 2));
    })();
    return () => { cancelled = true; };
  }, []);
  return <main className="flex min-h-dvh flex-col items-start gap-8 bg-background-primary-default p-4 text-text-primary">
    {[768, 480, 320].map(width => <section key={width} style={{ width }}>
      <p className="mb-2 text-caption-1-regular">{width}px</p>
      <div data-quota-frame className="w-full rounded-lg border border-border-button-default p-2">
        <StatusBar branch="main" folders={["Workspace"]} selectedFolder="Workspace" usagePct={24} contextMax={750000} autoCompactWindow={750000}
          quotaStatus={<ClaudeQuotaStatus snapshot={snapshot} now={now} loading={false} refresh={async () => {}} />} />
      </div>
    </section>)}
    <pre id="result" className="text-caption-1-regular">{result}</pre>
  </main>;
}
createRoot(document.getElementById("fixture")!).render(<Fixture />);
