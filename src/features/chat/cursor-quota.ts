import type { CursorQuotaSnapshot } from "@/lib/ipc";

/** Cursor 官网用量页。面板里的「打开」仍走这里，链接本身不带凭据。 */
export const CURSOR_USAGE_URL = "https://cursor.com/dashboard?tab=usage";

/** 与 Cursor CLI 的用量条一致：四舍五入到整数，0 到 1 之间显示 1%。 */
export function formatCursorQuotaPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const clamped = Math.max(0, Math.min(100, value));
  const rounded = clamped > 0 && clamped < 1 ? 1 : Math.round(clamped);
  return `${rounded}%`;
}

export function formatCursorCents(cents: number | undefined, locale: string): string | undefined {
  if (cents === undefined || !Number.isFinite(cents) || cents < 0) return undefined;
  const digits = cents % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(cents / 100);
}

export function cursorQuotaReady(snapshot: CursorQuotaSnapshot | undefined): snapshot is CursorQuotaSnapshot {
  return snapshot?.status === "ready" || snapshot?.status === "stale";
}
