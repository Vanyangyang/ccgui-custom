import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { ClaudeHaikuAssistControl } from "./ClaudeHaikuAssistControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const [enabled, setEnabled] = useState(false);
  return <ClaudeHaikuAssistControl enabled={enabled} mainModel="opus" onChange={setEnabled} />;
}

describe("Haiku assistance control", () => {
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

  it.each(["zh", "en"])("shows off/on, the main model, scope and limitations in %s", async (language) => {
    await act(async () => { await i18n.changeLanguage(language); root.render(<Harness />); });
    const trigger = container.querySelector("button")!;
    expect(trigger.textContent).toBe(i18n.t("chat.haikuAssistOff"));
    expect(trigger.getAttribute("aria-label")).toContain("opus");
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(i18n.t("chat.haikuAssistMainModel", { model: "opus" }));
    expect(dialog.textContent).toContain(i18n.t("chat.haikuAssistDescription"));
    expect(dialog.textContent).toContain(i18n.t("chat.haikuAssistTiming"));
    const toggle = document.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(toggle.checked).toBe(false);
    expect(toggle.getAttribute("aria-describedby")).toBeTruthy();
    await act(async () => toggle.click());
    expect(trigger.textContent).toBe(i18n.t("chat.haikuAssistOn"));
    expect(toggle.checked).toBe(true);
    await act(async () => toggle.click());
    expect(trigger.textContent).toBe(i18n.t("chat.haikuAssistOff"));
    expect(dialog.textContent).toContain("opus");
  });

  it("distinguishes a pending change from the running process", async () => {
    await act(async () => root.render(<ClaudeHaikuAssistControl enabled={false} runningEnabled={true} mainModel="opus" onChange={() => {}} />));
    const trigger = container.querySelector("button")!;
    expect(trigger.textContent).toContain(i18n.t("chat.haikuAssistOff"));
    expect(trigger.textContent).toContain(i18n.t("chat.haikuAssistPending"));
    await act(async () => trigger.click());
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(i18n.t("chat.haikuAssistRunning", { mode: i18n.t("chat.haikuAssistOn") }));
  });
});
