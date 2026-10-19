import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { AddMenu } from "./add-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function rowByText(...texts: string[]): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => texts.some((text) => b.textContent?.includes(text)),
  ) ?? null;
}

describe("AddMenu rows", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function openMenu(ui: React.ReactElement) {
    await act(async () => {
      root.render(ui);
    });
    const trigger = container.querySelector<HTMLButtonElement>("button");
    expect(trigger).toBeTruthy();
    await act(async () => {
      trigger!.click();
    });
  }

  it("fires onPickFiles when the files row is clicked", async () => {
    const onPickFiles = vi.fn();
    await openMenu(<AddMenu onPickFiles={onPickFiles} />);
    const row = rowByText("Files and folders", "文件和文件夹");
    expect(row).toBeTruthy();
    expect(row!.disabled).toBe(false);
    await act(async () => {
      row!.click();
    });
    expect(onPickFiles).toHaveBeenCalledTimes(1);
  });

  it("keeps the files row disabled without a handler", async () => {
    await openMenu(<AddMenu />);
    const row = rowByText("Files and folders", "文件和文件夹");
    expect(row).toBeTruthy();
    expect(row!.disabled).toBe(true);
  });
  it("fires onPickSkills when the skills row is clicked", async () => {
    const onPickSkills = vi.fn();
    await openMenu(<AddMenu onPickSkills={onPickSkills} />);
    const row = rowByText("Skills", "技能");
    expect(row).toBeTruthy();
    expect(row!.disabled).toBe(false);
    await act(async () => {
      row!.click();
    });
    expect(onPickSkills).toHaveBeenCalledTimes(1);
  });

  it("keeps the skills row disabled without a handler", async () => {
    await openMenu(<AddMenu />);
    const row = rowByText("Skills", "技能");
    expect(row).toBeTruthy();
    expect(row!.disabled).toBe(true);
  });

  it("no longer renders the goal and plan rows", async () => {
    await openMenu(<AddMenu onPickFiles={vi.fn()} onPickSkills={vi.fn()} />);
    expect(rowByText("Goal", "目标")).toBeNull();
    expect(rowByText("Plan mode", "计划模式")).toBeNull();
  });
});
