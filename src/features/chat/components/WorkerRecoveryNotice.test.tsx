import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { invoke, listen } from "@/lib/transport";
import { WorkerRecoveryNotice } from "./WorkerRecoveryNotice";

vi.mock("@/lib/transport", () => ({ invoke: vi.fn(), listen: vi.fn() }));
let node: HTMLDivElement, root: Root;
let notify: (event: { payload: { code: string } }) => void;
const stop = vi.fn();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.resetAllMocks();
  vi.mocked(invoke).mockResolvedValue([]);
  vi.mocked(listen).mockImplementation(async (_name, callback) => {
    notify = callback as typeof notify;
    return stop;
  });
  await i18n.changeLanguage("zh");
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });

it.each(["zh", "en"])("reports a failure that preceded the webview in %s and can be dismissed", async language => {
  await i18n.changeLanguage(language);
  vi.mocked(invoke).mockResolvedValue([{ recoveryError: "worker-recovery-failed" }]);
  await act(async () => root.render(<WorkerRecoveryNotice />));
  expect(invoke).toHaveBeenCalledWith("runtime_worker_sources");
  expect(node.querySelector('[role="alert"]')?.textContent).toContain(i18n.t("workerRecovery.message"));
  await act(async () => node.querySelector("button")!.click());
  expect(node.querySelector('[role="alert"]')).toBeNull();
});

it("keeps healthy startup quiet and reports a later recovery error", async () => {
  await act(async () => root.render(<WorkerRecoveryNotice />));
  expect(node.textContent).toBe("");
  await act(async () => notify({ payload: { code: "unattached-source" } }));
  expect(node.textContent).toBe("");
  await act(async () => notify({ payload: { code: "worker-recovery-failed" } }));
  expect(node.textContent).toContain(i18n.t("workerRecovery.title"));
});

it("releases a late listener and ignores status arriving after unmount", async () => {
  let resolveListener!: (unlisten: () => void) => void;
  let resolveSources!: (sources: unknown[]) => void;
  vi.mocked(listen).mockReturnValue(new Promise(resolve => { resolveListener = resolve; }));
  vi.mocked(invoke).mockReturnValue(new Promise(resolve => { resolveSources = resolve; }));
  await act(async () => root.render(<WorkerRecoveryNotice />));
  await act(async () => root.render(null));
  await act(async () => {
    resolveListener(stop);
    resolveSources([{ recoveryError: "worker-recovery-failed" }]);
  });
  expect(stop).toHaveBeenCalledOnce();
  expect(node.textContent).toBe("");
});
