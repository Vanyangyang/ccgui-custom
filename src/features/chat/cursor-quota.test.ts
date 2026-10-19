import { describe, expect, it } from "vitest";
import { formatCursorCents, formatCursorQuotaPercent } from "./cursor-quota";

describe("cursor quota labels", () => {
  it("rounds like the Cursor usage pager and formats cents", () => {
    expect(formatCursorQuotaPercent(91.5225)).toBe("92%");
    expect(formatCursorQuotaPercent(12.15)).toBe("12%");
    expect(formatCursorQuotaPercent(1.58)).toBe("2%");
    expect(formatCursorQuotaPercent(0.4)).toBe("1%");
    expect(formatCursorQuotaPercent(undefined)).toBe("—");
    expect(formatCursorCents(36609, "en")).toBe("$366.09");
    expect(formatCursorCents(40000, "en")).toBe("$400");
  });
});
