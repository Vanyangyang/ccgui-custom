import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { Message } from "@/lib/ipc";
import { resolveChatImage } from "./chat-image-refs";

export interface GalleryImage {
  src: string;
  alt?: string;
}

/** Lists the conversation's images on demand: read only when a preview
 *  opens, so streaming deltas never recompute it or re-render memoized rows. */
interface ChatImageGallery {
  list: () => GalleryImage[];
  workspacePath: string;
}

const GalleryContext = createContext<ChatImageGallery | null>(null);

export function ChatImageGalleryProvider({ messages, workspacePath, children }: {
  messages: Message[];
  workspacePath: string;
  children: ReactNode;
}) {
  const latest = useRef(messages);
  latest.current = messages;
  const value = useMemo<ChatImageGallery>(
    () => ({ list: () => collectChatImages(latest.current, workspacePath), workspacePath }),
    [workspacePath],
  );
  return <GalleryContext.Provider value={value}>{children}</GalleryContext.Provider>;
}

export function useChatImageGallery(): ChatImageGallery | null {
  return useContext(GalleryContext);
}

/** Markdown images `![alt](dest "title")`, dest optionally in <angle brackets>. */
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
/** Fenced blocks; an unclosed fence (still streaming) runs to the end. */
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;
const INLINE_CODE = /(`+)[^\n]*?\1/g;

export function markdownImages(text: string): GalleryImage[] {
  if (!text.includes("![")) return [];
  const prose = text.replace(FENCE, "").replace(INLINE_CODE, "");
  return [...prose.matchAll(MARKDOWN_IMAGE)].map((match) => {
    const src = match[2].startsWith("<") ? match[2].slice(1, -1) : match[2];
    return match[1] ? { src, alt: match[1] } : { src };
  });
}

/** Images in display order: each message's attachments, then the assistant
 *  reply's Markdown images. Later repeats of the same image are dropped. */
export function collectChatImages(messages: Message[], workspacePath: string): GalleryImage[] {
  const seen = new Set<string>();
  const out: GalleryImage[] = [];
  const add = (image: GalleryImage) => {
    const key = chatImageKey(image.src, workspacePath);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(image);
  };
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    for (const src of message.images ?? []) add({ src });
    if (message.role === "assistant") for (const image of markdownImages(message.text)) add(image);
  }
  return out;
}

/** Identity of an image reference regardless of spelling: percent
 *  encoding, slash direction and Windows drive-letter case. */
export function chatImageKey(src: string, workspacePath: string): string | null {
  const resolved = resolveChatImage(src, workspacePath);
  if (!resolved) return null;
  if (resolved.kind === "data") return resolved.value;
  const path = resolved.value.replace(/\\/g, "/");
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
}

/** The clicked image's gallery and position. An image the scan cannot see
 *  (outside the timeline, or no provider) still opens on its own. */
export function galleryFor(
  gallery: ChatImageGallery | null,
  clicked: GalleryImage,
  workspacePath: string,
): { items: GalleryImage[]; index: number } {
  if (!gallery || gallery.workspacePath !== workspacePath) return { items: [clicked], index: 0 };
  const items = gallery.list();
  const key = chatImageKey(clicked.src, workspacePath);
  const index = key ? items.findIndex((item) => chatImageKey(item.src, workspacePath) === key) : -1;
  if (index < 0) return { items: [clicked], index: 0 };
  // The clicked occurrence's caption wins over an earlier bare repeat.
  if (clicked.alt && !items[index].alt) items[index] = clicked;
  return { items, index };
}
