/** Format turn duration: "12.3s", "2m12s", "1h23m". */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const remSec = Math.floor(s % 60);
  if (m < 60) return `${m}m${remSec ? `${remSec}s` : ""}`;
  const h = Math.floor(m / 60);
  const remMin = Math.floor(m % 60);
  return `${h}h${remMin ? `${remMin}m` : ""}`;
}
