import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ZoomIn from "lucide-react/dist/esm/icons/zoom-in";
import ZoomOut from "lucide-react/dist/esm/icons/zoom-out";
import X from "lucide-react/dist/esm/icons/x";
import PenLine from "lucide-react/dist/esm/icons/pen-line";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw";
import Copy from "lucide-react/dist/esm/icons/copy";
import Check from "lucide-react/dist/esm/icons/check";
import Download from "lucide-react/dist/esm/icons/download";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import Link from "lucide-react/dist/esm/icons/link";
import { dataUrlBytes, imageMetaText } from "@/utils/image-meta";
import { useBrowserOcclusion } from "@/features/browser/occlusion";
import { isModalDialogOpen, showModalDialog } from "@/lib/engine-compat";
import { ipc } from "@/lib/ipc";
import { isWeb } from "@/lib/platform";
import { COPY_FEEDBACK_MS } from "@/hooks/use-copied";
import { AnnotationOverlay, AnnotationPanel, type PanHandlers } from "./image-annotation/AnnotationLayer";
import { annotationsComplete, type AnnotationBox } from "./image-annotation/geometry";
import { copyImageToClipboard, saveImage } from "./image-actions";

/** Gallery keys: arrows in either axis plus Page Up / Page Down. */
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp"]);
const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown"]);

/** Zoom bounds and button step; zoom 1 = fit the viewport. */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 10;
const ZOOM_STEP = 1.25;

/** Optional annotation mode: the caller decides where finished boxes go.
 *  `onSubmit` rejects to keep the notes open with an error. */
export interface ImageAnnotationOptions {
  onSubmit: (boxes: AnnotationBox[]) => Promise<void>;
}

/** Previous/next within a gallery; `index` is zero-based. */
export interface ImageLightboxNav {
  index: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
}

type ImageAction = "copy" | "save" | "path";

/** Full-screen image preview with metadata and zoom. The header shows the
 * name plus "width × height · file size"; the toolbar and the mouse wheel
 * zoom (around the cursor), and dragging pans while zoomed in. Backdrop
 * click, the × button, or Escape closes. With `nav`, side arrows and the
 * arrow / Page keys step through the gallery and each image opens at fit.
 * The toolbar also rotates the view, copies or saves the image and, for
 * file-backed images (`sourcePath`), copies the path or shows it in its
 * folder. `src` null = still loading; `unavailable` = cannot be shown (a string gives the reason).
 * With `annotation`, a toolbar toggle switches to drawing numbered boxes
 * with notes; while annotating, backdrop and image presses never close,
 * the gallery and rotation are locked, and unsaved notes need confirmation. */
export function ImageLightbox({
  src,
  name,
  onClose,
  annotation,
  nav,
  sourcePath,
  unavailable = false,
  sizeBytes: knownSize,
  imageBlob,
}: {
  src: string | null;
  name: string;
  onClose: () => void;
  annotation?: ImageAnnotationOptions;
  nav?: ImageLightboxNav;
  sourcePath?: string;
  unavailable?: boolean | string;
  /** File size when `src` is not a data URL (e.g. an object URL). */
  sizeBytes?: number;
  /** The image bytes behind an object URL, for copying without a re-encode. */
  imageBlob?: Blob;
}) {
  const { t } = useTranslation();
  // Only mounted while open; hides the native browser webview so the
  // lightbox is not painted under it.
  useBrowserOcclusion(true);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [boxes, setBoxes] = useState<AnnotationBox[]>([]);
  const [confirm, setConfirm] = useState<"close" | "exit" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [frame, setFrame] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [rotation, setRotation] = useState(0);
  const [done, setDone] = useState<ImageAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const doneTimer = useRef(0);
  const nextBoxId = useRef(1);
  // Native listeners read the latest annotation and gallery state through refs.
  const annotateRef = useRef({ annotating: false, dirty: false });
  annotateRef.current = { annotating, dirty: boxes.length > 0 };
  const navRef = useRef(nav);
  navRef.current = nav;

  // A modal <dialog> renders in the top layer, so no portal is needed to
  // escape the timeline's transformed virtual rows (a transformed ancestor
  // traps position: fixed). Escape closes natively (close event). The refs
  // hold the latest view state so the native wheel/press listeners subscribe
  // once instead of per render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const viewRef = useRef({ zoom: 1, x: 0, y: 0 });
  const setView = (nextZoom: number, x: number, y: number) => {
    viewRef.current = { zoom: nextZoom, x, y };
    setZoom(nextZoom);
    setOffset({ x, y });
  };

  // Each gallery image opens at fit and unrotated with fresh action feedback;
  // a layout effect so the next image never paints with the previous view.
  useLayoutEffect(() => {
    setView(1, 0, 0);
    setNatural(null);
    setRotation(0);
    setDone(null);
    setActionError(null);
    // setView only touches a ref and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  useEffect(() => () => clearTimeout(doneTimer.current), []);

  /** Zoom keeping `center` (client coords, default dialog center) fixed.
   *  Layout keeps the image fit-centered; transform = translate(offset)
   *  scale(zoom) around the image center, so a rendered point is
   *  center + offset + content × zoom. */
  const zoomTo = (next: number, center?: { clientX: number; clientY: number }) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    const rect = dialog.getBoundingClientRect();
    const cx = (center?.clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
    const cy = (center?.clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);
    const { zoom: prev, x, y } = viewRef.current;
    const ratio = clamped / prev;
    let nx = cx - (cx - x) * ratio;
    let ny = cy - (cy - y) * ratio;
    if (clamped <= 1) {
      nx = 0;
      ny = 0;
    }
    setView(clamped, nx, ny);
  };

  const exitAnnotating = () => {
    setAnnotating(false);
    setBoxes([]);
    setConfirm(null);
    setSubmitError(null);
    setSpaceHeld(false);
  };
  const exitAnnotatingRef = useRef(exitAnnotating);
  exitAnnotatingRef.current = exitAnnotating;
  /** The × button: unsaved notes are never dropped without confirmation. */
  const requestClose = () => {
    if (annotateRef.current.dirty) setConfirm("close");
    else onCloseRef.current();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!isModalDialogOpen(dialog)) showModalDialog(dialog);
    const close = () => onCloseRef.current();
    // Press on the backdrop closes; a press on the image closes at fit zoom
    // (the historical behavior) but starts a pan while zoomed in. Annotation
    // mode ignores both so a stray press cannot discard notes.
    const press = (e: MouseEvent) => {
      if (annotateRef.current.annotating) return;
      if (e.target === dialog) close();
      else if (e.target === imgRef.current && viewRef.current.zoom <= 1) close();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomTo(viewRef.current.zoom * Math.exp(-e.deltaY * 0.002), e);
    };
    // Escape while annotating: leave a note field first, then confirm
    // discarding notes, and only then leave annotation mode.
    const cancel = (e: Event) => {
      const state = annotateRef.current;
      if (!state.annotating) return;
      e.preventDefault();
      const focused = document.activeElement;
      if (focused instanceof HTMLTextAreaElement && dialog.contains(focused)) focused.blur();
      else if (state.dirty) setConfirm("exit");
      else exitAnnotatingRef.current();
    };
    const typing = (e: KeyboardEvent) =>
      e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
    const keyDown = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.key === " " && annotateRef.current.annotating) {
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }
      const gallery = navRef.current;
      if (!gallery || annotateRef.current.annotating || e.altKey || e.ctrlKey || e.metaKey) return;
      const step = PREV_KEYS.has(e.key) ? -1 : NEXT_KEYS.has(e.key) ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      if (step < 0 && gallery.index > 0) gallery.onPrev();
      else if (step > 0 && gallery.index < gallery.count - 1) gallery.onNext();
    };
    const keyUp = (e: KeyboardEvent) => {
      if (e.key === " ") setSpaceHeld(false);
    };
    dialog.addEventListener("mousedown", press);
    dialog.addEventListener("close", close);
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("keydown", keyDown);
    dialog.addEventListener("keyup", keyUp);
    dialog.addEventListener("wheel", wheel, { passive: false });
    return () => {
      dialog.removeEventListener("mousedown", press);
      dialog.removeEventListener("close", close);
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("keydown", keyDown);
      dialog.removeEventListener("keyup", keyUp);
      dialog.removeEventListener("wheel", wheel);
    };
    // zoomTo reads refs only; subscribe once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);
  const pan: PanHandlers = {
    start(e) {
      const { x, y } = viewRef.current;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      panRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: x, baseY: y };
      setPanning(true);
    },
    move(e) {
      const current = panRef.current;
      if (!current || current.pointerId !== e.pointerId) return false;
      setView(viewRef.current.zoom, current.baseX + e.clientX - current.startX, current.baseY + e.clientY - current.startY);
      return true;
    },
    end(e) {
      if (!panRef.current || panRef.current.pointerId !== e.pointerId) return false;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      panRef.current = null;
      setPanning(false);
      return true;
    },
  };

  // The overlay mirrors the image's untransformed layout box; sharing the
  // image transform keeps both aligned at any zoom and pan.
  useEffect(() => {
    if (!annotating) return;
    const img = imgRef.current;
    if (!img) return;
    const measure = () =>
      setFrame({ left: img.offsetLeft, top: img.offsetTop, width: img.offsetWidth, height: img.offsetHeight });
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(img);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [annotating]);

  const submitAnnotations = async () => {
    if (!annotation || !annotationsComplete(boxes)) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await annotation.onSubmit(boxes);
      onCloseRef.current();
    } catch (error) {
      setSubmitError(t("imageAnnotation.submitFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSubmitting(false);
    }
  };
  const leaveAnnotating = () => (boxes.length ? setConfirm("exit") : exitAnnotating());

  const runAction = async (action: ImageAction) => {
    if (!src) return;
    setActionError(null);
    try {
      if (action === "copy") await copyImageToClipboard(src, imgRef.current, imageBlob);
      else if (action === "path") await navigator.clipboard.writeText(sourcePath ?? "");
      else if (!(await saveImage(src, name, sourcePath))) return;
      clearTimeout(doneTimer.current);
      setDone(action);
      doneTimer.current = window.setTimeout(() => setDone(null), COPY_FEEDBACK_MS);
    } catch (error) {
      setActionError(t(`chat.imageActionFailed.${action}`, { message: error instanceof Error ? error.message : String(error) }));
    }
  };
  const reveal = () => {
    if (!sourcePath) return;
    setActionError(null);
    ipc.revealInFileManager(sourcePath).catch((error: unknown) =>
      setActionError(t("chat.imageActionFailed.reveal", { message: error instanceof Error ? error.message : String(error) })));
  };

  const sizeBytes = knownSize ?? (src ? dataUrlBytes(src) : null);
  const meta = imageMetaText({
    width: natural?.width,
    height: natural?.height,
    size: sizeBytes ?? undefined,
  });
  const zoomedIn = zoom > 1;
  const transform = `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`;
  // A quarter turn swaps the fitted box: bounding the layout box by the
  // swapped viewport keeps the rotated image fully on screen.
  const quarterTurn = rotation % 180 !== 0;
  const toolButton =
    "cursor-pointer rounded-full p-1.5 text-white/80 hover:bg-white/15 hover:text-white disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";
  const sideButton =
    "absolute top-1/2 -translate-y-1/2 cursor-pointer rounded-full bg-black/50 p-2 text-white/85 hover:bg-black/70 hover:text-white disabled:cursor-default disabled:opacity-30 disabled:hover:bg-black/50";
  /** Copy-style feedback (spec §4.2): Check icon and a "done" name for 1500ms. */
  const actionButton = (action: ImageAction, label: string, Icon: typeof Copy) => {
    const finished = done === action;
    const text = finished
      ? t(action === "save" ? (isWeb ? "chat.imageDownloadStarted" : "chat.imageSaved") : "chat.imageCopied")
      : label;
    const Shown = finished ? Check : Icon;
    return (
      <button
        type="button"
        onClick={() => void runAction(action)}
        disabled={!src}
        aria-label={text}
        title={text}
        className={toolButton}
      >
        <Shown className="size-4" aria-hidden />
      </button>
    );
  };

  return (
    <dialog
      ref={dialogRef}
      aria-label={name}
      className="fixed inset-0 z-50 flex h-full max-h-none w-full max-w-none items-center justify-center overflow-hidden bg-overlay-backdrop"
    >
      {src ? <img
        ref={imgRef}
        src={src}
        alt={name}
        draggable={false}
        onLoad={(e) =>
          setNatural({
            width: e.currentTarget.naturalWidth,
            height: e.currentTarget.naturalHeight,
          })
        }
        onPointerDown={(e) => {
          if (viewRef.current.zoom > 1) pan.start(e);
        }}
        onPointerMove={(e) => void pan.move(e)}
        onPointerUp={(e) => void pan.end(e)}
        onPointerCancel={(e) => void pan.end(e)}
        style={{
          transform: rotation ? `${transform} rotate(${rotation}deg)` : transform,
          cursor: zoomedIn ? (panning ? "grabbing" : "grab") : "zoom-out",
          touchAction: "none",
          ...(quarterTurn ? { maxWidth: "100vh", maxHeight: "100vw" } : null),
        }}
        className="max-h-full max-w-full select-none object-contain"
      /> : unavailable ? (
        <span className="max-w-[80%] text-center text-body-regular text-white/70">{typeof unavailable === "string" ? unavailable : t("chat.imageUnavailable")}</span>
      ) : (
        <span className="h-48 w-64 max-w-full animate-pulse rounded-lg bg-white/10" aria-hidden />
      )}
      {annotating && frame && (
        <AnnotationOverlay
          frameStyle={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height, transform }}
          zoom={zoom}
          boxes={boxes}
          spaceHeld={spaceHeld}
          pan={pan}
          onAdd={(box) => {
            setBoxes((prev) => [...prev, { ...box, id: nextBoxId.current++, note: "" }]);
            setSubmitError(null);
          }}
        />
      )}
      {/* Header: name + "width × height · size". pointer-events-none keeps
          backdrop wheel/press working through the bar; the × re-enables. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 bg-gradient-to-b from-black/60 to-black/0 px-4 pt-3 pb-6">
        <div className="flex min-w-0 items-baseline gap-3 pt-1.5 text-white/90">
          {nav && nav.count > 1 && (
            <span className="shrink-0 text-caption-1-medium text-white/60 tabular-nums">
              {t("chat.imagePosition", { index: nav.index + 1, count: nav.count })}
            </span>
          )}
          <span className="truncate text-body-medium">{name}</span>
          {meta && (
            <span className="shrink-0 whitespace-nowrap text-caption-1-medium text-white/60">
              {meta}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={requestClose}
          aria-label={t("chat.closePreview")}
          title={t("chat.closePreview")}
          className={`pointer-events-auto shrink-0 ${toolButton}`}
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>
      {nav && nav.count > 1 && (
        <>
          <button
            type="button"
            onClick={nav.onPrev}
            disabled={annotating || nav.index === 0}
            aria-label={t("chat.previousImage")}
            title={t("chat.previousImage")}
            className={`${sideButton} left-4`}
          >
            <ChevronLeft className="size-6" aria-hidden />
          </button>
          <button
            type="button"
            onClick={nav.onNext}
            disabled={annotating || nav.index >= nav.count - 1}
            aria-label={t("chat.nextImage")}
            title={t("chat.nextImage")}
            className={`${sideButton} right-4`}
          >
            <ChevronRight className="size-6" aria-hidden />
          </button>
        </>
      )}
      {actionError && (
        <div role="alert" className="absolute bottom-20 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded-md bg-black/70 px-3 py-1.5 text-caption-1-medium text-white">
          {actionError}
        </div>
      )}
      {annotating && (
        <AnnotationPanel
          boxes={boxes}
          canSubmit={annotationsComplete(boxes)}
          submitting={submitting}
          error={submitError}
          confirmingDiscard={confirm !== null}
          onNote={(id, note) => setBoxes((prev) => prev.map((box) => (box.id === id ? { ...box, note } : box)))}
          onRemove={(id) => setBoxes((prev) => prev.filter((box) => box.id !== id))}
          onSubmit={() => void submitAnnotations()}
          onCancel={leaveAnnotating}
          onKeepEditing={() => setConfirm(null)}
          onConfirmDiscard={() => (confirm === "close" ? onCloseRef.current() : exitAnnotating())}
        />
      )}
      {/* Zoom toolbar: − / percent (click = fit) / + / 1:1 / annotate. */}
      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/60 px-2 py-1">
        <button
          type="button"
          onClick={() => zoomTo(viewRef.current.zoom / ZOOM_STEP)}
          aria-label={t("chat.zoomOut")}
          title={t("chat.zoomOut")}
          className={toolButton}
        >
          <ZoomOut className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setView(1, 0, 0)}
          aria-label={t("chat.resetZoom")}
          title={t("chat.resetZoom")}
          className="min-w-12 cursor-pointer rounded-full px-1 py-1.5 text-center text-caption-1-medium text-white/80 tabular-nums hover:bg-white/15 hover:text-white"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() => zoomTo(viewRef.current.zoom * ZOOM_STEP)}
          aria-label={t("chat.zoomIn")}
          title={t("chat.zoomIn")}
          className={toolButton}
        >
          <ZoomIn className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => {
            const img = imgRef.current;
            // 1:1 = one image pixel per screen pixel: the layout box is the
            // fitted size and the transform scales it, so undo the shrink.
            if (!img || !natural || img.offsetWidth === 0) return;
            zoomTo(natural.width / img.offsetWidth);
          }}
          aria-label={t("chat.actualSize")}
          title={t("chat.actualSize")}
          className={`${toolButton} text-caption-1-medium`}
        >
          1:1
        </button>
        <button
          type="button"
          onClick={() => setRotation((r) => (r + 90) % 360)}
          disabled={!src || annotating}
          aria-label={t("chat.rotateImage")}
          title={t("chat.rotateImage")}
          className={toolButton}
        >
          <RotateCw className="size-4" aria-hidden />
        </button>
        <span className="mx-0.5 h-4 w-px bg-white/25" aria-hidden />
        {actionButton("copy", t("chat.copyImage"), Copy)}
        {actionButton("save", t(isWeb ? "chat.downloadImage" : "chat.saveImage"), Download)}
        {sourcePath && actionButton("path", t("chat.copyImagePath"), Link)}
        {sourcePath && !isWeb && (
          <button
            type="button"
            onClick={reveal}
            aria-label={t("chat.revealImage")}
            title={t("chat.revealImage")}
            className={toolButton}
          >
            <FolderOpen className="size-4" aria-hidden />
          </button>
        )}
        {annotation && src && (
          <button
            type="button"
            onClick={() => {
              if (annotating) return leaveAnnotating();
              // Boxes are stored as fractions of the unrotated image.
              setRotation(0);
              setAnnotating(true);
            }}
            aria-pressed={annotating}
            aria-label={t("imageAnnotation.toggle")}
            title={t("imageAnnotation.toggle")}
            className={`${toolButton} ${annotating ? "bg-white/20 text-white" : ""}`}
          >
            <PenLine className="size-4" aria-hidden />
          </button>
        )}
      </div>
    </dialog>
  );
}
