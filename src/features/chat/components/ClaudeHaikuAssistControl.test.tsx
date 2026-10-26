import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ClaudeHaikuAssistControl } from "./ClaudeHaikuAssistControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("temporarily disabled Haiku assistance control", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalLanguage = i18n.language;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    await i18n.changeLanguage(originalLanguage);
  });

  it.each(["zh", "en"])("hides the entry for every restored choice and running state in %s", async (language) => {
    const onChange = vi.fn();
    await act(async () => { await i18n.changeLanguage(language); });
    for (const enabled of [false, true]) {
      for (const runningEnabled of [undefined, false, true]) {
        await act(async () => root.render(<ClaudeHaikuAssistControl enabled={enabled} runningEnabled={runningEnabled} mainModel="opus" onChange={onChange} />));
        expect(container.childElementCount).toBe(0);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
      }
    }
    expect(onChange).not.toHaveBeenCalled();
  });
});
