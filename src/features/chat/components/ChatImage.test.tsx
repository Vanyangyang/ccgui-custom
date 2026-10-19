import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatImage } from "./ChatImage";
import Markdown from "./Markdown";
import { MessageRow } from "./MessageTimeline";
import { ipc, type FileContent } from "@/lib/ipc";
import i18n from "@/lib/i18n";
import { resolveChatImage } from "./chat-image-refs";
import { ImageAnnotationTargetProvider } from "./image-annotation-target";

vi.mock("@/components/base/image-lightbox", () => ({ ImageLightbox: ({ src, name, onClose }: { src: string; name: string; onClose: () => void }) => <dialog open aria-label={name}><img src={src} /><button onClick={onClose}>Close</button></dialog> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const png = "data:image/png;base64,iVBORw0KGgo=";
const other = "data:image/png;base64,YWJj";
const imageContent = (dataUrl: string): FileContent => ({ kind: "image", dataUrl, text: null, truncated: false });

describe("chat image rendering", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.spyOn(ipc, "readFile").mockResolvedValue(imageContent(png));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
  async function render(node: React.ReactNode) { await act(async () => root.render(node)); }

  it.each([
    ["C:/out/a.png", "C:/out/a.png"], ["/tmp/a.png", "/tmp/a.png"],
    ["assets/a.png", "/workspace/assets/a.png"], ["a.png", "/workspace/a.png"],
    ["ccgui-file:C%3A%2Fout%2Fa.png", "C:/out/a.png"],
  ])("loads local Markdown reference %s", async (ref, path) => {
    await render(<Markdown text={`![example](${ref})`} workspacePath="/workspace" />);
    expect(ipc.readFile).toHaveBeenCalledWith(path);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(png);
  });

  it("renders data URLs without IPC and opens a portal preview outside a paragraph and link", async () => {
    await render(<Markdown text={`[**![example](${png})**](https://example.test)`} workspacePath="/workspace" />);
    expect(ipc.readFile).not.toHaveBeenCalled();
    expect(container.querySelector("a button")).toBeNull();
    await act(async () => container.querySelector("button")!.click());
    expect(document.body.querySelector("dialog img")?.getAttribute("src")).toBe(png);
    expect(container.querySelector("dialog")).toBeNull();
    expect(container.querySelector("p div")).toBeNull();
  });

  it("offers an onboarding image target only when that preview supports annotation", async () => {
    await render(<ChatImage src={png} />);
    expect(container.querySelector('[data-onboarding-target="image-preview"]')).toBeNull();
    await render(<ImageAnnotationTargetProvider value={{ sessionKey: "guide-image", supportsImages: true, attachFiles: vi.fn() }}>
      <ChatImage src={png} />
    </ImageAnnotationTargetProvider>);
    const target = container.querySelector<HTMLButtonElement>('[data-onboarding-target="image-preview"]');
    expect(target).not.toBeNull();
    await act(async () => target!.click());
    expect(document.body.querySelector("dialog img")?.getAttribute("src")).toBe(png);
  });

  it.each(["https://example.test/a.png", "//example.test/a.png", "\\\\host\\a.png", "file:///tmp/a.png", "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "ccgui-file:https%3A%2F%2Fexample.test%2Fa.png"])("blocks %s without browser or IPC loading", async src => {
    await render(<ChatImage src={src} workspacePath="/workspace" />);
    expect(ipc.readFile).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("base64");
  });

  it("shows the filename when file loading fails or raster decoding fails", async () => {
    vi.mocked(ipc.readFile).mockRejectedValueOnce(new Error("missing"));
    await render(<ChatImage src="/tmp/missing.png" />);
    expect(container.textContent).toContain("missing.png");
    await render(<ChatImage src="/tmp/broken.png" />);
    await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("broken.png");
  });

  it("ignores a late result after switching sources and after unmount", async () => {
    let finish!: (value: FileContent) => void;
    vi.mocked(ipc.readFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(<ChatImage src="/tmp/old.png" />);
    await render(<ChatImage src={other} />);
    await act(async () => finish(imageContent(png)));
    expect(container.querySelector("img")?.getAttribute("src")).toBe(other);
    vi.mocked(ipc.readFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(<ChatImage src="/tmp/late.png" />);
    await render(null);
    await act(async () => finish(imageContent(png)));
    expect(container.querySelector("img")).toBeNull();
  });

  it("displays assistant attachments again after a history remount", async () => {
    const row = <MessageRow message={{ seq: 4, role: "assistant", text: "Done", ts: null, images: ["art/result.png"] }} workspacePath="/workspace" turnFinal={false} />;
    await render(row);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(png);
    await render(null); await render(row);
    expect(ipc.readFile).toHaveBeenCalledTimes(2);
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(i18n.t("chat.previewImage", { name: "result.png" }));
  });

  it("rejects backend responses that supply a remote or active image URL", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue(imageContent("https://example.test/a.png"));
    await render(<ChatImage src="/tmp/a.png" />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("keeps ordinary file links intact and rejects encoded network paths", async () => {
    await render(<Markdown text="[code](/tmp/example.ts)" workspacePath="/workspace" />);
    expect(container.querySelector("a")?.className).toBe("md-file-link");
    expect(resolveChatImage("%2F%2Fexample.test/a.png", "/workspace")).toBeNull();
    expect(resolveChatImage(" https://example.test/a.png", "/workspace")).toBeNull();
  });
});
