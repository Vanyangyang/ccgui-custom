import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { isWeb } from "@/lib/platform";
import { imagePreview, type ImagePreviewGrant, type ImagePreviewScope } from "./api";

export function InlineImagePreviewGrant({ path, onGranted }: { path: string; onGranted: () => void }) {
  const { t } = useTranslation();
  const [scopes, setScopes] = useState<ImagePreviewGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const id = ++generation.current;
    setScopes(null); setError(null); setBusy(false);
    if (!isWeb) imagePreview.scopes(path).then(value => { if (id === generation.current) setScopes(value); })
      .catch(() => { if (id === generation.current) setError("scopeError"); });
    return () => { generation.current++; };
  }, [path, retry]);
  async function grant(scope: ImagePreviewScope) {
    if (busy || !scopes) return;
    const id = generation.current;
    setBusy(true); setError(null);
    try {
      await imagePreview.grant(scopes.find(s => s.scope === "file")!.path, scope, scopes.find(s => s.scope === scope)!.path);
      if (id === generation.current) onGranted();
    } catch { if (id === generation.current) { setScopes(null); setError("error"); } }
    finally { if (id === generation.current) setBusy(false); }
  }
  return <span className="inline-flex max-w-full flex-col gap-1 rounded-md bg-background-tertiary-default p-2 text-caption-1-regular text-text-secondary">
    <span>{t(isWeb ? "imagePreview.webDenied" : "imagePreview.denied")}</span>
    {!isWeb && <>
      <span>{t("imagePreview.description")}</span>
      {!scopes && !error && <span role="status">{t("imagePreview.loading")}</span>}
      {scopes?.map(entry => <span key={entry.scope} className="inline-flex flex-col items-start gap-1">
        <span className="max-w-full break-all">{t(`imagePreview.${entry.scope}`)}: {entry.path.replace(/^\\\\\?\\/, "")}</span>
        <Button size="xs" variant="secondary" disabled={busy} onClick={event => { event.preventDefault(); event.stopPropagation(); void grant(entry.scope); }}>{t(`imagePreview.${entry.scope === "file" ? "allowFile" : "allowDirectory"}`)}</Button>
      </span>)}
      {busy && <span role="status">{t("imagePreview.granting")}</span>}
      {error && <span role="alert">{t(`imagePreview.${error}`)} <Button size="xs" variant="ghost" disabled={busy} onClick={() => setRetry(n => n + 1)}>{t("imagePreview.retry")}</Button></span>}
    </>}
  </span>;
}
