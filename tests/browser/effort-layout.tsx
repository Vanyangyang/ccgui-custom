import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { CliMenu, type EffortLevel } from "../../src/components/application/ai-chat/cli-menu";
import { getEffortLevels } from "../../src/components/application/ai-chat/effort-levels";
import "../../src/index.css";
import "../../src/lib/i18n";

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const params = new URLSearchParams(location.search);
const engine = ["claude", "codex", "agy"].includes(params.get("engine") ?? "") ? params.get("engine")! : "omp";
const manual = params.get("manual") === "1";
const catalog = engine === "agy" ? [
  { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)", provider: "anthropic" },
  { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)", provider: "anthropic" },
  { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)", provider: "anthropic" },
  { id: "gemini-3-8-flash-low", label: "Gemini 3.8 Flash (Low)", provider: "google" },
  { id: "gemini-3-8-flash-high", label: "Gemini 3.8 Flash (High)", provider: "google" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", provider: "openai" },
  { id: "custom-model", label: "Custom model" },
] : [engine === "claude" ? { id: "claude-opus-4-8", label: "Claude Opus 4.8" } : { id: "openai-codex/gpt-5.4", label: "GPT-5.4", provider: "openai-codex" }];
function Test() {
  const [effort, setEffort] = useState<EffortLevel>("low");
  const [modelId, setModelId] = useState(catalog[0].id);
  const [modelChanges, setModelChanges] = useState(0);
  const [ultracode, setUltracode] = useState(false);
  const [effortChanges, setEffortChanges] = useState(0);
  const [ultracodeChanges, setUltracodeChanges] = useState(0);
  useEffect(() => {
    if (manual) return;
    let cancelled = false;
    async function run() {
      await document.fonts.ready;
      const button = document.querySelector<HTMLButtonElement>("[data-trigger] button")!;
      button.click();
      // Let the popover entrance animation settle before measuring layout.
      await new Promise(resolve => setTimeout(resolve, 500));
      await frame(); await frame();
      const measurements = [];
      for (const level of getEffortLevels(engine)) {
        if (cancelled) return;
        flushSync(() => setEffort(level));
        await frame(); await frame();
        const r = button.getBoundingClientRect();
        const dialog = document.querySelector('[role="dialog"]')?.getBoundingClientRect();
        measurements.push({ level, width: r.width, right: r.right, dialogX: dialog?.x });
      }
      const first = measurements[0];
      const pass = measurements.every(m => Math.abs(m.width - first.width) < 0.5 && Math.abs(m.right - first.right) < 0.5 && m.dialogX !== undefined && Math.abs(m.dialogX - first.dialogX!) < 0.5);
      document.querySelector("#result")!.textContent = JSON.stringify({ status: pass ? "PASS" : "FAIL", measurements }, null, 2);
    }
    void run();
    return () => { cancelled = true; };
  }, []);
  return <><pre id="result" className="whitespace-pre-wrap break-words p-3 text-caption-1-regular text-text-primary">{manual ? JSON.stringify({ engine, modelId, modelChanges, effort, ultracode, effortChanges, ultracodeChanges }, null, 2) : "Running…"}</pre>
    <div data-composer className="fixed bottom-[30px] flex items-center gap-2 rounded-lg border border-border-button-default bg-background-primary-default p-2" style={{ left: manual ? 16 : 300, maxWidth: "calc(100vw - 32px)" }}>
    <div data-trigger className="min-w-0">
    <CliMenu options={[{ id: engine, label: engine, available: true }]} value={engine} onChange={() => {}}
      modelsByEngine={{ [engine]: catalog }}
      models={{ [engine]: modelId }} onModelChange={(_, id) => { setModelId(id); setModelChanges((value) => value + 1); }}
      efforts={{ [engine]: effort }} onEffortChange={(_, level) => { setEffort(level); setEffortChanges((value) => value + 1); }}
      claudeUltracode={ultracode} onClaudeUltracodeChange={(enabled) => { setUltracode(enabled); setUltracodeChanges((value) => value + 1); }}
      ompServiceTier={null} onOmpServiceTierChange={async () => {}}
      codexServiceTier={null} onCodexServiceTierChange={async () => {}} />
    </div><button data-send className="size-8 shrink-0 rounded-md bg-background-secondary-default text-text-primary" aria-label="Mock send">↑</button>
  </div></>;
}
createRoot(document.getElementById("root")!).render(<Test />);
