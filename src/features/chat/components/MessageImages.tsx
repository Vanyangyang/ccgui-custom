import { ChatImage } from "./ChatImage";

/** User uploads and assistant artifacts share the same local-only renderer. */
export function MessageImages({ images, workspacePath = "" }: { images: string[]; workspacePath?: string }) {
  return <div className="flex min-w-0 max-w-full flex-wrap gap-2 pb-1.5">
    {images.map((src, index) => <ChatImage key={index + ":" + src} src={src} workspacePath={workspacePath} />)}
  </div>;
}
