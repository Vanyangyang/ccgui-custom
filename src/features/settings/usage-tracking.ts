import { readStoredJson, writeStored } from "@/lib/storage";

/**
 * Whether finished turns are written to the usage ledger. The ledger only
 * ever counts turns that ran while this was on — nothing is reconstructed
 * from history — so the switch is the feature's own boundary.
 */
const USAGE_TRACKING_KEY = "ccgui-next.usageTracking:v1";

export function usageTrackingEnabled(): boolean {
  const stored = readStoredJson(USAGE_TRACKING_KEY, (value) =>
    typeof value === "boolean" ? value : null,
  );
  // Default on: the ledger is local, and an untouched install would
  // otherwise show an empty page until the user found the switch.
  return stored ?? true;
}

export function setUsageTrackingEnabled(enabled: boolean): void {
  writeStored(USAGE_TRACKING_KEY, JSON.stringify(enabled));
}
