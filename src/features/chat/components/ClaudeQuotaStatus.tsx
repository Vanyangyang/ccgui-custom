import type { ClaudeQuotaSnapshot } from "@/lib/ipc";
import { SubscriptionQuotaStatus } from "./SubscriptionQuotaStatus";

export function ClaudeQuotaStatus(props: { snapshot?: ClaudeQuotaSnapshot; loading: boolean; refresh: () => Promise<void>; now?: number }) {
  return <SubscriptionQuotaStatus {...props} engine="claude" />;
}
