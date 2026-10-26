import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { imagePreview, type ImagePreviewGrant } from "./api";

export function ImagePreviewGrantsSettings() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ImagePreviewGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let alive = true, request = 0;
    const load = () => {
      if (!alive) return;
      const id = ++request; setLoading(true);
      imagePreview.list().then(value => { if (alive && request === id) { setEntries(value); setError(false); } })
        .catch(() => { if (alive && request === id) setError(true); })
        .finally(() => { if (alive && request === id) setLoading(false); });
    };
    load();
    let stop: (() => void) | undefined;
    imagePreview.changed(load).then(fn => { if (alive) { stop = fn; load(); } else fn(); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; stop?.(); };
  }, [revision]);
  async function revoke(entry: ImagePreviewGrant) {
    setBusy(true); setError(false);
    try { await imagePreview.revoke(entry.path, entry.scope); if (mounted.current) setRevision(n => n + 1); }
    catch { if (mounted.current) setError(true); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="flex flex-col gap-2 rounded-lg border border-border-secondary p-3">
    <h3 className="text-body-medium text-text-primary">{t("imagePreview.title")}</h3>
    <p className="text-caption-1-regular text-text-secondary">{t("imagePreview.description")}</p>
    {loading && <p role="status">{t("imagePreview.loading")}</p>}
    {!loading && !error && entries.length === 0 && <p className="text-caption-1-regular text-text-secondary">{t("imagePreview.empty")}</p>}
    {entries.map(entry => <div key={`${entry.scope}:${entry.path}`} className="flex items-center justify-between gap-2">
      <div className="min-w-0 text-caption-1-regular text-text-secondary"><p>{t(`imagePreview.${entry.scope}`)}</p><p className="break-all">{entry.path.replace(/^\\\\\?\\/, "")}</p></div>
      <Button size="xs" variant="secondary" disabled={busy} onClick={() => void revoke(entry)}>{t("imagePreview.revoke")}</Button>
    </div>)}
    {error && <p role="alert">{t("imagePreview.loadError")} <Button size="xs" variant="ghost" onClick={() => setRevision(n => n + 1)}>{t("imagePreview.retry")}</Button></p>}
  </section>;
}
