import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import {
  boxFromDrag,
  imageFraction,
  MAX_ANNOTATION_BOXES,
  MAX_ANNOTATION_NOTE,
  type AnnotationBox,
} from "./geometry";

export interface PanHandlers {
  start: (event: ReactPointerEvent<HTMLElement>) => void;
  move: (event: ReactPointerEvent<HTMLElement>) => boolean;
  end: (event: ReactPointerEvent<HTMLElement>) => boolean;
}

/** Drawing surface laid exactly over the image. `frameStyle` mirrors the
 *  image's layout box and transform, so boxes follow zoom and pan. Left drag
 *  draws; middle drag or Space + drag pans. */
export function AnnotationOverlay({
  frameStyle,
  zoom,
  boxes,
  onAdd,
  pan,
  spaceHeld,
}: {
  frameStyle: CSSProperties;
  zoom: number;
  boxes: readonly AnnotationBox[];
  onAdd: (box: Omit<AnnotationBox, "id" | "note">) => void;
  pan: PanHandlers;
  spaceHeld: boolean;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const drawRef = useRef<{ pointerId: number; start: { x: number; y: number } } | null>(null);
  const [draft, setDraft] = useState<Omit<AnnotationBox, "id" | "note"> | null>(null);
  const full = boxes.length >= MAX_ANNOTATION_BOXES;
  // Borders live inside the scaled frame; divide by zoom to keep them crisp.
  const border = `${2 / zoom}px`;
  const point = (event: ReactPointerEvent<HTMLElement>) =>
    imageFraction(event, surfaceRef.current!.getBoundingClientRect());

  return (
    <div
      ref={surfaceRef}
      data-annotation-surface=""
      style={{ ...frameStyle, cursor: spaceHeld ? "grab" : full ? "not-allowed" : "crosshair", touchAction: "none" }}
      className="absolute select-none"
      onPointerDown={(event) => {
        if (event.button === 1 || (event.button === 0 && spaceHeld)) {
          pan.start(event);
          return;
        }
        if (event.button !== 0 || full) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drawRef.current = { pointerId: event.pointerId, start: point(event) };
      }}
      onPointerMove={(event) => {
        if (pan.move(event)) return;
        const draw = drawRef.current;
        if (!draw || draw.pointerId !== event.pointerId) return;
        setDraft(boxFromDrag(draw.start, point(event)));
      }}
      onPointerUp={(event) => {
        if (pan.end(event)) return;
        const draw = drawRef.current;
        if (!draw || draw.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        drawRef.current = null;
        setDraft(null);
        const box = boxFromDrag(draw.start, point(event));
        if (box) onAdd(box);
      }}
      onPointerCancel={(event) => {
        pan.end(event);
        drawRef.current = null;
        setDraft(null);
      }}
    >
      {boxes.map((box, index) => (
        <BoxOutline key={box.id} box={box} label={String(index + 1)} border={border} zoom={zoom} />
      ))}
      {draft && <BoxOutline box={draft} border={border} zoom={zoom} dashed />}
    </div>
  );
}

function BoxOutline({
  box,
  label,
  border,
  zoom,
  dashed = false,
}: {
  box: Omit<AnnotationBox, "id" | "note">;
  label?: string;
  border: string;
  zoom: number;
  dashed?: boolean;
}) {
  return (
    <div
      className="pointer-events-none absolute border-red-500"
      style={{
        left: `${box.x * 100}%`,
        top: `${box.y * 100}%`,
        width: `${box.width * 100}%`,
        height: `${box.height * 100}%`,
        borderWidth: border,
        borderStyle: dashed ? "dashed" : "solid",
      }}
    >
      {label && (
        <span
          className="absolute flex size-5 items-center justify-center rounded-full bg-red-500 text-caption-1-medium text-white"
          style={{ left: 0, top: 0, transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

/** Side panel: one note per box, then add to draft / cancel. Discarding
 *  unsaved notes always goes through an explicit confirmation. */
export function AnnotationPanel({
  boxes,
  onNote,
  onRemove,
  canSubmit,
  submitting,
  error,
  confirmingDiscard,
  onSubmit,
  onCancel,
  onConfirmDiscard,
  onKeepEditing,
}: {
  boxes: readonly AnnotationBox[];
  onNote: (id: number, note: string) => void;
  onRemove: (id: number) => void;
  canSubmit: boolean;
  submitting: boolean;
  error: string | null;
  confirmingDiscard: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onConfirmDiscard: () => void;
  onKeepEditing: () => void;
}) {
  const { t } = useTranslation();
  const button = "cursor-pointer rounded-md px-3 py-1.5 text-caption-1-medium disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <aside
      aria-label={t("imageAnnotation.panel")}
      className="absolute top-14 right-4 bottom-20 flex w-72 max-w-[calc(100%-2rem)] flex-col gap-2 rounded-xl bg-black/75 p-3 text-white"
    >
      <p className="text-caption-1-regular text-white/70">{t("imageAnnotation.hint", { max: MAX_ANNOTATION_BOXES })}</p>
      <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {boxes.map((box, index) => (
          <li key={box.id} className="flex items-start gap-2">
            <span className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-caption-1-medium">
              {index + 1}
            </span>
            <textarea
              value={box.note}
              maxLength={MAX_ANNOTATION_NOTE}
              rows={2}
              aria-label={t("imageAnnotation.noteLabel", { index: index + 1 })}
              placeholder={t("imageAnnotation.notePlaceholder")}
              onChange={(event) => onNote(box.id, event.target.value)}
              className="min-w-0 flex-1 resize-none rounded-md bg-white/10 px-2 py-1 text-caption-1-regular text-white placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-white/40"
            />
            <button
              type="button"
              onClick={() => onRemove(box.id)}
              aria-label={t("imageAnnotation.remove", { index: index + 1 })}
              title={t("imageAnnotation.remove", { index: index + 1 })}
              className="mt-1 cursor-pointer rounded-full p-1 text-white/70 hover:bg-white/15 hover:text-white"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ol>
      {error && <p role="alert" className="text-caption-1-regular text-red-300">{error}</p>}
      {confirmingDiscard ? (
        <div className="flex flex-col gap-2" role="group" aria-label={t("imageAnnotation.discardTitle", { count: boxes.length })}>
          <p className="text-caption-1-medium">{t("imageAnnotation.discardTitle", { count: boxes.length })}</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onKeepEditing} className={`${button} bg-white/10 hover:bg-white/20`}>
              {t("imageAnnotation.keepEditing")}
            </button>
            <button type="button" onClick={onConfirmDiscard} className={`${button} bg-red-500 hover:bg-red-600`}>
              {t("imageAnnotation.discard")}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={submitting} className={`${button} bg-white/10 hover:bg-white/20`}>
            {t("imageAnnotation.cancel")}
          </button>
          <button type="button" onClick={onSubmit} disabled={!canSubmit || submitting} className={`${button} bg-white text-black hover:bg-white/90`}>
            {submitting ? t("imageAnnotation.submitting") : t("imageAnnotation.addToDraft")}
          </button>
        </div>
      )}
    </aside>
  );
}
