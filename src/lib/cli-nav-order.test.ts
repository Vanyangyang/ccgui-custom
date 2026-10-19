import { afterEach, describe, expect, it } from "vitest";
import {
  CLI_NAV_ORDER_KEY,
  orderByStoredKeys,
  readCliNavOrder,
  writeCliNavOrder,
} from "./cli-nav-order";

afterEach(() => {
  localStorage.removeItem(CLI_NAV_ORDER_KEY);
});

describe("cli-nav-order", () => {
  it("round-trips the written order and rejects malformed payloads", () => {
    expect(readCliNavOrder()).toEqual([]);
    writeCliNavOrder(["cli:omp", "cli:claude"]);
    expect(readCliNavOrder()).toEqual(["cli:omp", "cli:claude"]);
    localStorage.setItem(CLI_NAV_ORDER_KEY, JSON.stringify({ nope: true }));
    expect(readCliNavOrder()).toEqual([]);
    localStorage.setItem(CLI_NAV_ORDER_KEY, "not json");
    expect(readCliNavOrder()).toEqual([]);
  });

  it("sorts by stored order, appending unknown keys in their incoming order", () => {
    const items = [
      { key: "cli:claude" },
      { key: "cli:omp" },
      { key: "cli:kimi" },
    ];
    expect(orderByStoredKeys(items, ["cli:kimi", "cli:claude"])).toEqual([
      { key: "cli:kimi" },
      { key: "cli:claude" },
      { key: "cli:omp" },
    ]);
    // No stored order: incoming order is preserved.
    expect(orderByStoredKeys(items, [])).toEqual(items);
  });

  it("notifies same-tab listeners on write (storage only fires cross-tab)", () => {
    let notified = 0;
    const listener = () => {
      notified += 1;
    };
    window.addEventListener("ccgui:cli-nav-order", listener);
    try {
      writeCliNavOrder(["cli:omp"]);
      expect(notified).toBe(1);
    } finally {
      window.removeEventListener("ccgui:cli-nav-order", listener);
    }
  });
});
