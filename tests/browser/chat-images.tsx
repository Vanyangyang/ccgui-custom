import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import { ipc } from "../../src/lib/ipc";
import Markdown from "../../src/features/chat/components/Markdown";
import { MessageRow } from "../../src/features/chat/components/MessageTimeline";

// Entirely synthetic pixels and paths; no real user data or network requests.
const canvas = document.createElement("canvas");
canvas.width = 960; canvas.height = 540;
const context = canvas.getContext("2d")!;
const gradient = context.createLinearGradient(0, 0, 960, 540);
gradient.addColorStop(0, "#0c4a6e"); gradient.addColorStop(1, "#22c55e");
context.fillStyle = gradient; context.fillRect(0, 0, 960, 540);
context.fillStyle = "white"; context.font = "48px sans-serif"; context.fillText("Synthetic image · 960 × 540", 60, 280);
const png = canvas.toDataURL("image/png");
ipc.readFile = async path => {
  if (path.includes("missing")) throw new Error("Synthetic missing file");
  if (!path.startsWith("/fixture/") && !path.startsWith("C:/fixture/")) throw new Error("Unexpected fixture path");
  return { kind: "image", dataUrl: png, text: null, truncated: false };
};

function Fixture() {
  const [revision, setRevision] = useState(0);
  const [dark, setDark] = useState(false);
  return <main className="min-h-dvh bg-background-primary-default p-3 text-text-primary">
    <div className="mx-auto max-w-[750px] space-y-5">
      <h1 className="text-heading-3">聊天图片预览</h1>
      <p>合成测试数据：助手附件、Markdown 本地图片、失效文件、远程阻止与历史重新挂载。</p>
      <div className="flex gap-4">
        <button onClick={() => setRevision(value => value + 1)}>重新挂载历史</button>
        <button onClick={() => { document.documentElement.classList.toggle("dark", !dark); setDark(!dark); }}>切换主题</button>
      </div>
      <section key={revision} className="min-w-0 space-y-5">
        <MessageRow message={{ seq: 1, role: "assistant", ts: null, text: "已生成图片。点击缩略图可放大。", images: ["art/result.png"] }} workspacePath="/fixture" turnFinal={false} />
        <Markdown workspacePath="/fixture" text={'段落中的图片：![local](C:/fixture/local.png)\n\n[![linked](ccgui-file:%2Ffixture%2Flinked.png)](https://example.invalid/)\n\n![missing](/fixture/missing.png)\n\n![blocked](https://example.invalid/remote.png)'} />
        <MessageRow message={{ seq: 2, role: "user", ts: null, text: "用户上传图片", images: [png] }} workspacePath="/fixture" turnFinal={false} />
      </section>
    </div>
  </main>;
}
createRoot(document.getElementById("fixture")!).render(<Fixture />);
