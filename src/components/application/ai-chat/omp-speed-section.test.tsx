import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OmpSpeedSection } from "./omp-speed-section";
import { supportsOmpFastMode } from "@/lib/omp-service-tier";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let node: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });
it("toggles Fast on with an accessible lightning button", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<OmpSpeedSection model="openai-codex/gpt-5.4" value={null} onChange={save} />));
  const button = node.querySelector("button")!;
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(node.querySelector("select")).toBeNull();
  await act(async () => button.click());
  expect(save).toHaveBeenCalledWith("priority");
});
it("hides Fast for other models and restores the preference only on Codex", async () => {
  await act(async () => root.render(<OmpSpeedSection model="anthropic/claude" value="priority" onChange={vi.fn()} />));
  expect(node.querySelector("button")).toBeNull();
  for (const model of ["", "gpt-5.4", "custom/gpt-5.4", "openai/", "openai/gpt-5.4", "openai-codex/"]) expect(supportsOmpFastMode(model)).toBe(false);
  expect(supportsOmpFastMode("openai-codex/gpt-5.4")).toBe(true);
  await act(async () => root.render(<OmpSpeedSection model="openai-codex/gpt-5.4" value="priority" onChange={vi.fn()} />));
  expect(node.querySelector("button")!.getAttribute("aria-pressed")).toBe("true");

});
it("reports save failure and retains the previous selection", async () => {
  await act(async () => root.render(<OmpSpeedSection model="openai-codex/gpt-5.4" value="default" onChange={vi.fn().mockRejectedValue(new Error("disk"))} />));
  await act(async () => node.querySelector("button")!.click());
  expect(node.querySelector("button")!.getAttribute("aria-pressed")).toBe("false");
  expect(node.querySelector('[role="alert"]')!.textContent).toBe("chat.ompSpeedSaveError");
});
it("saving blocks duplicate changes and supports explicit off and inheritance", async () => {
  let resolve!: () => void;
  const save = vi.fn(() => new Promise<void>(r => { resolve = r; }));
  await act(async () => root.render(<OmpSpeedSection model="openai-codex/gpt-5.4" value="priority" onChange={save} />));
  expect(node.querySelector("button")!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => node.querySelector("button")!.click());
  expect(save).toHaveBeenCalledWith("default");
  expect(node.querySelector("button")!.disabled).toBe(true);
  await act(async () => resolve());
  await act(async () => node.querySelectorAll("button")[1].click());
  expect(save).toHaveBeenLastCalledWith(null);
  await act(async () => resolve());
});
