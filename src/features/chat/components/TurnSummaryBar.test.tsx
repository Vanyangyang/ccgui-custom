import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import type { Message } from "@/lib/ipc";
import { TurnSummaryBar } from "./TurnSummaryBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("turn summary presentation", () => {
  let container: HTMLDivElement;
  let root: Root;
  const message: Message = { role: "assistant", seq: 1, text: "回答正文🙂", ts: null };
  beforeEach(async () => {
    await i18n.changeLanguage("zh");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  it("keeps reported numbers visible and names the whole-turn throughput", async () => {
    await act(async () => root.render(<TurnSummaryBar message={{ ...message, durationMs: 10_000,
      usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 200, reasoning_output_tokens: 50 },
    }} tools={3} />));
    expect(container.querySelector('[aria-label="本轮小结"]')).not.toBeNull();
    expect(container.textContent).toContain("↑1k ↓200");
    expect(container.textContent).toContain("90%");
    expect(container.textContent).toContain("整轮效率 20 tok/s");
    expect(container.querySelector('[title*="不是模型生成速度"]')?.getAttribute("title")).toContain("含工具、等待与思考");
    expect(container.querySelector('[title*="思考 50 token"]')).not.toBeNull();
    expect(container.textContent).not.toContain("chat.");
  });
  it("renders Codex last-request usage as partial and uses verified turn throughput when present", async () => {
    await act(async () => root.render(<TurnSummaryBar message={{
      ...message,
      durationMs: 300_000,
      usage: {
        usage_scope: "last_request",
        input_tokens: 45_000,
        cached_input_tokens: 36_000,
        output_tokens: 90,
        total_tokens: 45_090,
        turn_throughput: { output_tokens: 6_000, elapsed_ms: 300_000 },
      },
    }} tools={4} />));
    expect(container.textContent).toContain("已上报 ↑45k ↓6k");
    expect(container.textContent).not.toContain("80%");
    expect(container.textContent).toContain("整轮效率 20 tok/s");

    await act(async () => {
      await i18n.changeLanguage("en");
      root.render(<TurnSummaryBar message={{
        ...message,
        durationMs: 300_000,
        usage: {
          usage_scope: "last_request",
          input_tokens: 45_000,
          cached_input_tokens: 36_000,
          output_tokens: 90,
          total_tokens: 45_090,
        },
      }} tools={4} />);
    });
    expect(container.textContent).toContain("Reported ↑45k ↓90");
    expect(container.textContent).not.toContain("tok/s");
    expect(container.textContent).not.toContain("80%");
  });
  it("renders no empty capsule or placeholder for missing data", async () => {
    await act(async () => root.render(<TurnSummaryBar message={message} tools={0} />));
    expect(container.innerHTML).toBe("");
  });
  it("shows interrupted reported usage without presenting an efficiency or cache percentage", async () => {
    await act(async () => root.render(<TurnSummaryBar message={{
      ...message, durationMs: 10_000,
      usage: { input_tokens: 200, cache_read_input_tokens: 800, output_tokens: 400,
        usage_scope: "turn", turn_status: "partial" },
    }} tools={2} />));
    expect(container.textContent).toContain("已上报 ↑1k ↓400");
    expect(container.textContent).not.toContain("tok/s");
    expect(container.textContent).not.toContain("%");
    expect(container.querySelector('[title*="中断回合"]')).not.toBeNull();
  });
});
