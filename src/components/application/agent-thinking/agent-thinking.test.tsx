import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentThinking } from "./agent-thinking";
import "../../../index.css";

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentThinking", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders label and timer correctly", () => {
    act(() => {
      root.render(
        <AgentThinking
          label="响应中"
          startedAt={Date.now() - 5000}
        />,
      );
    });

    expect(container.textContent).toContain("响应中");
    expect(container.textContent).toMatch(/\d+\.\d+s/);
  });

  it("applies custom durationFormatter", () => {
    act(() => {
      root.render(
        <AgentThinking
          label="响应中"
          startedAt={Date.now() - 5000}
          durationFormatter={(d) => `耗时 ${d}`}
        />,
      );
    });

    expect(container.textContent).toContain("响应中");
    expect(container.textContent).toMatch(/耗时 \d+\.\d+s/);
  });

  it("renders model and effort with separator", () => {
    act(() => {
      root.render(
        <AgentThinking
          label="响应中"
          startedAt={Date.now() - 65000}
          durationFormatter={(d) => `耗时 ${d}`}
          model="模型 gemini-3.8-flash"
          effort="推理档位 high"
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("响应中");
    expect(text).toContain("耗时 1m5s");
    expect(text).toContain("模型 gemini-3.8-flash");
    expect(text).toContain("推理档位 high");
    expect(text).toContain("·");
  });

  it("shows reported token usage between the timer and the model", () => {
    // Live consumption for the running turn: engines report it mid-turn, so
    // the strip must render it without waiting for the turn to settle.
    act(() => {
      root.render(
        <AgentThinking
          label="响应中"
          startedAt={Date.now() - 5000}
          durationFormatter={(d) => `耗时 ${d}`}
          usage="↑12.3k ↓412"
          model="模型 deepseek-v4-flash"
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("↑12.3k ↓412");
    // Order mirrors the settled rows: duration · usage · model.
    expect(text.indexOf("耗时")).toBeLessThan(text.indexOf("↑12.3k"));
    expect(text.indexOf("↑12.3k")).toBeLessThan(text.indexOf("模型"));
  });

  it("omits the usage segment when the engine has not reported yet", () => {
    act(() => {
      root.render(<AgentThinking label="响应中" startedAt={Date.now() - 5000} usage={null} />);
    });
    expect(container.textContent ?? "").not.toContain("↑");
  });

  it("pauses visual heartbeat while waiting for a provider retry", () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    try {
      act(() => {
        root.render(
          <AgentThinking
            label="响应中"
            retry="重试中 8/50"
            startedAt={Date.now() - 5000}
          />,
        );
      });

      expect(container.querySelector(".bui-agent-thinking-label")).toBeNull();
      expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 80);
      expect(container.textContent).toContain("重试中 8/50");
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("holds still and shows the note while the work waits on the user elsewhere", () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    try {
      act(() => {
        root.render(
          <AgentThinking
            label="Codex Desktop 等待权限确认"
            attention="请在 Codex Desktop 中处理"
            showTimer={false}
          />,
        );
      });

      expect(container.querySelector(".bui-agent-thinking-label")).toBeNull();
      expect(container.querySelector(".bui-agent-thinking-static")).not.toBeNull();
      expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 80);
      const note = [...container.querySelectorAll("span")].find((span) => span.textContent === "请在 Codex Desktop 中处理");
      expect(note?.className).toContain("text-text-warning-primary");
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("keeps the stars indicator visible while waiting for a retry", () => {
    act(() => {
      root.render(
        <AgentThinking
          variant="stars"
          label="响应中"
          retry="重试中 3/10"
          startedAt={Date.now() - 5000}
        />,
      );
    });

    const star = container.querySelector<SVGElement>(".bui-agent-thinking-star");
    expect(star).not.toBeNull();
    expect(getComputedStyle(star!).opacity).toBe("0.7");
  });
});
