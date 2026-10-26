import { beforeEach, expect, it, vi } from "vitest";
import { registerPluginTabLifecycle, usePluginTabsStore } from "./center-tabs";

/** 与 browser store 相同的契约：打开即激活、关闭取邻居、越界移动钳制。 */
beforeEach(() => {
  usePluginTabsStore.setState({ tabs: [], activeId: null });
});

it("silent restoration preserves selection and lifecycle replacement rejects stale teardown", () => {
  const old = vi.fn(), current = vi.fn();
  const removeOld = registerPluginTabLifecycle("plugin:a", old);
  const removeCurrent = registerPluginTabLifecycle("plugin:a", current);
  removeOld();
  const s = usePluginTabsStore.getState();
  s.openTab("plugin:b");
  s.openTab("plugin:a", { activate: false, reason: "maintenance" });
  expect(usePluginTabsStore.getState().activeId).toBe("plugin:b");
  s.closeTab("plugin:a", "maintenance");
  expect(old).not.toHaveBeenCalled();
  expect(current.mock.calls).toEqual([[{ type: "open", reason: "maintenance" }], [{ type: "close", reason: "maintenance" }]]);
  removeCurrent();
});

it("openTab 打开即激活；重复打开只聚焦", () => {
  const s = usePluginTabsStore.getState();
  s.openTab("plugin:a");
  s.openTab("plugin:b");
  expect(usePluginTabsStore.getState().tabs).toEqual(["plugin:a", "plugin:b"]);
  expect(usePluginTabsStore.getState().activeId).toBe("plugin:b");
  usePluginTabsStore.getState().openTab("plugin:a");
  expect(usePluginTabsStore.getState().tabs).toEqual(["plugin:a", "plugin:b"]);
  expect(usePluginTabsStore.getState().activeId).toBe("plugin:a");
});

it("closeTab 关闭激活页签时回退到同槽位邻居，否则最后一个", () => {
  const s = usePluginTabsStore.getState();
  s.openTab("plugin:a");
  s.openTab("plugin:b");
  s.openTab("plugin:c");
  // 关闭中间的激活页签：同槽位（原 c 的位置）顶替
  usePluginTabsStore.getState().activate("plugin:b");
  usePluginTabsStore.getState().closeTab("plugin:b");
  expect(usePluginTabsStore.getState().activeId).toBe("plugin:c");
  // 关闭末尾的激活页签：回退到最后一个
  usePluginTabsStore.getState().closeTab("plugin:c");
  expect(usePluginTabsStore.getState().activeId).toBe("plugin:a");
  // 关闭非激活页签不改变激活态
  usePluginTabsStore.getState().openTab("plugin:d");
  usePluginTabsStore.getState().closeTab("plugin:a");
  expect(usePluginTabsStore.getState().activeId).toBe("plugin:d");
});

it("activate/deactivate 与 moveTab 边界", () => {
  const s = usePluginTabsStore.getState();
  s.openTab("plugin:a");
  s.openTab("plugin:b");
  // 未打开的 id 不能激活
  usePluginTabsStore.getState().activate("plugin:ghost");
  expect(usePluginTabsStore.getState().activeId).toBe("plugin:b");
  usePluginTabsStore.getState().deactivate();
  expect(usePluginTabsStore.getState().activeId).toBeNull();
  // 移动越界钳制到末尾
  usePluginTabsStore.getState().moveTab("plugin:a", 99);
  expect(usePluginTabsStore.getState().tabs).toEqual(["plugin:b", "plugin:a"]);
});
