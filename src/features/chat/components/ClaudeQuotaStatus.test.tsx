import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ClaudeQuotaStatus } from "./ClaudeQuotaStatus";
import type { ClaudeQuotaSnapshot } from "@/lib/ipc";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const NOW = 1_900_000_000;

describe("composer subscription quota status", () => {
  let container: HTMLDivElement;
  let root: Root;
  const refresh = vi.fn(async () => {});
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    refresh.mockClear();
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  async function render(snapshot?: ClaudeQuotaSnapshot, loading = false, now = NOW) {
    await act(async () => root.render(<ClaudeQuotaStatus snapshot={snapshot} loading={loading} refresh={refresh} now={now} />));
  }
  async function openDetails() {
    const trigger = container.querySelector("button")!;
    await act(async () => trigger.click());
    return document.querySelector('[role="dialog"]')!;
  }
  it.each([[0, "100%"], [100, "0%"], [62.125, "37.88%"]])("shows weekly remaining quota for %s percent used in summary, aria and details", async (usedPercentage, remaining) => {
    await render({ status: "ready", collectedAt: NOW, windows: { fiveHour: { usedPercentage: 35 }, sevenDay: { usedPercentage } } });
    expect(container.textContent).toBe(`5h remaining 65% · 7d remaining ${remaining}`);
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain(`7d remaining ${remaining}`);
    const details = await openDetails();
    const weeklyLabel = [...details.querySelectorAll("dt")].find(node => node.textContent === "7-day remaining");
    expect(weeklyLabel?.nextElementSibling?.textContent).toBe(remaining);
    const fiveHourLabel = [...details.querySelectorAll("dt")].find(node => node.textContent === "5-hour remaining");
    expect(fiveHourLabel?.nextElementSibling?.textContent).toBe("65%");
    const fills = [...details.querySelectorAll<HTMLElement>(".bg-chart-track > div")].map(node => node.style.width);
    expect(fills).toEqual(["65%", `${100 - usedPercentage}%`]);
  });
  it.each([NaN, Infinity, -1, 101])("does not derive weekly remaining from invalid percentage %s", async usedPercentage => {
    await render({ status: "ready", collectedAt: NOW, windows: { fiveHour: { usedPercentage: 35 }, sevenDay: { usedPercentage } } });
    expect(container.textContent).toBe("5h remaining 65% · 7d remaining —");
    const details = await openDetails();
    const weeklyLabel = [...details.querySelectorAll("dt")].find(node => node.textContent === "7-day remaining");
    expect(weeklyLabel?.nextElementSibling?.textContent).toBe("—");
  });
  it("clears weekly remaining after reset, snapshot expiry and account changes", async () => {
    const windows = { sevenDay: { usedPercentage: 14, resetsAt: NOW + 60 } };
    await render({ status: "ready", collectedAt: NOW, windows });
    const details = await openDetails();
    const weeklyValue = () => [...details.querySelectorAll("dt")].find(node => node.textContent === "7-day remaining")?.nextElementSibling?.textContent;
    expect(weeklyValue()).toBe("86%");
    await render({ status: "ready", collectedAt: NOW + 60, windows }, false, NOW + 60);
    expect(container.textContent).toContain("7d remaining 86%");
    expect(weeklyValue()).toBe("86%");
    await render({ status: "ready", collectedAt: NOW - 3600, windows });
    expect(weeklyValue()).toBe("86%");
    await render({ status: "unavailable", errorCode: "auth_changed", windows });
    expect(weeklyValue()).toBe("—");
  });
  it("shows real zero, fractional percent, and a missing window without false zeros", async () => {
    await render({ status: "ready", collectedAt: NOW, windows: { fiveHour: { usedPercentage: 0 } } });
    expect(container.textContent).toBe("5h remaining 100% · 7d remaining —");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("Claude subscription · 5h remaining 100% · 7d remaining —");
    await render({ status: "ready", collectedAt: NOW, windows: { fiveHour: { usedPercentage: 0.8 }, sevenDay: { usedPercentage: 62 } } });
    expect(container.textContent).toBe("5h remaining 99.2% · 7d remaining 38%");
    await render(); expect(container.textContent).toBe("5h remaining — · 7d remaining —");
    expect(refresh).not.toHaveBeenCalled();
  });
  it("opens independent details with exact local reset and countdown", async () => {
    await render({ status: "ready", collectedAt: NOW - 30, windows: { fiveHour: { usedPercentage: 35, resetsAt: NOW + 3660 }, sevenDay: { usedPercentage: 62 } } });
    const details = await openDetails();
    expect(details).not.toBeNull();
    expect(details.textContent).toContain("5-hour remaining");
    expect(details.textContent).toContain("7-day remaining");
    expect(details.textContent).toContain(new Date((NOW + 3660) * 1000).toLocaleString("en"));
    expect(details.textContent).toContain("in 1h 1m");
    expect(details.textContent).toContain(new Date((NOW - 30) * 1000).toLocaleString("en"));
    expect(details.textContent).toContain("Reset time unavailable");
    expect(details.textContent).not.toContain("Account");
    expect(details.textContent).not.toContain("Update info");
    expect(refresh).not.toHaveBeenCalled();
  });
  it("shows reset times beside percentages without opening details and clears invalidated times", async () => {
    await i18n.changeLanguage("zh");
    const current = new Date(2026, 9, 2, 21, 0).getTime() / 1000;
    const fiveHourReset = new Date(2026, 9, 2, 23, 49).getTime() / 1000;
    const weeklyReset = new Date(2026, 9, 5, 3, 59).getTime() / 1000;
    const snapshot: ClaudeQuotaSnapshot = { status: "ready", collectedAt: current, windows: {
      fiveHour: { usedPercentage: 31, resetsAt: fiveHourReset },
      sevenDay: { usedPercentage: 4, resetsAt: weeklyReset },
    } };
    await render(snapshot, false, current);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect([...container.querySelectorAll("time")].map(node => node.textContent)).toEqual(["5h 23:49 重置", "7d 10/5 03:59 重置"]);
    expect(container.textContent).toContain("5h 剩余 69% · 7d 剩余 96%");
    expect(container.querySelector("time")?.dateTime).toBe(new Date(fiveHourReset * 1000).toISOString());
    expect(container.querySelector("time")?.title).toContain(new Date(fiveHourReset * 1000).toLocaleString("zh"));
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("5h 23:49 重置");
    expect(refresh).not.toHaveBeenCalled();
    await render({ ...snapshot, collectedAt: fiveHourReset + 1 }, false, fiveHourReset + 1);
    expect([...container.querySelectorAll("time")].map(node => node.textContent)).toEqual(["7d 10/5 03:59 重置"]);
    expect(container.textContent).toContain("5h 剩余 69% · 7d 剩余 96%");
    await render({ status: "unavailable", windows: {}, errorCode: "auth_changed" }, false, current);
    expect(container.querySelector("time")).toBeNull();
  });
  it("hides stale labels and malformed values, and still explains an expired snapshot", async () => {
    await render({ status: "ready", collectedAt: NOW - 120, windows: { fiveHour: { usedPercentage: 35 }, sevenDay: { usedPercentage: Infinity } } });
    expect(container.querySelector("button")?.getAttribute("aria-label")).not.toContain("Stale");
    const details = await openDetails();
    expect(details.textContent).not.toContain("Last known usage");
    expect(details.textContent).not.toContain("Infinity");
    await render({ status: "ready", collectedAt: NOW - 601, windows: { fiveHour: { usedPercentage: 35 } } });
    expect(container.textContent).toContain("5h remaining 65%");
    expect(details.textContent).toContain(new Date((NOW - 601) * 1000).toLocaleString("en"));
    await render({ status: "ready", collectedAt: NOW - 3600, windows: { fiveHour: { usedPercentage: 35 } } });
    expect(container.textContent).toContain("5h remaining 65%");
    expect(details.textContent).toContain(new Date((NOW - 3600) * 1000).toLocaleString("en"));
    expect(details.textContent).not.toContain("over an hour old");
  });
  it("shows the CLI account and plan only inside details and clears them with a changed account", async () => {
    const account = { email: "long-account-name.with-extra-characters@example.com", plan: "Claude Team" };
    await render({ status: "ready", collectedAt: NOW, account, windows: { fiveHour: { usedPercentage: 0 } } });
    expect(container.textContent).toBe("5h remaining 100% · 7d remaining —");
    const details = await openDetails();
    expect(details.textContent).toContain(account.email);
    expect(details.textContent).toContain("Claude Team");
    expect(details.querySelector("dd")?.className).toContain("break-all");
    expect(refresh).not.toHaveBeenCalled();
    await render({ status: "unavailable", windows: {}, errorCode: "auth_changed" });
    expect(details.textContent).not.toContain(account.email);
    expect(details.textContent).not.toContain("Claude Team");
    expect(details.textContent).not.toContain("Account");
    expect(details.textContent).not.toContain("Not available");
    await render({ status: "ready", collectedAt: NOW, account: { email: "other@example.com", plan: "Claude Max" }, windows: { fiveHour: { usedPercentage: 12 } } });
    expect(details.textContent).toContain("other@example.com");
    expect(details.textContent).toContain("Claude Max");
    expect(details.textContent).not.toContain(account.email);
  });
  it("can show a known plan without inventing an account or quota and renders labels as text", async () => {
    await render({ status: "unavailable", account: { plan: "Claude Pro" }, windows: {} });
    const details = await openDetails();
    expect(details.textContent).toContain("Claude Pro");
    expect(details.textContent).not.toContain("Account");
    expect(details.textContent).not.toContain("Not available");
    expect(container.textContent).toBe("5h remaining — · 7d remaining —");
    await render({ status: "unavailable", account: { email: "<img src=x onerror=alert(1)>", plan: "Claude Team" }, windows: {} });
    expect(details.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(details.querySelector("img")).toBeNull();
  });
  it("retains restored account details after usage expiry without presenting a fresh timestamp or zero", async () => {
    const collectedAt = NOW - 7200;
    await render({ status: "unavailable", collectedAt, errorCode: "quota_expired",
      account: { email: "reader@example.com", plan: "Claude Team" }, windows: {} });
    expect(container.textContent).toBe("5h remaining — · 7d remaining —");
    const details = await openDetails();
    expect(details.textContent).toContain("reader@example.com");
    expect(details.textContent).toContain("Claude Team");
    expect(details.textContent).toContain("over an hour old");
    expect(details.textContent).toContain(new Date(collectedAt * 1000).toLocaleString("en"));
    expect(details.textContent).not.toContain("0%");
    expect(refresh).not.toHaveBeenCalled();
  });
  it("supports keyboard opening and Escape closing, and prevents refresh while busy", async () => {
    await render({ status: "ready", collectedAt: NOW, windows: {} }, true);
    const trigger = container.querySelector("button")!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
    });
    const details = document.querySelector('[role="dialog"]')!;
    expect(details).not.toBeNull();
    expect(details.textContent).not.toContain("Update info");
    await act(async () => details.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
  it("localizes details in Chinese", async () => {
    await i18n.changeLanguage("zh");
    await render({ status: "stale", collectedAt: NOW - 150, account: { email: "reader@example.com", plan: "Claude Team" }, windows: { fiveHour: { usedPercentage: 35, resetsAt: NOW + 3660 } } });
    const details = await openDetails();
    expect(details.textContent).toContain("Claude 订阅");
    expect(details.textContent).toContain("账号");
    expect(details.textContent).toContain("订阅计划");
    expect(details.textContent).toContain("reader@example.com");
    expect(details.textContent).toContain("5 小时剩余额度");
    expect(details.textContent).toContain("7 天剩余额度");
    expect(details.textContent).toContain("1 小时 1 分钟后");
    expect(details.textContent).not.toContain("旧数据");
    expect(details.textContent).not.toContain("更新信息");
    expect(details.textContent).not.toContain("来自正常对话");
  });
});
