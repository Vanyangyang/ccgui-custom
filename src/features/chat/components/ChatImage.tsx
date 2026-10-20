import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import FileImage from "lucide-react/dist/esm/icons/file-image";
import { ImageLightbox } from "@/components/base/image-lightbox";
import { chatImageName, loadChatImage, releaseChatImage, resolveChatImage, type LoadedChatImage } from "./chat-image-refs";
import { isOutsideWorkspaceError } from "@/lib/grant";
import { galleryFor, useChatImageGallery, type GalleryImage } from "./chat-image-gallery";
import { submitImageAnnotation, useImageAnnotationTarget } from "./image-annotation-target";

type ChatImageSource = ReturnType<typeof resolveChatImage>;

/** Displayable image for a validated source: data URLs pass through, files
 *  load via IPC. undefined = loading, null = unavailable. A late result for
 *  a previous source or after unmount is ignored, and an object URL is
 *  released with the source that loaded it. `known` reuses a caller's image.
 *  `outside` = refused as outside every workspace and granted directory. */
function useChatImage(source: ChatImageSource, known?: LoadedChatImage): { image: LoadedChatImage | null | undefined; outside: boolean } {
  const [loaded, setLoaded] = useState<{ source: ChatImageSource; image: LoadedChatImage | null; outside?: boolean } | null>(null);
  useEffect(() => {
    if (source?.kind !== "file" || known) return;
    let cancelled = false;
    let owned: LoadedChatImage | null = null;
    loadChatImage(source.value).then(image => {
      if (cancelled) return releaseChatImage(image);
      owned = image;
      setLoaded({ source, image });
    }).catch((error: unknown) => {
      if (!cancelled) setLoaded({ source, image: null, outside: isOutsideWorkspaceError(error) });
    });
    return () => { cancelled = true; releaseChatImage(owned); };
  }, [source, known]);
  // Stable per source, so a viewer reusing it as `known` sees no change.
  const inline = useMemo(() => (source?.kind === "data" ? { url: source.value } : null), [source]);
  if (!source) return { image: null, outside: false };
  if (inline) return { image: inline, outside: false };
  if (known) return { image: known, outside: false };
  const current = loaded?.source === source ? loaded : null;
  return { image: current ? current.image : undefined, outside: current?.outside === true };
}

export function ChatImage({ src, alt, workspacePath = "" }: { src: string; alt?: string; workspacePath?: string }) {
  const { t } = useTranslation();
  const source = useMemo(() => resolveChatImage(src, workspacePath), [src, workspacePath]);
  const { image, outside } = useChatImage(source);
  const url = image === null ? null : image?.url;
  const [failed, setFailed] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const target = useImageAnnotationTarget();
  const name = alt || chatImageName(src) || t("chat.imageName");

  useEffect(() => {
    setZoom(false);
    setFailed(null);
  }, [source]);

  if (!source || url === null || (url && failed === url)) return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-background-tertiary-default px-2 py-1 text-caption-1-medium text-text-secondary" title={t(!source ? "chat.imageBlocked" : outside ? "chat.imageOutsideWorkspace" : "chat.imageUnavailable")}>
      <FileImage className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{chatImageName(src) || name}</span>
    </span>
  );
  if (!url) return <span className="inline-block h-24 w-32 max-w-full animate-pulse rounded-lg bg-background-tertiary-default" aria-hidden />;
  return <>
    <button type="button" data-onboarding-target={target ? "image-preview" : undefined} onClick={event => { event.preventDefault(); event.stopPropagation(); setZoom(true); }}
      className="inline-block max-w-full cursor-zoom-in overflow-hidden rounded-lg align-middle" aria-label={t("chat.previewImage", { name })}>
      <img src={url} alt={name} onError={() => setFailed(url)} className="max-h-48 max-w-full rounded-lg object-contain" style={{ width: "auto", height: "auto", maxWidth: "min(16rem, 100%)" }} loading="lazy" />
    </button>
    {zoom && image && createPortal(<ChatImageViewer clicked={alt ? { src, alt } : { src }} clickedImage={image} workspacePath={workspacePath}
      onClose={() => setZoom(false)} />, document.body)}
  </>;
}

/** Preview opened from a chat image: steps through the conversation's
 *  images (snapshot taken at open, so streaming never shifts the order). */
function ChatImageViewer({ clicked, clickedImage, workspacePath, onClose }: {
  clicked: GalleryImage;
  /** The thumbnail's already-loaded image; the thumbnail outlives the viewer. */
  clickedImage: LoadedChatImage;
  workspacePath: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const gallery = useChatImageGallery();
  const [{ items, index: start }] = useState(() => galleryFor(gallery, clicked, workspacePath));
  const [index, setIndex] = useState(start);
  const item = items[index];
  const source = useMemo(() => resolveChatImage(item.src, workspacePath), [item.src, workspacePath]);
  const { image, outside } = useChatImage(source, index === start ? clickedImage : undefined);
  const url = image?.url;
  const target = useImageAnnotationTarget();
  const name = item.alt || chatImageName(item.src) || t("chat.imageName");
  const sourcePath = source?.kind === "file" ? source.value : undefined;
  return <ImageLightbox src={url ?? null} name={name} sourcePath={sourcePath}
    unavailable={image === null ? t(outside ? "chat.imageOutsideWorkspace" : "chat.imageUnavailable") : undefined}
    sizeBytes={image?.size} imageBlob={image?.blob} onClose={onClose}
    nav={items.length > 1 ? {
      index, count: items.length,
      onPrev: () => setIndex(i => Math.max(0, i - 1)),
      onNext: () => setIndex(i => Math.min(items.length - 1, i + 1)),
    } : undefined}
    annotation={target && url ? { onSubmit: (boxes) => submitImageAnnotation(target, {
      src: url, name, sourcePath, includeOriginal: true, original: image?.blob,
    }, boxes, t) } : undefined} />;
}
