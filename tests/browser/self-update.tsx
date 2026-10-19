// Synthetic state only: no host subscription, native IPC or update request.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { SelfUpdateStatusChip } from "../../src/features/update/SelfUpdateStatusChip";
import { SelfUpdateDetails } from "../../src/features/update/SelfUpdateDetails";
import { useLiveUpdateStore, type LiveUpdateState } from "../../src/features/update/live-update";
import i18n from "../../src/lib/i18n";
import "../../src/index.css";

const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh");
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const active = { manifestSha256: "a".repeat(64), channel: "protected-custom" as const, releaseId: "auto-example", version: "1.1.1+protected.34", workerProtocol: 1, checkpointSchema: 1, schemaHash: "b".repeat(64), executable: "ccgui-next.exe" };
const changes = Array.from({ length: 8 }, (_, index) => ({ id: `change-${index}`, changeId: `verified-fix-${index}`, summary: `修复示例 ${index + 1}：更新后保留聊天标签、中文🙂草稿及历史；完成状态可查看完整改动说明。`, sourceRoot: "C:/fixture" }));
const transaction = { id: "fixture-transaction", phase: "Committed" as const, candidate: active, previous: null };
const batch = { id: "fixture-batch", requestId: "fixture-request", sourceRoot: "C:/fixture", phase: "Committed", changes, transactionId: transaction.id, manifestSha256: active.manifestSha256 };
const base = { ...useLiveUpdateStore.getState(), support: "supported" as const, active, transaction, channel: { version: 1, ready: [], batch }, requestUpdate: async () => { throw new Error("Synthetic fixture must not request an update"); } };
function scenario(mode: string): Partial<LiveUpdateState> {
  if (mode === "rollback") return { active: { ...active, releaseId: "auto-previous", manifestSha256: "c".repeat(64) }, transaction: { ...transaction, phase: "RolledBack", failureReason: "CandidateHealthTimeout" }, channel: { version: 1, ready: [], batch: { ...batch, phase: "RolledBack", error: "CandidateHealthTimeout" } } };
  if (mode === "unverified") return { active: { ...active, manifestSha256: "c".repeat(64) } };
  if (mode === "building") return { channel: { version: 1, ready: [], batch: { ...batch, phase: "Building", transactionId: null, manifestSha256: null } } };
  if (mode === "queued") return { channel: { version: 1, ready: [{ ...changes[0], id: "next", summary: "下一批待更新内容" }], batch } };
  return {};
}
useLiveUpdateStore.setState({ ...base, ...scenario(params.get("mode") ?? "committed") });
function Fixture() {
  const state = useLiveUpdateStore();
  useEffect(() => {
    let disposed = false;
    void document.fonts.ready.then(() => {
      if (disposed) return;
      const details = document.querySelector("details");
      if (details && params.get("expanded") === "1") details.open = true;
      const frames = [...document.querySelectorAll<HTMLElement>('[data-testid="self-update-details"], [data-testid="fixture-statusbar"]')];
      document.documentElement.dataset.fixtureResult = frames.every(frame => frame.scrollWidth <= frame.clientWidth + 1) ? "PASS" : "FAIL";
    });
    return () => { disposed = true; };
  }, []);
  return <main className="min-h-dvh bg-background-primary-default p-3 text-text-primary">
    <section style={{ width: Number(params.get("width") ?? 680), maxWidth: "100%" }} className="mx-auto min-w-0 rounded-lg border border-border-secondary">
      <div className="p-3"><h1 className="mb-3 text-heading-3">{i18n.t("settings.liveUpdateDetailsTitle")}</h1><SelfUpdateDetails state={state} /></div>
      <footer className="sticky bottom-0 flex h-7 items-center justify-end gap-1 border-t border-border-secondary bg-background-primary-default px-2 text-caption-1-regular" data-testid="fixture-statusbar">
        <span>v1.1.1+protected.34</span><SelfUpdateStatusChip />
      </footer>
    </section>
  </main>;
}
createRoot(document.getElementById("fixture")!).render(<Fixture />);
