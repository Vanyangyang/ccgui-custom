import i18n from "@/lib/i18n";
import { invoke } from "@/lib/transport";
import type { ConfirmationContent } from "./types";
import type { HostTaskSelection } from "@ccgui/plugin-sdk";

interface SessionRef { engine: string; sessionId: string; workspacePath: string; title?: string }
interface ManagedHandoffContent {
  sender: SessionRef; target: SessionRef; model?: string | null; message: string;
  truncated?: boolean; imageRefs?: readonly string[];
}

export function confirmationAppearance() {
  return { dark: typeof document !== "undefined" && document.documentElement.classList.contains("dark"), language: i18n.language };
}

/** Read-only content; only the isolated host window can answer the native request. */
export function managedHandoffConfirmation(source: ManagedHandoffContent, summary: string, targetSelection?: HostTaskSelection): ConfirmationContent {
  const label = (ref: SessionRef) => `${ref.engine} / ${ref.sessionId}\n${ref.workspacePath}`;
  return {
    title: i18n.t("crossSession.managedHandoffDialogTitle"),
    message: i18n.t("hostConfirmation.handoffDescription"),
    fields: [
      { label: i18n.t("hostConfirmation.parent"), value: label(source.sender) },
      { label: i18n.t("hostConfirmation.source"), value: label(source.target) },
      { label: i18n.t("hostConfirmation.model"), value: source.model || "—" },
      ...(targetSelection ? [{ label: i18n.t("crossSession.managedHandoffTargetLabel"),
        value: `${targetSelection.engine} / ${targetSelection.model}\n${i18n.t("hostConfirmation.targetProvider")}: ${targetSelection.providerId}${targetSelection.effort ? `\n${i18n.t("hostConfirmation.targetEffort")}: ${targetSelection.effort}` : ""}` }] : []),
      { label: i18n.t("hostConfirmation.images"), value: i18n.t("hostConfirmation.imageCount", { count: source.imageRefs?.length ?? 0 }) },
    ],
    sections: [
      { title: i18n.t(source.truncated ? "hostConfirmation.pendingExcerpt" : "hostConfirmation.pending"), body: source.message, markdown: false },
      { title: i18n.t("hostConfirmation.summary"), body: summary, markdown: true },
    ],
    confirmLabel: i18n.t("crossSession.managedHandoffConfirm"),
    dismissLabel: i18n.t("crossSession.costDialogDismiss"),
    ...confirmationAppearance(),
  };
}

export async function confirmHost(content: ConfirmationContent): Promise<boolean> {
  return await invoke("host_confirmation_open", { content }) === true;
}
