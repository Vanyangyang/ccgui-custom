import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { SelfUpdateStatusChip, formatLiveUpdateBlocker } from "./SelfUpdateStatusChip";
import { SelfUpdateDetails } from "./SelfUpdateDetails";
import { useLiveUpdateStore } from "./live-update";
import { OnboardingTourHost } from "@/features/onboarding/OnboardingTour";
import { useOnboardingStore } from "@/features/onboarding/store";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("self-update status action", () => {
  let container: HTMLDivElement;
  let root: Root;
  const initial = useLiveUpdateStore.getState();
  const requestUpdate = vi.fn(async () => {});
  const change = { id: "c1", changeId: "fix", summary: "Verified fix", sourceRoot: "G:/source" };
  const active = { manifestSha256: "a".repeat(64), channel: "protected-custom" as const, releaseId: "auto-one", version: "1.1.1+protected.34", workerProtocol: 1, checkpointSchema: 1, schemaHash: "b".repeat(64), executable: "ccgui-next.exe" };
  const transaction = { id: "tx1", phase: "Committed" as const, candidate: active, previous: null };
  const batch = { id: "b1", requestId: "r1", sourceRoot: "G:/source", phase: "Committed", changes: [change], transactionId: "tx1", manifestSha256: active.manifestSha256 };
  beforeEach(async () => {
    requestUpdate.mockClear();
    useLiveUpdateStore.setState({ ...initial, support: "supported", channel: { version: 1, ready: [change] }, requestUpdate });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root.render(<SelfUpdateStatusChip />); });
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); }); container.remove(); useLiveUpdateStore.setState(initial, true);
    useOnboardingStore.setState({ open: false });
    vi.restoreAllMocks();
  });
  const button = () => container.querySelector<HTMLButtonElement>("button")!;

  it.each(["zh", "en"])("explains plugin close failures without hiding their saving error (%s)", language => {
    const t = i18n.getFixedT(language);
    expect(formatLiveUpdateBlocker(t, { reason: "plugin-update-close-failed", detail: "Draft write failed" }))
      .toBe(`${t("settings.liveUpdateBlockers.pluginUpdateClose")} · Draft write failed`);
    expect(formatLiveUpdateBlocker(t, { reason: "plugin-update-close-timeout" }))
      .toBe(t("settings.liveUpdateBlockers.pluginUpdateCloseTimeout"));
  });

  it.each(["zh", "en"])("shows individual blockers and observed states in tooltip and details (%s)", async language => {
    const t = i18n.getFixedT(language);
    const blockers = [
      { reason: "legacy-runs", runId: "run-a", engine: "codex", sessionId: "session-a", state: "registered" as const },
      { reason: "legacy-runs", runId: "run-b", state: "reader-finished" as const },
      { reason: "legacy-runs", state: "registry-unavailable" as const },
    ];
    for (const blocker of blockers) {
      const label = formatLiveUpdateBlocker(t, blocker);
      expect(label).toContain(t(`settings.liveUpdateBlockerStates.${blocker.state}`));
      if (blocker.runId) expect(label).toContain(blocker.runId);
      if (blocker.sessionId) expect(label).toContain(blocker.sessionId);
      expect(label).not.toContain("settings.liveUpdate");
    }
    await act(async () => { useLiveUpdateStore.setState({
      transaction: { ...transaction, phase: "Preparing" }, stage: "waiting", blockers,
    }); });
    expect(button().title).toContain("run-a");
    expect(button().title).toContain("run-b");
    expect(button().title).toContain("session-a");
    await act(async () => { root.render(<SelfUpdateDetails state={useLiveUpdateStore.getState()} />); });
    const list = container.querySelector('[data-testid="self-update-blockers"]');
    expect(list?.querySelectorAll("li")).toHaveLength(3);
    expect(list?.textContent).toContain("run-a");
    expect(list?.textContent).toContain("run-b");
    expect(list?.textContent).toContain(i18n.t("settings.liveUpdateBlockerStates.reader-finished"));
  });

  async function guide(step: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { top: 600, left: this.dataset.onboardingTarget === "self-update-details" ? 200 : 100, width: 40, height: 24 } as DOMRect;
    });
    await act(async () => {
      useOnboardingStore.getState().openTour("selfUpdate");
      for (let index = 0; index < step; index++) useOnboardingStore.getState().nextStep();
      root.render(<><SelfUpdateStatusChip /><OnboardingTourHost /></>);
    });
  }

  it("guides review through the real bottom-right list button without requesting an update", async () => {
    await guide(0);
    expect(document.querySelector<HTMLElement>('[data-testid="onboarding-spotlight-ring"]')?.style.left).toBe("194px");
    const action = document.querySelector<HTMLButtonElement>('[data-testid="onboarding-step-action-self-update-review"]')!;
    await act(async () => action.click());
    expect(window.location.hash).toBe("#/settings?page=update");
    expect(useOnboardingStore.getState().open).toBe(false);
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("focuses the real self-update button and requires an explicit click to request changes", async () => {
    await guide(1);
    expect(document.querySelector<HTMLElement>('[data-testid="onboarding-spotlight-ring"]')?.style.left).toBe("94px");
    const action = document.querySelector<HTMLButtonElement>('[data-testid="onboarding-step-action-self-update-request"]')!;
    await act(async () => action.click());
    expect(document.activeElement).toBe(button());
    expect(requestUpdate).not.toHaveBeenCalled();
    await act(async () => button().click());
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("keeps the guided in-progress entry available for details without duplicating the request", async () => {
    await act(async () => useLiveUpdateStore.setState({ channel: { version: 1, ready: [change],
      updateRequest: { id: "r1", requestId: "r1", sourceRoot: "G:/source", targetChangeIds: ["fix"], waitingFor: ["fix"] } } }));
    await guide(1);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="onboarding-step-action-self-update-request"]')!.click());
    await act(async () => button().click());
    expect(window.location.hash).toBe("#/settings?page=update");
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("requests real registered changes without navigating away", async () => {
    const hash = window.location.hash;
    expect(button().textContent).toContain(i18n.t("statusbar.selfUpdateActionCount", { count: 1 }));
    expect(button().title).toContain("Verified fix");
    await act(async () => { button().click(); });
    expect(requestUpdate).toHaveBeenCalledOnce(); expect(window.location.hash).toBe(hash);
  });

  it("keeps the empty action visible with a reason and hides unsupported clients", async () => {
    await act(async () => { useLiveUpdateStore.setState({ channel: null }); });
    expect(button().disabled).toBe(true); expect(button().title).toBe(i18n.t("statusbar.selfUpdateEmpty"));
    for (const support of ["web", "not-custom", "unsupported", "checking"] as const) {
      await act(async () => { useLiveUpdateStore.setState({ support }); });
      expect(container.querySelector("button")).toBeNull();
    }
  });

  it("disables submitting and retains failed request details for retry", async () => {
    await act(async () => { useLiveUpdateStore.setState({ requesting: true }); });
    expect(button().disabled).toBe(true); expect(button().getAttribute("aria-busy")).toBe("true");
    await act(async () => { button().click(); }); expect(requestUpdate).not.toHaveBeenCalled();
    await act(async () => { useLiveUpdateStore.setState({ requesting: false, requestError: "Could not persist request" }); });
    expect(button().textContent).toContain(i18n.t("statusbar.selfUpdateRequestFailed"));
    expect(button().title).toContain("Could not persist request"); expect(button().disabled).toBe(false);
    await act(async () => { button().click(); }); expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("opens active request details instead of creating another request", async () => {
    await act(async () => { useLiveUpdateStore.setState({ channel: { version: 1, ready: [change],
      updateRequest: { id: "r1", requestId: "r1", sourceRoot: "G:/source", targetChangeIds: ["fix", "working"], waitingFor: ["working"] } } }); });
    expect(button().textContent).toContain(i18n.t("statusbar.selfUpdateWaitingTasks", { done: 1, total: 2 }));
    await act(async () => { button().click(); });
    expect(window.location.hash).toBe("#/settings?page=update"); expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("keeps the committed result and its changes reachable after the queue drains", async () => {
    await act(async () => { useLiveUpdateStore.setState({ active, transaction, channel: { version: 1, ready: [], batch } }); });
    expect(button().disabled).toBe(false);
    expect(button().dataset.selfUpdateKind).toBe("committed");
    expect(button().textContent).toContain(i18n.t("statusbar.selfUpdateCommitted"));
    expect(button().title).toContain("auto-one");
    expect(button().title).toContain("Verified fix");
    await act(async () => { button().click(); });
    expect(window.location.hash).toBe("#/settings?page=update");
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it.each(["active-mismatch", "missing-active", "different-transaction"])("does not claim success for %s", async (reason) => {
    await act(async () => { useLiveUpdateStore.setState({
      active: reason === "missing-active" ? null : reason === "active-mismatch" ? { ...active, manifestSha256: "c".repeat(64) } : active,
      transaction: reason === "different-transaction" ? { ...transaction, id: "old-tx" } : transaction,
      channel: { version: 1, ready: [], batch },
    }); });
    expect(button().dataset.selfUpdateKind).toBe("unverified");
    expect(button().disabled).toBe(false);
    expect(button().textContent).not.toContain(i18n.t("statusbar.selfUpdateCommitted"));
  });

  it("shows rollback with the original reason and the version still running", async () => {
    await act(async () => { useLiveUpdateStore.setState({
      active: { ...active, releaseId: "auto-previous", manifestSha256: "c".repeat(64) },
      transaction: { ...transaction, phase: "RolledBack", failureReason: "CandidateHealthTimeout" },
      channel: { version: 1, ready: [], batch: { ...batch, phase: "RolledBack", error: "CandidateHealthTimeout" } },
      stage: "error", errorCode: "previousFailed", error: "CandidateHealthTimeout",
    }); });
    expect(button().dataset.selfUpdateKind).toBe("rolled-back");
    expect(button().title).toContain("CandidateHealthTimeout");
    expect(button().title).toContain("auto-previous");
    expect(button().disabled).toBe(false);
  });

  it("allows inspecting queued changes without submitting them", async () => {
    await act(async () => { useLiveUpdateStore.setState({ active, transaction, channel: { version: 1, ready: [change], batch } }); });
    const details = container.querySelector<HTMLButtonElement>('[data-testid="statusbar-self-update-details"]');
    expect(details).not.toBeNull();
    await act(async () => { details!.click(); });
    expect(window.location.hash).toBe("#/settings?page=update");
    expect(requestUpdate).not.toHaveBeenCalled();
    await act(async () => { button().click(); });
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("keeps a persisted request visible before its batch freezes", async () => {
    await act(async () => { useLiveUpdateStore.setState({ channel: { version: 1, ready: [],
      updateRequest: { id: "r1", requestId: "r1", sourceRoot: "G:/source", targetChangeIds: ["fix"], waitingFor: [] } } }); });
    expect(button().textContent).toContain(i18n.t("statusbar.selfUpdateRequested"));
    expect(button().disabled).toBe(false);
    await act(async () => { button().click(); });
    expect(requestUpdate).not.toHaveBeenCalled();
  });
});
