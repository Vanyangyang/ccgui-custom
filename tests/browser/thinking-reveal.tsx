// Open /tests/browser/thinking-reveal.html with the Vite dev server running.
// Replays a 200 tok/s provider stream (100-character bursts every 144ms) into
// the REAL live thinking surface and measures what each animation frame
// actually shows. Before this change the panel rendered every burst in one
// commit, so the text landed in 100-character chunks several times a second.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/lib/i18n";
import { ThinkingSurface } from "@/features/chat/components/ProcessDisclosure";

const BURST_CHARS = 100;
const BURST_MS = 144;
/** Chunk size a burst lands in as far as the reader is concerned: a step this
 *  large in one frame is the "chunky, flashing" artifact under test. */
const POP_CHARS = 30;

const UNIT = `先确认设置页的更新行现在装在哪一层：\`UpdateSection\` 只负责按钮和状态，
真正的检查逻辑仍在 update store 里。

\`\`\`tsx
// inert so the row does not jump mid-install.
<Button size="small" variant="primary" disabled>
  {t("settings.updateNow")}
</Button>
\`\`\`

I need to be careful with exact whitespace. From the reads: \`<SettingsRow\` was wrapped at line ~180, so the description line collapses into the header row.

下一步核对文案与 i18n key：\`settings.checkUpdates\` / \`settings.updateNow\` 都要有双语条目，
然后跑 pnpm build 与相关 vitest 用例。🙂
`;
const STREAM = UNIT.repeat(20);

type Sample = { frames: number; pops: number; maxStep: number; steps: number[] };

function Harness() {
  const [text, setText] = useState("");
  const [sample, setSample] = useState<Sample>({ frames: 0, pops: 0, maxStep: 0, steps: [] });
  const [runId, setRunId] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Provider cadence: one burst every 144ms.
  useEffect(() => {
    let sent = 0;
    const timer = window.setInterval(() => {
      sent = Math.min(STREAM.length, sent + BURST_CHARS);
      setText(STREAM.slice(0, sent));
      if (sent >= STREAM.length) window.clearInterval(timer);
    }, BURST_MS);
    return () => window.clearInterval(timer);
  }, [runId]);

  // What the reader sees: sample the rendered body once per animation frame.
  useEffect(() => {
    let raf = 0;
    let previous = 0;
    const acc: number[] = [];
    const tick = () => {
      const shown = hostRef.current?.querySelector(".whitespace-pre-wrap")?.textContent?.length ?? 0;
      const step = shown - previous;
      if (step > 0) acc.push(step);
      previous = shown;
      setSample((s) => ({
        frames: s.frames + 1,
        pops: s.pops + (step >= POP_CHARS ? 1 : 0),
        maxStep: Math.max(s.maxStep, step),
        steps: acc.slice(-240),
      }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [runId]);

  const sorted = [...sample.steps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const done = text.length >= STREAM.length;
  const status = done && sample.frames > 60 ? (sample.pops === 0 ? "PASS" : "FAIL") : "RUNNING";

  return (
    <>
      <pre id="readout" style={{ font: "12px ui-monospace, monospace", whiteSpace: "pre-wrap" }}>
        {JSON.stringify({
          status,
          received: text.length,
          total: STREAM.length,
          sampledFrames: sample.frames,
          framesJumpingAtLeast: `${sample.pops} (>= ${POP_CHARS} chars)`,
          largestSingleFrameStep: sample.maxStep,
          medianStep: median,
        }, null, 2)}
        {"\n"}
        <button type="button" onClick={() => { setText(""); setSample({ frames: 0, pops: 0, maxStep: 0, steps: [] }); setRunId((n) => n + 1); }}>
          replay
        </button>
      </pre>
      <div ref={hostRef} style={{ maxWidth: 720, fontFamily: "ui-sans-serif, system-ui" }}>
        <ThinkingSurface text={text} live title="思考过程" />
      </div>
    </>
  );
}

createRoot(document.getElementById("fixture")!).render(<Harness />);
