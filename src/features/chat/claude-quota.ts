import type { ClaudeQuotaSnapshot } from "@/lib/ipc";
import { validSubscriptionQuotaSnapshot } from "./subscription-quota";

export {
  QUOTA_STALE_AGE as CLAUDE_QUOTA_STALE_AGE,
  QUOTA_MAX_AGE as CLAUDE_QUOTA_MAX_AGE,
  isNativeSubscriptionProvider as isClaudeNativeProvider,
  compactQuotaReset,
  quotaResetCountdown,
} from "./subscription-quota";
export const validClaudeQuotaSnapshot = (snapshot: ClaudeQuotaSnapshot, now?: number) =>
  validSubscriptionQuotaSnapshot(snapshot, now, { retainUntilNext: true });
