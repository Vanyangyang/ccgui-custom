import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { assertRuntimeSubmissionAllowed, registerRuntimeCheckpointParticipant } from "@/lib/runtime-checkpoint";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { fileName } from "@/features/files/store";
import { dataUrlBytes, imageDimensions } from "@/utils/image-meta";

/** Extensions routed through the path-based image pipeline; anything else a
 *  user picks becomes an @mention instead of an attachment. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
/** Chip thumbnail plus the metadata shown beside it: pixel dimensions and
 *  file size recovered from the preview data URL (exact base64 math, no
 *  extra stat IPC). Fields appear asynchronously after the preview loads. */
export interface AttachmentPreview {
  url: string;
  name: string;
  width?: number;
  height?: number;
  size?: number;
}

/** Composer image attachments: the attached image paths, their chip
 * thumbnails, and clipboard-paste handling.
 *
 * Thumbnail URLs are data URLs from the backend's readFile — the asset
 * protocol scope denies ~/.ccgui-next (app home holds secrets), so asset://
 * thumbnails of pasted images would be blocked. Same pipeline MessageImages
 * uses.
 *
 * Clipboard images are blobs without a path: persist them via the backend
 * so they flow through the same path-based pipeline every engine consumes
 * (codex -i, kimi path injection, pi/omp @file, claude/grok base64). */
export interface ComposerImages {
  images: string[];
  /** path → { preview-url, display name } for attachment chip thumbnails. */
  previews: Record<string, AttachmentPreview>;
  imageError: string | null;
  importingImages: boolean;
  removeImage: (path: string) => void;
  clearImages: () => void;
  /** Capture attachment identities now; acceptance removes only those entries. */
  captureImageSubmission: (paths: readonly string[]) => () => void;
  pasteImages: (files: File[]) => void;
  importImageFiles: (paths: string[], supported: boolean) => void;
  dismissImageError: () => void;
}

/** Optional durable draft owner, used by Sidechat across panel unmounts. */
export interface ComposerImageDraft {
  paths: string[];
  getPaths: () => string[];
  update: (updater: (paths: string[]) => string[]) => void;
}

interface ImageCheckpointOwner { key?: string; paths: () => string[]; pending: () => number }
const imageOwners = new Map<string, ImageCheckpointOwner>();
const restoredImages = new Map<string, string[]>();
const imageReadyWaiters = new Set<() => void>();
function imagesClaimed() {
  if (restoredImages.size) return;
  for (const resolve of imageReadyWaiters) resolve();
  imageReadyWaiters.clear();
}
const unregisterImageCheckpoint = registerRuntimeCheckpointParticipant({
  id: "chat-images",
  capture: () => ({ version: 1, drafts: Object.fromEntries([...imageOwners.values()]
    .filter((owner) => owner.key && owner.paths().length).map((owner) => [owner.key!, owner.paths()])) }),
  restore(value) {
    const snapshot = value as { version?: unknown; drafts?: unknown } | null;
    if (snapshot?.version !== 1 || !snapshot.drafts || typeof snapshot.drafts !== "object" || Array.isArray(snapshot.drafts)) throw new Error("Invalid composer image checkpoint");
    const entries = Object.entries(snapshot.drafts);
    if (entries.some(([key, paths]) => !key || !Array.isArray(paths) || paths.some((path) => typeof path !== "string"))) throw new Error("Invalid composer image identity");
    restoredImages.clear();
    for (const [key, paths] of entries) if ((paths as string[]).length) restoredImages.set(key, paths as string[]);
  },
  readiness() {
    const reasons: string[] = [];
    const counts = new Map<string, number>();
    for (const owner of imageOwners.values()) if (owner.key) counts.set(owner.key, (counts.get(owner.key) ?? 0) + 1);
    for (const owner of imageOwners.values()) {
      if (owner.pending()) reasons.push("image-import-pending");
      if (!owner.paths().length) continue;
      if (!owner.key) reasons.push("unmigrated-image-attachments");
      else if ((counts.get(owner.key) ?? 0) > 1) reasons.push(`duplicate-composer-identity:${owner.key}`);
    }
    if (restoredImages.size) reasons.push("image-composer-not-mounted");
    return reasons;
  },
  ready: () => restoredImages.size ? new Promise<void>((resolve) => { imageReadyWaiters.add(resolve); }) : Promise.resolve(),
});
if (import.meta.hot) import.meta.hot.dispose(unregisterImageCheckpoint);

export function useComposerImages(draftKey?: string, draft?: ComposerImageDraft): ComposerImages {
  const { t } = useTranslation();
  const [attachments, setAttachmentState] = useState<{ path: string }[]>(() => (draftKey ? restoredImages.get(draftKey) ?? [] : []).map((path) => ({ path })));
  const effectiveAttachments = useMemo(() => draft ? draft.paths.map((path) => ({ path })) : attachments, [draft?.paths, attachments]);
  const attachmentRef = useRef(effectiveAttachments);
  attachmentRef.current = effectiveAttachments;
  const pendingImports = useRef(0);
  const [importingImages, setImportingImages] = useState(false);
  const checkpointId = useId();
  const setAttachments = useCallback((next: { path: string }[] | ((previous: { path: string }[]) => { path: string }[])) => {
    if (draft) {
      draft.update((paths) => {
        const previous = paths.map((path) => ({ path }));
        return (typeof next === "function" ? next(previous) : next).map((entry) => entry.path);
      });
      return;
    }
    const value = typeof next === "function" ? next(attachmentRef.current) : next;
    attachmentRef.current = value;
    setAttachmentState(value);
  }, [draft]);
  useEffect(() => {
    const restored = !draft && draftKey ? restoredImages.get(draftKey) : undefined;
    if (restored) setAttachments(restored.map((path) => ({ path })));
    const owner = { key: draftKey, paths: () => draft ? draft.getPaths() : attachmentRef.current.map((entry) => entry.path), pending: () => pendingImports.current };
    imageOwners.set(checkpointId, owner);
    if (draftKey) restoredImages.delete(draftKey);
    imagesClaimed();
    return () => { if (imageOwners.get(checkpointId) === owner) imageOwners.delete(checkpointId); };
  }, [checkpointId, draftKey, draft, setAttachments]);
  const images = useMemo(() => effectiveAttachments.map((entry) => entry.path), [effectiveAttachments]);
  const [previews, setPreviews] = useState<Record<string, AttachmentPreview>>({});
  const [imageError, setImageError] = useState<string | null>(null);
  useEffect(() => {
    const present = new Set(images);
    setPreviews((prev) => {
      const removed = Object.keys(prev).filter((path) => !present.has(path));
      if (!removed.length) return prev;
      const next = { ...prev }; for (const path of removed) delete next[path];
      return next;
    });
  }, [images]);
  const captureImageSubmission = useCallback((paths: readonly string[]) => {
    if (draft) {
      const submitted = new Set(paths);
      return () => draft.update((previous) => previous.filter((path) => !submitted.has(path)));
    }
    const submitted = new Set(attachments.filter((entry) => paths.includes(entry.path)));
    return () => setAttachments((prev) => {
      const next = prev.filter((entry) => !submitted.has(entry));
      return next.length === prev.length ? prev : next;
    });
  }, [attachments, draft]);
  /** Drop one attachment and its preview. */
  const removeImage = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((entry) => entry.path !== path));
    setPreviews((prev) => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, [setAttachments]);
  /** Clear all attachments (on submit). */
  const clearImages = useCallback(() => {
    setAttachments([]);
    setPreviews((prev) => (Object.keys(prev).length > 0 ? {} : prev));
  }, [setAttachments]);
  /** Dismiss the paste-error banner without clearing attachments. */
  const dismissImageError = useCallback(() => setImageError(null), []);
  /** Resolve one attachment's chip thumbnail through readFile (data URL),
   * then fill in size (from the data URL payload) and pixel dimensions (from
   * decoding the image). Unreadable/oversized files simply get no thumbnail —
   * the chip falls back to a plain filename. */
  const loadPreview = useCallback((path: string, name: string) => {
    ipc
      .readFile(path)
      .then(async (content) => {
        if (content.kind !== "image" || !content.dataUrl) return;
        const url = content.dataUrl;
        const dims = (await imageDimensions(url)) ?? undefined;
        setPreviews((prev) => ({
          ...prev,
          [path]: {
            url,
            name,
            width: dims?.width,
            height: dims?.height,
            size: dataUrlBytes(url) ?? undefined,
          },
        }));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    for (const { path } of attachmentRef.current) loadPreview(path, fileName(path));
  }, [loadPreview, draftKey]);
  const pasteImages = useCallback(
    (files: File[]) => {
      assertRuntimeSubmissionAllowed();
      setImageError(null);
      for (const file of files) {
        const ext = file.type.split("/")[1]?.toLowerCase() ?? "png";
        if (!IMAGE_EXTENSIONS.includes(ext)) continue;
        const name = file.name || `pasted-image.${ext}`;
        const reader = new FileReader();
        pendingImports.current++;
        setImportingImages(true);
        let finished = false;
        const finish = () => { if (!finished) { finished = true; pendingImports.current--; setImportingImages(pendingImports.current > 0); } };
        reader.onerror = () => { setImageError(t("chat.imagePasteFailed", { message: String(reader.error ?? "Image read failed") })); finish(); };
        reader.onabort = finish;
        reader.onload = () => {
          const dataUrl = typeof reader.result === "string" ? reader.result : "";
          const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
          if (!base64) { finish(); return; }
          ipc
            .savePastedImage(base64, ext)
            .then((path) => {
              setAttachments((prev) => [...prev, { path }]);
              loadPreview(path, name);
            })
            .catch((err) => {
              setImageError(t("chat.imagePasteFailed", { message: String(err) }));
            }).finally(finish);
        };
        try { reader.readAsDataURL(file); } catch (error) { finish(); throw error; }
      }
    },
    [t, loadPreview, setAttachments],
  );

  /** Import user-picked image files: copy them into the app sandbox (picked
   * paths live outside it, so the engines' path-based pipeline cannot read
   * them in place), then attach with chip previews. `supported` gates engines
   * without image input. */
  const importImageFiles = useCallback(
    (paths: string[], supported: boolean) => {
      assertRuntimeSubmissionAllowed();
      setImageError(null);
      if (!supported) {
        setImageError(t("chat.imagesUnsupported"));
        return;
      }
      pendingImports.current++;
      setImportingImages(true);
      ipc
        .importAttachments(paths)
        .then((imported) => {
          setAttachments((prev) => {
            const seen = new Set(prev.map((entry) => entry.path));
            const added = imported.filter((p) => !seen.has(p));
            return added.length > 0 ? [...prev, ...added.map((path) => ({ path }))] : prev;
          });
          for (const path of imported) {
            loadPreview(path, fileName(path));
          }
        })
        .catch((err) => {
          setImageError(t("chat.imageImportFailed", { message: String(err) }));
        }).finally(() => { pendingImports.current--; setImportingImages(pendingImports.current > 0); });
    },
    [t, loadPreview, setAttachments],
  );
  return {
    images,
    previews,
    imageError,
    importingImages,
    removeImage,
    clearImages,
    captureImageSubmission,
    pasteImages,
    importImageFiles,
    dismissImageError,
  };
}
