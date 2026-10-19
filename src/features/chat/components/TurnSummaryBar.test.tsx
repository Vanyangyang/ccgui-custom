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
  it("keeps reported numbers visible and names the whole-turn average", async () => {
    await act(async () => root.render(<TurnSummaryBar message={{ ...message, durationMs: 10_000,
      usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 200, reasoning_output_tokens: 50 },
    }} tools={3} />));
    expect(container.querySelector('[aria-label="本轮小结"]')).not.toBeNull();
    expect(container.textContent).toContain("↑1k ↓200");
    expect(container.textContent).toContain("90%");
    expect(container.textContent).toContain("均速 20 tok/s");
    expect(container.querySelector('[title*="思考 50 token"]')).not.toBeNull();
    expect(container.textContent).not.toContain("chat.");
  });
  it("renders no empty capsule or placeholder for missing data", async () => {
    await act(async () => root.render(<TurnSummaryBar message={message} tools={0} />));
    expect(container.innerHTML).toBe("");
  });
});
