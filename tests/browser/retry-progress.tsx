// Open /tests/browser/retry-progress.html with the Vite dev server running.
// Visual fixture for the tail indicator's provider-retry chip ("重试中 x/y"):
// local state only — no IPC, no model, no saved conversation. The chip must
// read as progress (warning tone, at the end of the meta row) and must go
// away on the "content resumed" button, never as an error banner.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import { AgentThinking } from "../../src/components/application/agent-thinking/agent-thinking";

type Retry = { attempt: number; max: number; message: string } | null;

const CASES: Array<[string, Retry]> = [
  ["正常响应（无重试）", null],
  ["claude api_retry 3/10", { attempt: 3, max: 10, message: "API error (HTTP 529); retrying (3/10) in 9.6s" }],
  ["codex Reconnecting 1/5", { attempt: 1, max: 5, message: "stream disconnected before completion" }],
  ["omp auto_retry（无上限）", { attempt: 2, max: 0, message: "HTTP 502" }],
];

function label(retry: Retry) {
  if (!retry) return null;
  return retry.max > 0 ? `重试中 ${retry.attempt}/${retry.max}` : `重试中 ${retry.attempt}`;
}

function Fixture() {
  const [index, setIndex] = useState(1);
  const [startedAt] = useState(() => Date.now() - 42_000);
  const retry = CASES[index][1];
  return (
    <div style={{ maxWidth: 768, margin: "40px auto", padding: "0 16px", fontFamily: "sans-serif" }}>
      <div style={{ marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {CASES.map(([name], i) => (
          <button key={name} onClick={() => setIndex(i)} style={{ fontWeight: i === index ? 700 : 400 }}>
            {name}
          </button>
        ))}
      </div>
      <div style={{ background: "#fff", border: "1px solid #e4e4e7", borderRadius: 12, padding: 16 }}>
        <div style={{ color: "#71717a", fontSize: 13, marginBottom: 8 }}>
          …流式正文停在这里，下面是回合尾部的运行指示器：
        </div>
        <div data-testid="tail">
          <AgentThinking
            variant="wave"
            label="响应中"
            className="py-2"
            startedAt={startedAt}
            durationFormatter={(d) => `已用 ${d}`}
            model="claude-opus-5"
            effort="推理档位 high"
            usage="↑12.3k ↓412"
            retry={label(retry)}
            retryDetail={retry?.message ?? null}
          />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("fixture")!).render(<Fixture />);
