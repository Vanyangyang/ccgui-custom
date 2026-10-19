import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { SelfUpdateDetails } from "./SelfUpdateDetails";
import { useLiveUpdateStore, type LiveUpdateState } from "./live-update";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const active = { manifestSha256: "a".repeat(64), channel: "protected-custom" as const, releaseId: "auto-current", version: "1.1.1+protected.34", workerProtocol: 1, checkpointSchema: 1, schemaHash: "b".repeat(64), executable: "ccgui-next.exe" };
const changes = Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, changeId: `fix-${index}`, summary: `保留草稿并修复界面 ${index} 中文🙂`, sourceRoot: "G:/source" }));
const transaction = { id: "tx1", phase: "Committed" as const, candidate: active, previous: null };
const batch = { id: "b1", requestId: "r1", sourceRoot: "G:/source", phase: "Committed", changes, transactionId: "tx1", manifestSha256: active.manifestSha256 };
const initial = useLiveUpdateStore.getState();

describe("self-update change details", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async (overrides: Partial<LiveUpdateState> = {}) => {
    const state = { ...initial, support: "supported" as const, active, transaction, channel: { version: 1, ready: [], batch }, ...overrides };
    await act(async () => { root.render(<SelfUpdateDetails state={state} />); });
  };
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

  it("shows every registered change after commit, with the running release and verifiable identifiers", async () => {
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(i18n.t("statusbar.selfUpdateCommitted"));
    for (const change of changes) expect(container.textContent).toContain(change.summary);
    expect(container.querySelectorAll("li")).toHaveLength(8);
    expect(container.textContent).toContain("auto-current");
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("b1");
    expect(details.textContent).toContain("tx1");
    expect(details.textContent).toContain(active.manifestSha256);
  });

  it("keeps the last batch distinct from new ready and working changes", async () => {
    const queued = { ...changes[0], id: "q", summary: "下一次更新内容" };
    const working = { ...changes[0], id: "w", summary: "正在验证的改动" };
    await render({ channel: { version: 1, batch, ready: [queued], working: [working] } });
    expect(container.querySelector('[data-testid="self-update-batch"]')?.textContent).not.toContain(queued.summary);
    expect(container.textContent).toContain(i18n.t("settings.liveUpdateLatestChanges", { count: 8 }));
    expect(container.textContent).toContain(queued.summary);
    expect(container.textContent).toContain(working.summary);
  });

  it("shows the raw rollback reason alongside the version still active", async () => {
    await render({ active: { ...active, releaseId: "auto-previous", manifestSha256: "c".repeat(64) },
      transaction: { ...transaction, phase: "RolledBack", failureReason: "CandidateHealthTimeout" },
      channel: { version: 1, ready: [], batch: { ...batch, phase: "RolledBack", error: "CandidateHealthTimeout" } } });
    expect(container.textContent).toContain(i18n.t("statusbar.selfUpdateRolledBack"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("CandidateHealthTimeout");
    expect(container.textContent).toContain("auto-previous");
  });

  it("does not mark a committed batch applied when its active hash differs", async () => {
    await render({ active: { ...active, manifestSha256: "c".repeat(64) } });
    expect(container.textContent).toContain(i18n.t("settings.liveUpdateUnverifiedHint"));
    expect(container.textContent).not.toContain(i18n.t("statusbar.selfUpdateCommitted"));
  });

  it("does not attach a previous transaction to a new building batch", async () => {
    await render({ channel: { version: 1, ready: [], batch: { ...batch, id: "b2", phase: "Building", transactionId: null, manifestSha256: null } } });
    expect(container.textContent).toContain(i18n.t("statusbar.selfUpdateBuilding", { count: 8 }));
    expect(container.querySelector("details")?.textContent).not.toContain("tx1");
    expect(container.textContent).not.toContain(i18n.t("statusbar.selfUpdateCommitted"));
  });

  it("hides desktop update details on unsupported clients", async () => {
    await render({ support: "web" });
    expect(container.textContent).toBe("");
  });
});
