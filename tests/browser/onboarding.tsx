import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OnboardingEntryButton, OnboardingTourHost } from "@/features/onboarding/OnboardingTour";
import { ONBOARDING_TOPICS, useOnboardingStore } from "@/features/onboarding/store";
import { SidechatToggle } from "@/features/sidechat/SidechatToggle";
import { useSidechatStore } from "@/features/sidechat/store";
import { sessionKey } from "@/features/chat/store";
import { SelfUpdateStatusChip } from "@/features/update/SelfUpdateStatusChip";
import { useLiveUpdateStore } from "@/features/update/live-update";
import i18n from "@/lib/i18n";
import "@/index.css";

const params = new URLSearchParams(location.search);
await i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh");
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const active = { engine: "codex" as const, sessionId: "onboarding-fixture", workspacePath: "C:/fixture" };
const key = sessionKey(active.engine, active.sessionId, active.workspacePath);
const hasTarget = params.get("target") !== "missing";
useLiveUpdateStore.setState({ support: "supported", stage: "idle", channel: {
  version: 1,
  ready: [{ id: "guide-change", changeId: "guide", summary: "示例待更新改动 / Example pending change", sourceRoot: "C:/fixture" }],
  ...(params.get("update") === "busy" ? { updateRequest: { id: "guide-request", requestId: "guide-request", sourceRoot: "C:/fixture", targetChangeIds: ["guide"], waitingFor: ["guide"] } } : {}),
} });
useOnboardingStore.getState().openTour(ONBOARDING_TOPICS.find(topic => topic === params.get("topic")) ?? "sidechat");

function Fixture() {
  const open = useSidechatStore(s => s.sidechatBySession[key]?.open);
  const [route, setRoute] = useState(location.hash);
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [buildClicks, setBuildClicks] = useState(0);
  const [updateRequests, setUpdateRequests] = useState(0);
  useEffect(() => {
    useLiveUpdateStore.setState({ requestUpdate: async () => setUpdateRequests(value => value + 1) });
    const update = () => setRoute(location.hash);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return <main className="flex h-dvh flex-col gap-4 bg-background-primary-default p-4 text-text-primary">
    <header className="flex items-center justify-between"><OnboardingEntryButton />
      {hasTarget && <button data-onboarding-target="assistant-notices" aria-expanded={noticesOpen} onClick={() => setNoticesOpen(value => !value)}>提醒铃铛 / Notices</button>}
    </header>
    {noticesOpen && <p>提醒已展开 / Notices opened (fixture)</p>}
    {imageOpen && <p>图片预览已打开 / Image preview opened (fixture)</p>}
    {route.includes("page=proxy") && <section data-setting-anchor="proxyAddress">
      <label>代理地址 / Proxy address <input aria-label="Proxy address" defaultValue="http://127.0.0.1:7890" className="border p-2" /></label>
    </section>}
    {route.includes("page=workspaces") && <section>
      <button data-onboarding-target="self-update-build" disabled={params.get("disabled") === "1"} onClick={() => setBuildClicks(value => value + 1)} className="rounded border p-2">构建并热更新 / Build & Live Update</button>
      <p>模拟构建点击次数 / Mock build clicks: {buildClicks}</p>
    </section>}
    {route.includes("page=update") && <section>更新详情（模拟）/ Update details (fixture): 示例待更新改动</section>}
    <div className="flex min-h-0 flex-1 gap-4">
      <section className="flex min-w-0 flex-1 flex-col justify-between">
        <p>主对话 · Main chat</p>
        {hasTarget && params.get("image") === "1" && <button data-onboarding-target="image-preview" onClick={() => setImageOpen(true)} className="w-40 rounded border p-8">图片缩略图 / Image</button>}
        <div data-onboarding-target="composer" className="rounded-2xl border border-border-button-default p-4">
          <div data-onboarding-target={hasTarget ? "composer-input" : undefined} role="textbox" contentEditable suppressContentEditableWarning aria-label="Draft" className="mb-4 min-h-16 w-full bg-transparent">保留已有草稿 🙂</div>
          <div className="flex flex-wrap items-center gap-3">
            <span>Codex CLI / GPT-6-Astra · 高</span>
            {hasTarget && <SidechatToggle active={active} />}
            <span>全部跳过</span>
          </div>
        </div>
      </section>
      {open && <aside className="w-1/3 rounded-xl border border-border-button-default p-4">旁聊已打开 · Sidechat is open</aside>}
    </div>
    <footer className="flex flex-wrap items-center justify-end gap-2 text-caption-1-regular">
      <span>模拟更新请求 / Mock requests: {updateRequests}</span>
      {hasTarget && <SelfUpdateStatusChip />}
    </footer>
    <OnboardingTourHost />
  </main>;
}

createRoot(document.getElementById("fixture")!).render(<Fixture />);
