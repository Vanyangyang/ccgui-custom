/** One rectangle the user drew on an image. Coordinates are fractions of the
 *  image (0..1), so they stay valid at any zoom, pan or export resolution. */
export interface AnnotationBox {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  note: string;
}

export const MAX_ANNOTATION_BOXES = 9;
export const MAX_ANNOTATION_NOTE = 500;
/** Drags smaller than this fraction of either side are treated as clicks. */
export const MIN_BOX_FRACTION = 0.01;

export interface ClientPoint {
  clientX: number;
  clientY: number;
}

export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Map a pointer position onto the image. `rect` is the image's on-screen
 *  (already transformed) bounding box, so zoom and pan need no extra math. */
export function imageFraction(point: ClientPoint, rect: ClientRect): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp01((point.clientX - rect.left) / rect.width),
    y: clamp01((point.clientY - rect.top) / rect.height),
  };
}

/** Normalize a drag between two image fractions into a box; `null` when the
 *  drag is too small to be an intended rectangle. */
export function boxFromDrag(
  start: { x: number; y: number },
  end: { x: number; y: number },
): Omit<AnnotationBox, "id" | "note"> | null {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  if (width < MIN_BOX_FRACTION || height < MIN_BOX_FRACTION) return null;
  return { x, y, width, height };
}

/** Whole-percent bounds for the draft text, e.g. `{ x1: 12, x2: 40, … }`. */
export function boxPercents(box: Pick<AnnotationBox, "x" | "y" | "width" | "height">) {
  const pct = (value: number) => Math.round(clamp01(value) * 100);
  return { x1: pct(box.x), x2: pct(box.x + box.width), y1: pct(box.y), y2: pct(box.y + box.height) };
}

/** Ready to submit: at least one box and every box carries a note. */
export function annotationsComplete(boxes: readonly AnnotationBox[]): boolean {
  return boxes.length > 0 && boxes.every((box) => box.note.trim().length > 0);
}
