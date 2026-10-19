import type { AnnotationBox } from "./geometry";

const STROKE = "#ef4444";
const LABEL_TEXT = "#ffffff";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image could not be decoded"));
    image.src = src;
  });
}

/** Draw the numbered boxes onto a copy of the image at its natural size and
 *  export a PNG. The source image is never modified. */
export async function renderAnnotatedImage(src: string, boxes: readonly AnnotationBox[]): Promise<Blob> {
  const image = await loadImage(src);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) throw new Error("Image has no size");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.drawImage(image, 0, 0);
  const short = Math.min(width, height);
  const line = Math.max(2, Math.round(short / 180));
  const radius = Math.max(12, Math.round(short / 32));
  context.lineWidth = line;
  context.font = `600 ${Math.round(radius * 1.2)}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  boxes.forEach((box, index) => {
    const x = box.x * width;
    const y = box.y * height;
    context.strokeStyle = STROKE;
    context.strokeRect(x, y, box.width * width, box.height * height);
    // Keep the number badge inside the image even for boxes at the edge.
    const cx = Math.min(width - radius, Math.max(radius, x));
    const cy = Math.min(height - radius, Math.max(radius, y));
    context.fillStyle = STROKE;
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = LABEL_TEXT;
    context.fillText(String(index + 1), cx, cy);
  });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed"))), "image/png");
  });
}
