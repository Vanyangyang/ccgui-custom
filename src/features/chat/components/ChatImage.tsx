import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import FileImage from "lucide-react/dist/esm/icons/file-image";
import { ipc } from "@/lib/ipc";
import { ImageLightbox } from "@/components/base/image-lightbox";
import { chatImageName, isRasterDataUrl, resolveChatImage } from "./chat-image-refs";
import { submitImageAnnotation, useImageAnnotationTarget } from "./image-annotation-target";

export function ChatImage({ src, alt, workspacePath = "" }: { src: string; alt?: string; workspacePath?: string }) {
  const { t } = useTranslation();
  const source = useMemo(() => resolveChatImage(src, workspacePath), [src, workspacePath]);
  const [loaded, setLoaded] = useState<{ source: typeof source; url: string | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const target = useImageAnnotationTarget();
  const name = alt || chatImageName(src) || t("chat.imageName");
  const url = source?.kind === "data" ? source.value : loaded?.source === source ? loaded.url : undefined;

  useEffect(() => {
    let cancelled = false;
    setZoom(false);
    setFailed(null);
    if (source?.kind === "file") {
      ipc.readFile(source.value).then(content => {
        if (!cancelled) setLoaded({ source, url: content.kind === "image" && content.dataUrl && isRasterDataUrl(content.dataUrl) ? content.dataUrl : null });
      }).catch(() => { if (!cancelled) setLoaded({ source, url: null }); });
    }
    return () => { cancelled = true; };
  }, [source]);

  if (!source || url === null || (url && failed === url)) return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-background-tertiary-default px-2 py-1 text-caption-1-medium text-text-secondary" title={t(source ? "chat.imageUnavailable" : "chat.imageBlocked")}>
      <FileImage className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{chatImageName(src) || name}</span>
    </span>
  );
  if (!url) return <span className="inline-block h-24 w-32 max-w-full animate-pulse rounded-lg bg-background-tertiary-default" aria-hidden />;
  return <>
    <button type="button" data-onboarding-target={target ? "image-preview" : undefined} onClick={event => { event.preventDefault(); event.stopPropagation(); setZoom(true); }}
      className="inline-block max-w-full cursor-zoom-in overflow-hidden rounded-lg align-middle" aria-label={t("chat.previewImage", { name })}>
      <img src={url} alt={name} onError={() => setFailed(url)} className="max-h-48 max-w-full rounded-lg object-contain" style={{ width: "auto", height: "auto", maxWidth: "min(16rem, 100%)" }} loading="lazy" />
    </button>
    {zoom && createPortal(<ImageLightbox src={url} name={name} onClose={() => setZoom(false)}
      annotation={target ? { onSubmit: (boxes) => submitImageAnnotation(target, {
        src: url, name, sourcePath: source.kind === "file" ? source.value : undefined, includeOriginal: true,
      }, boxes, t) } : undefined} />, document.body)}
  </>;
}
