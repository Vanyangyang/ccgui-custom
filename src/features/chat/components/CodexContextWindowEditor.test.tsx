import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexContextWindowEditor } from "./CodexContextWindowEditor";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/base/input/input", () => ({ Input: ({ label, value, onChange, isDisabled, placeholder }: { label: string; value: string; onChange: (value: string) => void; isDisabled: boolean; placeholder: string }) => <label>{label}<input value={value} disabled={isDisabled} placeholder={placeholder} onChange={event => onChange(event.target.value)} /></label> }));
vi.mock("@/components/base/buttons/button", () => ({ Button: ({ children, disabled, onClick }: { children: React.ReactNode; disabled: boolean; onClick: () => void }) => <button disabled={disabled} onClick={onClick}>{children}</button> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("Codex context editor", () => {
  let container: HTMLDivElement; let root: Root;
  const save = vi.fn();
  beforeEach(() => { save.mockReset().mockResolvedValue(undefined); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = (block: string | null = null) => act(async () => root.render(<CodexContextWindowEditor settings={{ contextWindow: null, autoCompactTokenLimit: null, block }} reportedWindow={258_400} onSave={save} />));
  async function input(index: number, text: string) {
    const node = container.querySelectorAll("input")[index];
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, text); node.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  const click = (index = 0) => act(async () => container.querySelectorAll("button")[index].click());
  it("uses reported capacity only as placeholder and empty values restore defaults", async () => {
    await render(); const node = container.querySelector("input")!; expect(node.value).toBe(""); expect(node.placeholder).toBe("258.4");
    await click(); expect(save).toHaveBeenCalledWith(null, null);
  });
  it("validates each range and the threshold relationship", async () => {
    await render(); await input(0, "99"); await click(); expect(save).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("chat.codexContextRangeError");
    await input(0, "500"); await input(1, "600"); await click(); expect(save).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("chat.codexContextThresholdError");
    await input(1, "400"); await click(); expect(save).toHaveBeenCalledWith(500_000, 400_000);
  });
  it("retains draft on failure and does not report success", async () => {
    await render(); save.mockRejectedValueOnce(new Error("config_changed")); await input(0, "700"); await click();
    expect(container.querySelector("input")?.value).toBe("700"); expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("chat.codexContextSaveFailed");
  });
  it("resets both fields and blocks editing when overridden", async () => {
    await render(); await input(0, "700"); await click(1); expect(save).toHaveBeenCalledWith(null, null);
    await render("channel_override"); expect(container.querySelector("input")?.disabled).toBe(true);
    expect(container.textContent).toContain("chat.codexContextBlock_channel_override");
  });
});
