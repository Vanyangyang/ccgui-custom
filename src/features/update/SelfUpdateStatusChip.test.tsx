import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { SelfUpdateStatusChip, formatLiveUpdateBlocker } from "./SelfUpdateStatusChip";
import { SelfUpdateDetails } from "./SelfUpdateDetails";
import { LiveUpdateSection } from "@/features/settings/LiveUpdateSection";
import { useLiveUpdateStore } from "./live-update";
import { OnboardingTourHost } from "@/features/onboarding/OnboardingTour";
import { useOnboardingStore } from "@/features/onboarding/store";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("self-update status action", () => {
  let container: HTMLDivElement;
  let root: Root;
  const initial = useLiveUpdateStore.getState();
  const initialLanguage = i18n.language;
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
    await i18n.changeLanguage(initialLanguage);
    vi.restoreAllMocks();
  });
  const button = () => container.querySelector<HTMLButtonElement>("button")!;

  it.each(["zh", "en"])("explains plugin close failures without hiding their saving error (%s)", language => {
    const t = i18n.getFixedT(language);
    expect(formatLiveUpdateBlocker(t, { reason: "plugin-update-close-failed", detail: "Draft write failed" }))
      .toBe(`${t("settings.liveUpdateBlockers.pluginUpdateClose")} · Draft write failed`);
    expect(formatLiveUpdateBlocker(t, { reason: "plugin-update-close-timeout" }))
      .toBe(t("settings.liveUpdateBlockers.pluginUpdateCloseTimeout"));
    expect(formatLiveUpdateBlocker(t, { reason: "plugin-window-unconfirmed-edits" }))
      .toBe(t("settings.liveUpdateBlockers.pluginWindowUnconfirmedEdits"));
  });

  it("explains the paused switch and offers an explicit retry rather than promising automatic continuation", async () => {
    const retrySwitch = vi.fn(async () => {});
    await act(async () => useLiveUpdateStore.setState({
      transaction: { ...transaction, phase: "Preparing" }, stage: "waiting", channel: { version: 1, ready: [] },
      blockers: [{ participant: "plugin-update-close", reason: "plugin-window-unconfirmed-edits" }], retrySwitch,
    }));
    expect(button().title).toContain(i18n.t("settings.liveUpdateRetryReasons"));
    expect(button().title).not.toContain(i18n.t("settings.liveUpdateWaitingReasons"));
    await act(async () => root.render(<LiveUpdateSection />));
    expect(container.textContent).toContain(i18n.t("settings.liveUpdateBlockers.pluginWindowUnconfirmedEdits"));
    const retry = [...container.querySelectorAll("button")].find(item => item.textContent?.includes(i18n.t("settings.liveUpdateRetrySwitch")));
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(retrySwitch).toHaveBeenCalledOnce();
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

  it.each(["zh", "en"])("explains an aborted schema mismatch as a failed update (%s)", async language => {
    await act(async () => {
      await i18n.changeLanguage(language);
      useLiveUpdateStore.setState({ active, transaction: null, stage: "idle",
        channel: { version: 1, ready: [], batch: { ...batch, phase: "Aborted", error: "database schema hash mismatch" } },
      });
    });
    expect(button().dataset.selfUpdateKind).toBe("error");
    expect(button().textContent).toContain(i18n.t("statusbar.selfUpdateFailed"));
    expect(button().title).toContain(i18n.t("settings.liveUpdateSchemaMismatchHint"));
    expect(button().title).toContain(language === "zh"
      ? "请先确认安装包支持从当前版本升级" : "First confirm that the installer supports upgrading from your current version.");
    expect(button().title).toContain(language === "zh" ? "兼容的完整安装包" : "a compatible full installer");
    expect(button().title).not.toContain("database schema hash mismatch");
    await act(async () => { root.render(<SelfUpdateDetails state={useLiveUpdateStore.getState()} />); });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(i18n.t("statusbar.selfUpdateFailed"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(i18n.t("settings.liveUpdateSchemaMismatchHint"));
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["Aborted", undefined, "aborted"],
    ["Aborted", "User cancelled", "aborted"],
    ["Aborted", "database schema hash mismatch: unexpected suffix", "aborted"],
    ["Failed", "Unknown build failure", "error"],
  ])("preserves %s results and unrecognized reasons (%s)", async (phase, error, kind) => {
    await act(async () => useLiveUpdateStore.setState({ transaction: null, stage: "idle",
      channel: { version: 1, ready: [], batch: { ...batch, phase: phase!, error } },
    }));
    expect(button().dataset.selfUpdateKind).toBe(kind);
    expect(button().title).not.toContain(i18n.t("settings.liveUpdateSchemaMismatchHint"));
    if (error) expect(button().title).toContain(error);
    await act(async () => { root.render(<SelfUpdateDetails state={useLiveUpdateStore.getState()} />); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(error);
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
