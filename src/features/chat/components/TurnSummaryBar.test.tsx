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

  it("renders unified speed chip with active-time breakdown tooltip when turn_throughput is present", async () => {
    await act(async () => root.render(<TurnSummaryBar message={{
      ...message,
      durationMs: 9_200,
      usage: {
        usage_scope: "turn",
        input_tokens: 100,
        cache_read_input_tokens: 900,
        output_tokens: 100,
        thinking_tokens: 50,
        turn_throughput: {
          output_tokens: 100,
          elapsed_ms: 2_000,
          wall_ms: 9_200,
          tool_ms: 5_400,
          wait_ms: 0,
          startup_ms: 1_800,
        },
      },
    }} tools={3} />));
    expect(container.querySelector('[aria-label="本轮小结"]')).not.toBeNull();
    expect(container.textContent).toContain("↑1k ↓100");
    expect(container.textContent).toContain("90%");
    expect(container.textContent).toContain("50 tok/s");
    expect(container.textContent).not.toContain("整轮效率");
    const speedTip = container.querySelector('[title*="模型推理速率"]')?.getAttribute("title") ?? "";
    expect(speedTip).toContain("模型推理 2.0s · 工具 5.4s · 启动 1.8s · 总耗时 9.2s");
    expect(container.querySelector('[title*="思考 50 token"]')).not.toBeNull();
    expect(container.textContent).not.toContain("chat.");
  });

  it("falls back honestly to whole-turn tooltip on older records without turn_throughput", async () => {
    await act(async () => root.render(<TurnSummaryBar message={{
      ...message,
      durationMs: 10_000,
      usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 200, reasoning_output_tokens: 50 },
    }} tools={3} />));
    expect(container.textContent).toContain("20 tok/s");
    expect(container.querySelector('[title*="旧记录未拆分工具耗时"]')?.getAttribute("title")).toContain("含工具、等待与思考");
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
    expect(container.textContent).toContain("20 tok/s");

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
