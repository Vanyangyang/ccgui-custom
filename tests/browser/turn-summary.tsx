// Production summary component; static test data, no IPC or model calls.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TurnSummaryBar } from "../../src/features/chat/components/TurnSummaryBar";
import type { Message } from "../../src/lib/ipc";
import i18n from "../../src/lib/i18n";
import "../../src/index.css";

const language = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "zh";
await i18n.changeLanguage(language);
const base: Message = { seq: 1, role: "assistant", text: "", ts: null };
const cases = [
  { id: "complete", label: "完整计量 / Complete measurements", tools: 116, message: { ...base, durationMs: 125_000,
    usage: { input_tokens: 32_000, output_tokens: 8_000, cache_read_input_tokens: 96_000, reasoning_tokens: 4_000 } } },
  { id: "incomplete", label: "不完整计量 / Incomplete measurements", tools: 3, message: { ...base, durationMs: 17_500,
    usage: { usage_scope: "unknown", input_tokens: 4_000, output_tokens: 500, cache_read_input_tokens: 1_000 } } },
  { id: "duration-tools", label: "仅耗时与工具 / Duration and tools only", tools: 2, message: { ...base, durationMs: 6_000 } },
  { id: "context-only", label: "仅上下文，无小结 / Context only, summary hidden", tools: 0, message: { ...base,
    usage: { context_usage_kind: "last_prompt", input_tokens: 100_000, output_tokens: 2_000 } } },
];

function Fixture() {
  const [result, setResult] = useState("RUNNING");
  useEffect(() => {
    let disposed = false;
    void (async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (disposed) return;
      const rows = [...document.querySelectorAll<HTMLElement>("[data-summary-case]")].map(row => {
        const group = row.querySelector<HTMLElement>('[role="group"]');
        const chips = [...(group?.children ?? [])] as HTMLElement[];
        const bounds = row.getBoundingClientRect();
        return { width: row.clientWidth, id: row.dataset.summaryCase, text: group?.textContent ?? "",
          chips: chips.length, overflow: row.scrollWidth > row.clientWidth + 1 || chips.some(chip => {
            const box = chip.getBoundingClientRect(); return box.left < bounds.left || box.right > bounds.right + 1;
          }), titles: chips.map(chip => chip.title) };
      });
      const passed = rows.length === 12 && rows.every(row => !row.overflow && (row.id === "complete" ? row.chips === 6
        : row.id === "incomplete" ? row.chips === 3 && !row.text.includes("tok/s")
        : row.id === "duration-tools" ? row.chips === 2 : row.chips === 0));
      document.documentElement.dataset.result = passed ? "PASS" : "FAIL";
      setResult(JSON.stringify({ passed, rows }, null, 2));
    })();
    return () => { disposed = true; };
  }, []);
  return <main className="flex min-h-dvh flex-col gap-5 bg-background-primary-default p-4 text-text-primary">
    <h1 className="text-heading-3">轮次小结 / Turn summary · {language}</h1>
    <p className="text-caption-1-regular text-text-secondary">真实组件 + 静态数据，无模型调用 / Production component with static data; no model calls.</p>
    {[768, 480, 320].map(width => <section key={width} style={{ width, maxWidth: "100%" }} className="flex flex-col gap-3">
      <h2 className="text-body-2-medium">{width}px</h2>
      {cases.map(item => <article key={item.id} data-summary-case={item.id} className="rounded-xl border border-border-secondary p-3">
        <p className="text-caption-1-regular text-text-secondary">{item.label}</p>
        <TurnSummaryBar message={item.message} tools={item.tools} />
      </article>)}
    </section>)}
    <pre id="result" className="max-w-full whitespace-pre-wrap break-words text-caption-1-regular">{result}</pre>
  </main>;
}
createRoot(document.getElementById("fixture")!).render(<Fixture />);
