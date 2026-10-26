import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, RefreshCw } from "lucide-react";
import { Button } from "@/components/base/buttons/button";
import { ActionFeedbackIcon, useActionFeedback } from "@/components/base/action-feedback";
import type { DetachedSurfaceClient } from "./client";
import type { DetachedStatus } from "./protocol";

/** Read the visible document's current control values, including edits that have
 * not reached its owner. Never include passwords, files, or hidden inputs. */
export function collectWindowInputs(root: HTMLElement | null): string {
  if (!root) return "";
  return [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")]
    .filter(input => (input.tagName === "TEXTAREA" || ["text", "search", "url", "email", "tel", "number"].includes(input.type)) && input.value.length > 0)
    .map(input => {
      const label = (input.getAttribute("aria-label") || input.labels?.[0]?.textContent || input.name || input.placeholder || "").slice(0, 200);
      return label ? `${label}\n${input.value}` : input.value;
    }).join("\n\n");
}

export function DetachedRecoveryPanel({ client, status, getContent }: {
  client: Pick<DetachedSurfaceClient, "reconcile" | "focusOwner"> & Partial<Pick<DetachedSurfaceClient, "discardAndReturn">>;
  status: DetachedStatus;
  getContent: () => HTMLElement | null;
}) {
  const { t } = useTranslation();
  const checking = useActionFeedback({ spin: true });
  const copying = useActionFeedback();
  const [notice, setNotice] = useState("");
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [focusing, setFocusing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const isReturnBlocked = status.phase === "detached" && Boolean(status.returnBlocked);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function reconcile() {
    const ticket = ++generation.current;
    let confirmed = false;
    setNotice("");
    try {
      await checking.start(async () => { confirmed = await client.reconcile(); }, () => !confirmed);
      if (!confirmed && alive.current && ticket === generation.current) setNotice(t("plugins.detached.stillUnconfirmed"));
    } catch { if (alive.current && ticket === generation.current) setNotice(t("plugins.detached.stillUnconfirmed")); }
  }
  async function copy() {
    const ticket = ++generation.current;
    const text = collectWindowInputs(getContent());
    setNotice("");
    if (!text) { setNotice(t("plugins.detached.noInputs")); return; }
    try { await copying.start(() => navigator.clipboard.writeText(text)); if (alive.current && ticket === generation.current) setManualCopy(null); }
    catch { if (alive.current && ticket === generation.current) { setManualCopy(text); setNotice(t("plugins.detached.copyManually")); } }
  }
  async function focus() {
    const ticket = ++generation.current;
    setFocusing(true); setNotice("");
    try { await client.focusOwner(); }
    catch { if (alive.current && ticket === generation.current) setNotice(t("plugins.detached.ownerUnavailable")); }
    finally { if (alive.current) setFocusing(false); }
  }
  async function discard(reason: "return" | "closed") {
    if (!client.discardAndReturn) return;
    const ticket = ++generation.current;
    setDiscarding(true); setNotice("");
    try { await client.discardAndReturn(reason); }
    catch { if (alive.current && ticket === generation.current) setNotice(t("plugins.detached.actionFailed")); }
    finally { if (alive.current) setDiscarding(false); }
  }
  const statusText = isReturnBlocked
    ? t("plugins.detached.returnBlocked")
    : t(status.phase === "unavailable" ? "plugins.detached.ownerUnavailable" : status.phase === "error" ? "plugins.detached.connectionError" : "plugins.detached.recovering");
  return <section className="shrink-0 border-b border-border-primary px-4 py-3 text-sm text-text-secondary" aria-label={t("plugins.detached.recoveryTitle")}>
    <p role="status">{statusText}</p>
    {!isReturnBlocked && <p className="mt-1">{t("plugins.detached.recoveryExit")}</p>}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {!isReturnBlocked && <Button size="small" variant="secondary" disabled={checking.feedback === "running" || discarding} onClick={() => void reconcile()}>
        <ActionFeedbackIcon icon={RefreshCw} feedback={checking.feedback} spin />{t("plugins.detached.reconcile")}
      </Button>}
      <Button size="small" variant="secondary" disabled={copying.feedback === "running" || discarding} onClick={() => void copy()}>
        <ActionFeedbackIcon icon={Copy} feedback={copying.feedback} />{t("plugins.detached.copyInputs")}
      </Button>
      <Button size="small" variant="secondary" disabled={focusing || discarding} onClick={() => void focus()}>{t("plugins.detached.viewMain")}</Button>
      {client.discardAndReturn && <>
        <Button size="small" variant="secondary" disabled={discarding} onClick={() => void discard("return")}>{t("plugins.detached.discardAndReturn")}</Button>
        <Button size="small" variant="secondary" disabled={discarding} onClick={() => void discard("closed")}>{t("plugins.detached.discardAndClose")}</Button>
      </>}
    </div>
    {notice && <p role="alert" className="mt-2">{notice}</p>}
    {manualCopy !== null && <textarea readOnly rows={4} aria-label={t("plugins.detached.copyInputs")} value={manualCopy}
      className="mt-2 w-full resize-y rounded-lg border border-border-primary bg-background-primary-default p-2 text-text-primary" />}
  </section>;
}
