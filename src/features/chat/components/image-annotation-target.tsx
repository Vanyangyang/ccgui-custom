import { createContext, useContext } from "react";
import type { TFunction } from "i18next";
import { boxPercents, type AnnotationBox } from "@/components/base/image-annotation/geometry";
import { renderAnnotatedImage } from "@/components/base/image-annotation/render";
import { insertSideAnswer } from "@/features/sidechat/insert-answer";

/** Where annotations of images in one conversation pane go: that pane's own
 *  composer. Absent outside a conversation, which hides the annotate toggle. */
export interface ImageAnnotationTarget {
  sessionKey: string;
  supportsImages: boolean;
  /** The composer's paste pipeline: saves blobs and attaches them. */
  attachFiles: (files: File[]) => void;
}

const TargetContext = createContext<ImageAnnotationTarget | null>(null);
export const ImageAnnotationTargetProvider = TargetContext.Provider;
export function useImageAnnotationTarget(): ImageAnnotationTarget | null {
  return useContext(TargetContext);
}

export interface AnnotatedImage {
  /** Data URL shown in the lightbox. */
  src: string;
  name: string;
  /** Local path when the image came from a file, for the text-only fallback. */
  sourcePath?: string;
  /** Composer attachments are already attached; chat images also send the original. */
  includeOriginal: boolean;
}

/** Plain-text block appended to the draft: header, optional source path, then
 *  one line per box with whole-percent bounds and its note. */
export function annotationDraftText(
  t: TFunction,
  image: Pick<AnnotatedImage, "name" | "sourcePath">,
  boxes: readonly AnnotationBox[],
  withImage: boolean,
): string {
  const lines = [
    `${t("imageAnnotation.draftHeader", { name: image.name })}${t(withImage ? "imageAnnotation.draftWithImage" : "imageAnnotation.draftTextOnly")}`,
  ];
  if (image.sourcePath) lines.push(t("imageAnnotation.draftSource", { path: image.sourcePath }));
  boxes.forEach((box, index) => {
    const note = box.note.trim().replace(/\s*\n\s*/g, " ");
    lines.push(t("imageAnnotation.draftItem", { index: index + 1, ...boxPercents(box), note }));
  });
  return lines.join("\n");
}

function dataUrlFile(src: string, name: string): File | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(src);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: match[1].toLowerCase() });
}

function annotatedName(name: string): string {
  const stem = name.replace(/\.[a-z0-9]+$/i, "") || "image";
  return `${stem}-annotated.png`;
}

/** Attach the annotated copy (plus the original for chat images) through the
 *  composer pipeline, then append the notes to that session's draft. Never
 *  sends. Rejects before touching the draft when the image cannot be
 *  rendered or attached, so the lightbox keeps the notes. */
export async function submitImageAnnotation(
  target: ImageAnnotationTarget,
  image: AnnotatedImage,
  boxes: readonly AnnotationBox[],
  t: TFunction,
  render: typeof renderAnnotatedImage = renderAnnotatedImage,
): Promise<void> {
  if (!target.sessionKey) throw new Error(t("imageAnnotation.noTarget"));
  if (target.supportsImages) {
    const annotated = await render(image.src, boxes);
    const files: File[] = [];
    const original = image.includeOriginal ? dataUrlFile(image.src, image.name) : null;
    if (original) files.push(original);
    files.push(new File([annotated], annotatedName(image.name), { type: "image/png" }));
    target.attachFiles(files);
  }
  insertSideAnswer(target.sessionKey, annotationDraftText(t, image, boxes, target.supportsImages));
}
