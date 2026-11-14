import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecentThreadList } from "./repo-tree";
import { groupLeaderThreads } from "@/features/leader/tree";
import type { LeaderBranch } from "@/features/leader/types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });

function threads(suffix: string) {
  const old: LeaderBranch = {
    id: `old-${suffix}`, parentEngine: "codex", parentSessionId: `root-${suffix}`, workspacePath: "G:/Plan",
    engine: "codex", sessionId: `old-${suffix}`, title: "Old task", task: "", model: null, effort: null, runId: null,
    state: "handed_off", createdAt: 1, updatedAt: 1, lastActivityAt: 1, deadlineAt: 2, expired: true,
    result: "", resultTruncated: false, error: null,
    handoffTo: { branchId: `next-${suffix}`, requestId: "r", operationId: "o", payloadFingerprint: "f" },
  };
  const next: LeaderBranch = { ...old, id: `next-${suffix}`, sessionId: `next-${suffix}`, title: "Next task", state: "running", handoffTo: undefined };
  return groupLeaderThreads([], { leaders: [], branches: [old, next] }, "G:/Plan");
}
const historyButton = () => [...node.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("leader.handoffHistory"));

it("keeps handoff history collapsed while the successor is selected and preserves both selection callbacks", async () => {
  const onThreadSelect = vi.fn();
  await act(async () => root.render(<RecentThreadList threads={threads("collapse")} activeThreadId="codex/next-collapse" onThreadSelect={onThreadSelect} />));
  expect(historyButton()?.getAttribute("aria-expanded")).toBe("false");
  expect(node.textContent).not.toContain("Old task");
  expect(node.textContent).toContain("Next task");
  expect(historyButton()?.tabIndex).toBe(0);
  await act(async () => historyButton()!.click());
  expect(historyButton()?.getAttribute("aria-expanded")).toBe("true");
  expect(node.textContent).toContain("leader.state.handed_off");
  const select = (label: string) => [...node.querySelectorAll<HTMLButtonElement>("button[data-thread-select]")].find((button) => button.textContent?.includes(label))!;
  await act(async () => select("Old task").click());
  await act(async () => select("Next task").click());
  expect(onThreadSelect.mock.calls).toEqual([["codex/old-collapse"], ["codex/next-collapse"]]);
  expect(select("Old task").closest(".group")?.textContent).not.toContain("leader.ttlExpiredShort");
});

it("automatically reveals selected historical sessions", async () => {
  await act(async () => root.render(<RecentThreadList threads={threads("reveal")} activeThreadId="codex/old-reveal" />));
  expect(historyButton()?.getAttribute("aria-expanded")).toBe("true");
  const selected = node.querySelector<HTMLButtonElement>('button[aria-current="page"]');
  expect(selected?.textContent).toContain("Old task");
  expect(selected?.disabled).toBe(false);
});
