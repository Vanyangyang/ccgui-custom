import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { PerformanceDiagnosticsSection, PerformanceDiagnosticsDialog } from "./PerformanceDiagnostics";

const mocks = vi.hoisted(() => ({ native: vi.fn(), writeText: vi.fn(), export: vi.fn(), toggle: vi.fn(), sync: vi.fn(), enabled: true as boolean | null, listeners: new Set<() => void>(), reactScanOn: false, setReactScan: vi.fn() }));
vi.mock("@/lib/performance-export", () => ({ exportPerformanceReport: mocks.export }));
vi.mock("@/lib/react-scan", () => ({
  isReactScanEnabled: () => mocks.reactScanOn,
  setReactScanEnabled: mocks.setReactScan,
}));
vi.mock("@/lib/performance-preference", () => ({
  getPerformancePreference: () => mocks.enabled,
  subscribePerformancePreference: (callback: () => void) => { mocks.listeners.add(callback); return () => mocks.listeners.delete(callback); },
  setPerformanceEnabled: mocks.toggle,
  synchronizePerformancePreference: mocks.sync,
}));
vi.mock("@/lib/ipc", () => ({ ipc: { performanceDiagnostics: mocks.native } }));
vi.mock("@/lib/platform", () => ({ getAppVersion: async () => "1.0.8" }));
vi.mock("@/components/dialogs", () => ({ ModalShell: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage("zh");
  mocks.native.mockReset().mockResolvedValue({ samples: [], cpuUnit: "one-core-percent" });
  mocks.enabled = true;
  mocks.reactScanOn = false;
  mocks.setReactScan.mockReset().mockResolvedValue(undefined);
  mocks.sync.mockReset().mockResolvedValue(undefined);
  mocks.export.mockReset().mockResolvedValue("saved");
  mocks.toggle.mockReset().mockImplementation(async (enabled: boolean) => { mocks.enabled = enabled; mocks.listeners.forEach((callback) => callback()); });
  mocks.writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.writeText } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => root.render(<PerformanceDiagnosticsDialog onClose={() => {}} />));
}

function copyButton() {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("复制诊断摘要"))!;
}

describe("performance diagnostic feedback", () => {
  it("retries an unknown preference when the panel opens", async () => {
    mocks.enabled = null;
    mocks.sync.mockImplementation(async () => { mocks.enabled = true; mocks.listeners.forEach((callback) => callback()); });
    await render();
    expect(mocks.sync).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[role="switch"]')!.disabled).toBe(false);
  });
  it("exports a complete file separately from the short preview", async () => {
    await render();
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("导出完整诊断"))!;
    await act(async () => button.click());
    expect(mocks.export).toHaveBeenCalledOnce();
    expect(mocks.export.mock.calls[0][0].renderer.samples).toBeDefined();
    expect(JSON.parse(container.querySelector("textarea")!.value).kind).toBe("performance-summary");
    expect(container.textContent).toContain("已保存");
  });

  it("does not claim saved after cancellation or failed export", async () => {
    mocks.export.mockResolvedValueOnce("cancelled").mockRejectedValueOnce(new Error("disk error"));
    await render();
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("导出完整诊断"))!;
    await act(async () => button.click());
    expect(container.textContent).not.toContain("已保存");
    await act(async () => button.click());
    expect(container.textContent).toContain("导出失败");
    expect(container.querySelector("textarea")!.value).not.toBe("");
    expect(container.textContent).not.toContain("已保存");
  });

  it("clears the preview and stops exports after turning off", async () => {
    await render();
    await act(async () => container.querySelector<HTMLInputElement>('input[role="switch"]')!.click());
    expect(mocks.toggle).toHaveBeenCalledWith(false);
    expect(container.querySelector("textarea")!.value).toBe("");
    expect(copyButton().disabled).toBe(true);
    expect(container.textContent).toContain("已关闭");
  });

  it("does not show stale copy success after another window disables diagnostics", async () => {
    let resolve!: () => void;
    mocks.writeText.mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    await render();
    await act(async () => copyButton().click());
    await act(async () => { mocks.enabled = false; mocks.listeners.forEach((callback) => callback()); });
    await act(async () => resolve());
    expect(container.querySelector("textarea")!.value).toBe("");
    expect(container.textContent).not.toContain("已复制");
  });

  it("shows a save failure without claiming monitoring was disabled", async () => {
    mocks.toggle.mockRejectedValue(new Error("save failed"));
    await render();
    await act(async () => container.querySelector<HTMLInputElement>('input[role="switch"]')!.click());
    expect(container.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true);
    expect(container.textContent).toContain("设置保存失败");
  });
  it("generates a selectable report and copies only after user action", async () => {
    await render();
    expect(mocks.writeText).not.toHaveBeenCalled();
    const text = container.querySelector("textarea")!;
    expect(JSON.parse(text.value).version).toBe("1.0.8");
    await act(async () => copyButton().click());
    expect(mocks.writeText).toHaveBeenCalledWith(text.value);
    expect(container.textContent).toContain("已复制");
  });

  it("keeps text available when native sampling or clipboard is unavailable", async () => {
    mocks.native.mockRejectedValue(new Error("secret source"));
    mocks.writeText.mockRejectedValue(new Error("permission denied"));
    await render();
    expect(container.textContent).toContain("未取得原生采样");
    expect(container.querySelector("textarea")!.value).not.toContain("secret source");
    await act(async () => copyButton().click());
    expect(container.textContent).toContain("请手动选择并复制日志文本");
    expect(container.textContent).not.toContain("已复制");
  });

  it("opens the dialog from the standalone 性能诊断 settings section", async () => {
    await act(async () => root.render(<PerformanceDiagnosticsSection />));
    const open = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("查看性能诊断"),
    )!;
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => open.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("keeps the react-scan panel off by default and enables it on demand", async () => {
    await act(async () => root.render(<PerformanceDiagnosticsSection />));
    const renderPanelSwitch = container.querySelector<HTMLInputElement>(
      'input[role="switch"][aria-label*="react-scan"]',
    )!;
    expect(renderPanelSwitch.checked).toBe(false);
    expect(mocks.setReactScan).not.toHaveBeenCalled();
    await act(async () => renderPanelSwitch.click());
    expect(mocks.setReactScan).toHaveBeenCalledWith(true);
    expect(renderPanelSwitch.checked).toBe(true);
  });
});
