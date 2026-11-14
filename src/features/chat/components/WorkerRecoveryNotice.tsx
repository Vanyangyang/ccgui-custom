import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { invoke, listen } from "@/lib/transport";

/** Recovery faults precede the webview, so query once as well as listening. */
export function WorkerRecoveryNotice() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ code: string }>("transport://worker-error", ({ payload }) => {
      if (!disposed && payload.code === "worker-recovery-failed") setVisible(true);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    void invoke<{ recoveryError?: string }[]>("runtime_worker_sources").then(sources => {
      if (!disposed && sources.some(source => source.recoveryError)) setVisible(true);
    }).catch(error => console.error("[worker-recovery] status unavailable", error));
    return () => { disposed = true; unlisten?.(); };
  }, []);
  if (!visible) return null;
  return (
    <div role="alert" className="fixed bottom-4 left-4 z-105 flex max-w-md flex-col gap-3 rounded-2xl border border-separator-border bg-background-primary-default p-4 shadow-xl">
      <p className="text-body-medium text-text-primary">{t("workerRecovery.title")}</p>
      <p className="text-body-small text-text-secondary">{t("workerRecovery.message")}</p>
      <div className="flex justify-end">
        <Button size="small" variant="secondary" onClick={() => setVisible(false)}>{t("workerRecovery.dismiss")}</Button>
      </div>
    </div>
  );
}
