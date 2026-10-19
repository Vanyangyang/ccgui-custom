import { useEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isWeb } from "@/lib/transport";

/**
 * 对话栏整列的命中标记。`ChatConversation` 把消息区和输入区包在带这个属性的节点里，
 * 拖放落在消息列表上也算进当前对话，而不只认底栏那一条。
 */
export const CONVERSATION_FILE_DROP_SELECTOR = "[data-conversation-file-drop]";

/** 挂载点若在对话栏内，命中整列；否则退回挂载点本身（单测与未包住的调用方）。 */
function resolveDropZone(anchor: HTMLElement | null): HTMLElement | null {
  if (!anchor) return null;
  return anchor.closest<HTMLElement>(CONVERSATION_FILE_DROP_SELECTOR) ?? anchor;
}

/** 物理像素（Windows ScreenToClient）与 CSS 像素都试一次，避免 DPI 下误判在区外。 */
function pointInside(el: HTMLElement, x: number, y: number): boolean {
  const rect = el.getBoundingClientRect();
  const hit = (px: number, py: number) =>
    px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom;
  if (hit(x, y)) return true;
  const scale = window.devicePixelRatio || 1;
  return scale !== 1 && hit(x / scale, y / scale);
}

/** Drag OS files onto the chat conversation.
 *
 * Desktop: with Tauri's default `dragDropEnabled` the webview never sees
 * HTML5 drops. Tauri 2 emits `tauri://drag-*` only to the Webview target —
 * `getCurrentWindow().onDragDropEvent` listens on Window and never fires —
 * so this subscribes via `getCurrentWebview()`. Paths follow the file picker
 * (images become attachments, everything else an @mention at the caret).
 *
 * Web bridge: no native paths exist, so the conversation column takes HTML5
 * drops and only image File blobs make it through (paste pipeline).
 *
 * Returns the drop-zone ref plus `isDragOver` for the visual hint. */
export function useComposerFileDrop({
  disabled,
  onDropPaths,
  onDropFiles,
}: {
  /** No active session, or the host opted out: ignore drops entirely. */
  disabled: boolean;
  /** Desktop drop: absolute native paths. */
  onDropPaths?: (paths: string[]) => void;
  /** Web drop: image File blobs (no path available in a browser). */
  onDropFiles?: (files: File[]) => void;
}): { dropRef: RefObject<HTMLDivElement>; isDragOver: boolean } {
  const dropRef = useRef<HTMLDivElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Latest-callback refs keep the window subscription stable across renders.
  // Written in an effect (not during render) so discarded render work
  // cannot leak stale callbacks into the event subscriptions below.
  const disabledRef = useRef(disabled);
  const pathsRef = useRef(onDropPaths);
  const filesRef = useRef(onDropFiles);
  useEffect(() => {
    disabledRef.current = disabled;
    pathsRef.current = onDropPaths;
    filesRef.current = onDropFiles;
  });

  useEffect(() => {
    if (disabled || isWeb) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    // 【拖放】必须订 webview：Tauri 2 的 drag-drop 不发给 Window 目标，订窗口等于永远收不到。
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const el = resolveDropZone(dropRef.current);
        if (!el) return;
        const payload = event.payload;
        if (payload.type === "leave") {
          setIsDragOver(false);
          return;
        }
        const { x, y } = payload.position;
        const inside = pointInside(el, x, y);
        if (payload.type === "enter" || payload.type === "over") {
          setIsDragOver(inside);
          return;
        }
        if (payload.type === "drop") {
          setIsDragOver(false);
          if (!inside || disabledRef.current) return;
          const paths = payload.paths.map((p) => p.trim()).filter(Boolean);
          if (paths.length > 0) pathsRef.current?.(paths);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [disabled]);

  useEffect(() => {
    if (disabled || !isWeb) return;
    // 【拖放】网页桥同样认整列对话，消息区松手也能带上图片。
    const el = resolveDropZone(dropRef.current);
    if (!el) return;
    // dragenter/dragleave bubble from children; a depth counter keeps the
    // hint from flickering while the pointer moves inside the zone.
    let depth = 0;
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth += 1;
      setIsDragOver(true);
    };
    const onDragOver = (e: DragEvent) => {
      // preventDefault is required or the drop event never fires.
      if (isFileDrag(e)) e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setIsDragOver(false);
      if (disabledRef.current) return;
      const images = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (images.length > 0) filesRef.current?.(images);
    };
    el.addEventListener("dragenter", onDragEnter);
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragenter", onDragEnter);
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, [disabled]);

  return { dropRef, isDragOver };
}
