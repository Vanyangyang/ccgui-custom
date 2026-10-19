import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { SideRunStatus } from "./SideRunStatus";
import type { SideRunProgress } from "./progress";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Side run activity feedback", () => {
  let container: HTMLDivElement;
  let root: Root;
  const startedAt = 1_800_000_000_000;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    await i18n.changeLanguage("zh");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  const render = async (progress?: SideRunProgress) => {
    await act(async () => root.render(<SideRunStatus startedAt={startedAt} progress={progress} />));
  };

  it("distinguishes elapsed waiting from real activity and recovers only on a new event", async () => {
    const progress: SideRunProgress = { phase: "starting", lastEventAt: null };
    await render(progress);
    expect(container.textContent).toContain("正在发起请求");
    expect(container.textContent).toContain("尚未收到引擎活动");
    await act(async () => vi.advanceTimersByTime(59_000));
    expect(container.textContent).not.toContain("暂无新活动");
    await act(async () => vi.advanceTimersByTime(1000));
    expect(container.textContent).toContain("暂无新活动");
    expect(container.textContent).toContain("暂时无法确认进展");
    expect(container.textContent).toContain("高思考强度或整步返回的模型");
    expect(container.querySelector(".bui-agent-thinking-static")).not.toBeNull();
    expect(progress.lastEventAt).toBeNull();

    await render({ phase: "thinking", lastEventAt: Date.now() });
    expect(container.textContent).toContain("正在思考");
    expect(container.textContent).toContain("最近活动：0 秒前");
    expect(container.textContent).not.toContain("暂无新活动");
    expect(container.querySelector(".bui-agent-thinking-static")).toBeNull();
    await act(async () => vi.advanceTimersByTime(61_000));
    expect(container.textContent).toContain("最近活动：61 秒前");
    expect(container.textContent).toContain("暂无新活动");
  });

  it("keeps elapsed and last-activity evidence across a remount and cleans timers", async () => {
    vi.setSystemTime(startedAt + 65_000);
    const progress: SideRunProgress = { phase: "waiting", lastEventAt: startedAt + 20_000 };
    await render(progress);
    expect(container.textContent).toContain("1m5s");
    expect(container.textContent).toContain("最近活动：45 秒前");
    await act(async () => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(startedAt + 75_000);
    await render(progress);
    expect(container.textContent).toContain("1m15s");
    expect(container.textContent).toContain("最近活动：55 秒前");
  });

  it.each(["zh", "en"])("shows tools, provider details and interaction limits in %s", async (language) => {
    await i18n.changeLanguage(language);
    await render({ phase: "tool", toolName: "Read 中文 🙂", lastEventAt: startedAt });
    expect(container.textContent).toContain("Read 中文 🙂");
    await render({ phase: "retrying", detail: "HTTP 503 — provider unavailable", lastEventAt: startedAt });
    expect(container.textContent).toContain("HTTP 503 — provider unavailable");
    expect(container.textContent).not.toContain("Read 中文 🙂");
    await render({ phase: "waiting_user", lastEventAt: startedAt });
    expect(container.textContent).toContain(language === "zh" ? "旁聊暂不支持处理此交互" : "Sidechat cannot handle this interaction yet");
    expect(container.querySelector(".bui-agent-thinking-static")).not.toBeNull();
    expect(container.textContent).not.toContain("sidechat.progress.");
  });
});
