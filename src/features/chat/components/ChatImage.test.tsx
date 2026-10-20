import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatImage } from "./ChatImage";
import Markdown from "./Markdown";
import { MessageRow } from "./MessageTimeline";
import { ipc, type FileContent, type Message } from "@/lib/ipc";
import { ChatImageGalleryProvider, chatImageKey, collectChatImages, markdownImages } from "./chat-image-gallery";
import i18n from "@/lib/i18n";
import { resolveChatImage } from "./chat-image-refs";
import { ImageAnnotationTargetProvider } from "./image-annotation-target";

const platform = vi.hoisted(() => ({ web: true }));
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, get isWeb() { return platform.web; } };
});
vi.mock("@/components/base/image-lightbox", () => ({ ImageLightbox: ({ src, name, onClose, nav, sourcePath, sizeBytes }: {
  src: string | null; name: string; onClose: () => void; sourcePath?: string; sizeBytes?: number;
  nav?: { index: number; count: number; onPrev: () => void; onNext: () => void };
}) => <dialog open aria-label={name} data-source={sourcePath} data-size={sizeBytes}>{src && <img src={src} />}
  {nav && <><output>{`${nav.index + 1}/${nav.count}`}</output><button onClick={nav.onPrev}>Prev</button><button onClick={nav.onNext}>Next</button></>}
  <button onClick={onClose}>Close</button></dialog> }));
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

  it("steps through the conversation's images from any preview", async () => {
    const third = "data:image/png;base64,ZGVm";
    vi.mocked(ipc.readFile).mockImplementation(async path => imageContent(path === "/workspace/b.png" ? other : third));
    const messages = [
      { seq: 1, role: "user", text: "look", images: [png], ts: null },
      { seq: 2, role: "assistant", text: "![B](b.png)\n\n```md\n![skip](skip.png)\n```\n![C](<C:/out/c.png>)", ts: null },
    ] as Message[];
    await render(<ChatImageGalleryProvider messages={messages} workspacePath="/workspace">
      <Markdown text={messages[1].text} workspacePath="/workspace" />
    </ChatImageGalleryProvider>);
    await act(async () => container.querySelector("button")!.click());
    const dialog = () => document.body.querySelector("dialog")!;
    const press = (label: string) => act(async () => [...dialog().querySelectorAll("button")].find(b => b.textContent === label)!.click());
    expect(dialog().getAttribute("aria-label")).toBe("B");
    expect(dialog().querySelector("output")?.textContent).toBe("2/3");
    expect(dialog().dataset.source).toBe("/workspace/b.png");
    await press("Next");
    expect(dialog().getAttribute("aria-label")).toBe("C");
    expect(dialog().querySelector("img")?.getAttribute("src")).toBe(third);
    expect(ipc.readFile).toHaveBeenLastCalledWith("C:/out/c.png");
    await press("Prev");
    await press("Prev");
    expect(dialog().querySelector("output")?.textContent).toBe("1/3");
    expect(dialog().querySelector("img")?.getAttribute("src")).toBe(png);
    expect(dialog().dataset.source).toBeUndefined();
    expect(ipc.readFile).not.toHaveBeenCalledWith("/workspace/skip.png");
  });

  it("opens a lone preview without a gallery outside the timeline", async () => {
    await render(<ChatImage src={png} />);
    await act(async () => container.querySelector("button")!.click());
    expect(document.body.querySelector("dialog output")).toBeNull();
  });
});

describe("desktop chat image loading", () => {
  let container: HTMLDivElement;
  let root: Root;
  const created: string[] = [];
  const revoked: string[] = [];
  // 6MB PNG: over read_file's 5MB data-URL preview cap.
  const bigPng = new Uint8Array(6 * 1024 * 1024);
  bigPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  beforeEach(() => {
    platform.web = false;
    created.length = 0;
    revoked.length = 0;
    vi.stubGlobal("URL", Object.assign(Object.create(URL), {
      createObjectURL: () => { const url = `blob:test/${created.length + 1}`; created.push(url); return url; },
      revokeObjectURL: (url: string) => { revoked.push(url); },
    }));
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.spyOn(ipc, "readFile");
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); platform.web = true;
  });
  async function render(node: React.ReactNode) { await act(async () => root.render(node)); }

  it("shows images beyond the old 5MB cap from raw bytes and releases them", async () => {
    vi.spyOn(ipc, "readImageBytes").mockResolvedValue(bigPng.buffer);
    await render(<ChatImage src="big.png" workspacePath="G:/w" />);
    expect(ipc.readImageBytes).toHaveBeenCalledWith("G:/w/big.png");
    expect(ipc.readFile).not.toHaveBeenCalled();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:test/1");
    await act(async () => container.querySelector("button")!.click());
    const dialog = document.body.querySelector("dialog")!;
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("blob:test/1");
    expect(dialog.dataset.size).toBe(String(bigPng.length));
    // The viewer reuses the thumbnail's bytes instead of reading again.
    expect(ipc.readImageBytes).toHaveBeenCalledTimes(1);
    await render(<ChatImage src="other.png" workspacePath="G:/w" />);
    expect(revoked).toEqual(["blob:test/1"]);
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(revoked).toEqual(["blob:test/1", "blob:test/2"]);
  });

  it("says why an image outside every workspace and grant is not shown", async () => {
    await i18n.changeLanguage("en");
    vi.spyOn(ipc, "readImageBytes").mockRejectedValue("path is outside the registered workspaces: D:/x/a.png");
    await render(<ChatImage src="D:/x/a.png" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("span[title]")?.getAttribute("title")).toMatch(/outside the registered workspaces/);
  });

  it("refuses bytes that are not a raster image", async () => {
    vi.spyOn(ipc, "readImageBytes").mockResolvedValue(new TextEncoder().encode("<svg onload=alert(1)>").buffer);
    await render(<ChatImage src="/w/fake.png" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("fake.png");
    expect(created).toEqual([]);
  });

  it("drops a read that resolves after unmount without leaking its object URL", async () => {
    let resolve!: (value: ArrayBuffer) => void;
    vi.spyOn(ipc, "readImageBytes").mockReturnValue(new Promise(r => { resolve = r; }));
    await render(<ChatImage src="/w/slow.png" />);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => resolve(bigPng.buffer));
    expect(created).toEqual(["blob:test/1"]);
    expect(revoked).toEqual(["blob:test/1"]);
  });
});

describe("chat image gallery", () => {
  it("collects attachments and prose Markdown images in order, skipping code and repeats", () => {
    expect(markdownImages("a ![x](<C:/a b.png> \"t\") `![no](n.png)` ![](d.png)\n~~~\n![no](m.png)")).toEqual([
      { src: "C:/a b.png", alt: "x" }, { src: "d.png" },
    ]);
    // An unclosed fence is still streaming code.
    expect(markdownImages("ok\n```\n![no](n.png)")).toEqual([]);
    const messages = [
      { seq: 1, role: "user", text: "![not rendered](u.png)", images: ["C:\\out\\a.png"], ts: null },
      { seq: 2, role: "tool", text: "", images: ["C:/out/t.png"], ts: null },
      { seq: 3, role: "assistant", text: "![A](c:/out/a.png) ![B](%E5%9B%BE.png) ![bad](https://x.test/a.png)", images: [png], ts: null },
    ] as Message[];
    expect(collectChatImages(messages, "/ws")).toEqual([
      { src: "C:\\out\\a.png" }, { src: png }, { src: "%E5%9B%BE.png", alt: "B" },
    ]);
    expect(chatImageKey("%E5%9B%BE.png", "/ws")).toBe(chatImageKey("图.png", "/ws"));
  });
});
