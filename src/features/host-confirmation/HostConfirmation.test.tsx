import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { HostConfirmation } from "./HostConfirmation";
import type { ConfirmationContent } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
export const content: ConfirmationContent = { title: "确认交接 🧭", message: "Review before sending", fields: [{ label: "模型", value: "fixture/model" }], sections: [{ title: "摘要", body: "# 标题\n\n中文 👩‍💻\n\n- item\n\n[link](javascript:alert(1)) ![image](https://example.com/image.png)\n\n<script>alert(1)</script>\n\n```ts\nconst x = 1\n```", markdown: true }], confirmLabel: "Confirm", dismissLabel: "Cancel", dark: false, language: "en" };
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
async function mount(respond = vi.fn(async (_accepted: boolean) => {})) {
  const el = document.createElement("div"); document.body.append(el); root = createRoot(el);
  await act(async () => root!.render(<HostConfirmation content={content} respond={respond} />));
  const button = (text: string) => [...el.querySelectorAll("button")].find(b => b.textContent === text)!;
  return { el, respond, button };
}
describe("host confirmation", () => {
  it("focuses cancellation; Escape denies and late interactions cannot answer twice", async () => {
    const f = await mount();
    expect(document.activeElement).toBe(f.button("Cancel"));
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => f.button("Confirm").click());
    expect(f.respond.mock.calls).toEqual([[false]]);
  });
  it("locks synchronous duplicate clicks and stays locked after success", async () => {
    let resolve!: () => void;
    const f = await mount(vi.fn(() => new Promise<void>(r => { resolve = r; })));
    await act(async () => { f.button("Confirm").click(); f.button("Confirm").click(); });
    expect(f.respond.mock.calls).toEqual([[true]]);
    await act(async () => resolve());
    expect(f.button("Confirm").disabled).toBe(true);
  });
  it("never retries a failed affirmative and allows cancellation", async () => {
    const respond = vi.fn(async (_accepted: boolean) => {}).mockRejectedValueOnce(new Error("unknown result"));
    const f = await mount(respond);
    await act(async () => f.button("Confirm").click());
    expect(f.el.querySelector('[role="alert"]')).not.toBeNull();
    expect(f.button("Confirm").disabled).toBe(true);
    await act(async () => f.button("Confirm").click());
    await act(async () => f.button("Cancel").click());
    expect(respond.mock.calls).toEqual([[true], [false]]);
  });
  it("keeps Unicode and useful Markdown but never loads images, HTML or active links", async () => {
    const f = await mount();
    const disclosure = f.el.querySelector<HTMLButtonElement>('[aria-expanded]')!;
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await act(async () => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(f.el.querySelector("h1")?.textContent).toContain("🧭");
    expect(f.el.textContent).toContain("中文 👩‍💻");
    expect(f.el.querySelector("pre code")?.textContent).toContain("const x = 1");
    expect(f.el.querySelector("img, a, script")).toBeNull();
  });
});
