import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import { ipc } from "../../src/lib/ipc";
import { sessionKey, useChatStore } from "../../src/features/chat/store";
import { ChatImage } from "../../src/features/chat/components/ChatImage";
import { ImageAnnotationTargetProvider } from "../../src/features/chat/components/image-annotation-target";

// Entirely synthetic pixels and paths; IPC, storage and the composer are
// document-local. `?images=0` simulates an engine without image input.
const canvas = document.createElement("canvas");
canvas.width = 960; canvas.height = 540;
const context = canvas.getContext("2d")!;
context.fillStyle = "#0c4a6e"; context.fillRect(0, 0, 960, 540);
context.fillStyle = "#f8fafc"; context.fillRect(600, 60, 300, 80);
context.fillStyle = "#0f172a"; context.font = "32px sans-serif"; context.fillText("Truncated butt", 620, 112);
context.fillStyle = "white"; context.font = "48px sans-serif"; context.fillText("Synthetic UI · 960 × 540", 60, 300);
const png = canvas.toDataURL("image/png");
ipc.readFile = async path => {
  if (!path.startsWith("C:/fixture/")) throw new Error("Unexpected fixture path");
  return { kind: "image", dataUrl: png, text: null, truncated: false };
};

const tab = { engine: "claude", sessionId: "fixture", workspacePath: "C:/fixture" };
const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
useChatStore.setState({ active: tab, openTabs: [tab], drafts: { [key]: "已有草稿" } });
const supportsImages = new URLSearchParams(location.search).get("images") !== "0";

function Fixture() {
  const [attached, setAttached] = useState<{ name: string; url: string }[]>([]);
  const draft = useChatStore(state => state.drafts[key] ?? "");
  const [dark, setDark] = useState(false);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  const target = {
    sessionKey: key,
    supportsImages,
    attachFiles: (files: File[]) => setAttached(prev => [...prev, ...files.map(file => ({ name: file.name, url: URL.createObjectURL(file) }))]),
  };
  return <ImageAnnotationTargetProvider value={target}>
    <main className="min-h-dvh bg-background-primary-default p-3 text-text-primary">
      <div className="mx-auto max-w-[750px] space-y-5">
        <h1 className="text-heading-3">图片批注</h1>
        <button onClick={() => setDark(!dark)}>切换主题</button>
        <ChatImage src="C:/fixture/ui.png" alt="ui.png" workspacePath="C:/fixture" />
        <section aria-label="attachments" className="flex flex-wrap gap-3">
          {attached.map(file => <figure key={file.url}><img src={file.url} alt={file.name} className="max-h-48" /><figcaption>{file.name}</figcaption></figure>)}
        </section>
        <pre aria-label="draft" className="whitespace-pre-wrap">{draft}</pre>
      </div>
    </main>
  </ImageAnnotationTargetProvider>;
}
createRoot(document.getElementById("fixture")!).render(<Fixture />);
