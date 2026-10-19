import type { CodexQuotaSnapshot } from "@/lib/ipc";
import { SubscriptionQuotaStatus } from "./SubscriptionQuotaStatus";

export function CodexQuotaStatus(props: { snapshot?: CodexQuotaSnapshot; loading: boolean; refresh: () => Promise<void>; now?: number }) {
  return <SubscriptionQuotaStatus {...props} engine="codex" />;
}
