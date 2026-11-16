import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Markdown from "./Markdown";
import { resolveFilePath, toFileLink } from "@/lib/fileLinks";
import i18n from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { markdownRegistry } from "@ccgui/plugin-sdk";

const native = vi.hoisted(() => ({ openFile: vi.fn(), resolve: vi.fn(), openExternal: vi.fn() }));
vi.mock("@/features/files/store", () => ({ useFilesStore: { getState: () => ({ openFile: native.openFile }) } }));
vi.mock("@/features/chat/project-file-links", () => ({ resolveChatProjectFileLink: native.resolve }));
vi.mock("@/lib/platform", () => ({ openExternal: native.openExternal }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  native.resolve.mockImplementation(async (path: string, workspace: string) => resolveFilePath(path, workspace));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe("Markdown local file URL links", () => {
  it.each([
    ["file:///C:/music/index.html", "C:/music/index.html"],
    ["file:///tmp/%E8%AF%95%E5%90%AC%20a.wav", "/tmp/试听 a.wav"],
    ["file://localhost/tmp/a.ogg", "/tmp/a.ogg"],
    ["FILE:///D:/music/demo.wav", "D:/music/demo.wav"],
    ["file:///tmp/a%2520b%23L53", "/tmp/a%20b#L53"],
  ])("opens %s through the file store only after a click", async (url, path) => {
    await act(async () => root.render(<Markdown text={`[试听](${url})`} workspacePath="G:/workspace" />));
    const link = container.querySelector<HTMLAnchorElement>("a.md-file-link");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe(toFileLink(url));
    expect(link!.title).toBe(path);
    expect(native.resolve).not.toHaveBeenCalled();
    expect(native.openFile).not.toHaveBeenCalled();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => { link!.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    expect(native.openFile).toHaveBeenCalledWith(path);
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it("supports explicit autolinks and inline code without altering fenced code or bare filenames", async () => {
    const url = "file:///C:/music/demo.wav";
    await act(async () => root.render(<Markdown text={`<${url}>\n\n\`${url}\`\n\n\`\`\`text\n${url}\n\`\`\`\n\nindex.html`} workspacePath="G:/workspace" />));
    expect(container.querySelectorAll("a.md-file-link")).toHaveLength(2);
    expect(container.querySelector("pre a")).toBeNull();
    expect(container.textContent).toContain("index.html");
  });

  it("accepts a Markdown destination with literal Chinese and spaces", async () => {
    await act(async () => root.render(<Markdown text="[试听](<file:///C:/试听/方案 A.wav>)" workspacePath="G:/workspace" />));
    const link = container.querySelector<HTMLAnchorElement>("a.md-file-link")!;
    expect(link.title).toBe("C:/试听/方案 A.wav");
    await act(async () => { link.click(); });
    expect(native.openFile).toHaveBeenCalledWith("C:/试听/方案 A.wav");
  });

  it("uses the same URL resolution for the right-click open action", async () => {
    const url = "file:///tmp/a%2520b%23L53";
    await act(async () => root.render(<Markdown text={`[文件](${url})`} workspacePath="G:/workspace" />));
    await act(async () => {
      container.querySelector("a")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(native.resolve).not.toHaveBeenCalled();
    const open = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === i18n.t("files.openFile"));
    expect(open).toBeDefined();
    await act(async () => { open!.click(); });
    expect(native.resolve).toHaveBeenCalledWith(url, "G:/workspace");
    expect(native.openFile).toHaveBeenCalledWith("/tmp/a%20b#L53");
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it("reveals the decoded file through the existing right-click action", async () => {
    const reveal = vi.spyOn(ipc, "revealInFileManager").mockResolvedValue(undefined);
    await act(async () => root.render(<Markdown text="[文件](file:///C:/a%2520b%23L53)" workspacePath="G:/workspace" />));
    await act(async () => {
      container.querySelector("a")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const labels = ["files.revealInFinder", "files.revealInExplorer", "files.revealInFileManager"].map(key => i18n.t(key));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => labels.includes(item.textContent ?? ""));
    await act(async () => { item!.click(); });
    expect(reveal).toHaveBeenCalledWith("C:/a%20b#L53");
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it.each(["file:///C:/a%2520b%23L53", "file:///tmp/a%2520b%23L53"]) (
    "copies %s as a file URL that reopens the exact filename", async (url) => {
      const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      try {
        await act(async () => root.render(<Markdown text={`[文件](${url})`} workspacePath="G:/workspace" />));
        await act(async () => {
          container.querySelector("a")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        });
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === i18n.t("files.copyLink"));
        await act(async () => { item!.click(); });
        expect(writeText).toHaveBeenCalledWith(url);
        await act(async () => root.render(<Markdown text={`[复制的链接](${writeText.mock.calls[0][0]})`} workspacePath="G:/workspace" />));
        await act(async () => { container.querySelector<HTMLAnchorElement>("a")!.click(); });
        expect(native.openFile).toHaveBeenCalledWith(resolveFilePath(url, "G:/workspace"));
      } finally {
        if (previous) Object.defineProperty(navigator, "clipboard", previous);
        else Reflect.deleteProperty(navigator, "clipboard");
      }
    },
  );

  it("passes only the internal scheme to a plugin link renderer", async () => {
    const url = "file:///C:/music/demo.wav";
    const dispose = markdownRegistry.register({ id: "test:file-url-override", components: {
      a: ({ href, children }) => <a data-plugin-link="" href={href}>{children}</a>,
    } });
    try {
      await act(async () => root.render(<Markdown text={`[文件](${url})`} workspacePath="G:/workspace" />));
      expect(container.querySelector("[data-plugin-link]")?.getAttribute("href")).toBe(toFileLink(url));
    } finally { await act(async () => dispose()); }
  });

  it.each([
    ["file:///C:/%E8%AF%95%E5%90%AC/a%20b%2520%23demo.html", "file:///C:/%E8%AF%95%E5%90%AC/a%20b%2520%23demo.html"],
    ["./dist/index.html", "file:///G:/workspace/dist/index.html"],
    ["C:/out/INDEX.HTM", "file:///C:/out/INDEX.HTM"],
  ])("opens HTML link %s in Chrome with an encoded local URL", async (url, expected) => {
    const open = vi.spyOn(ipc, "openWorkspaceIn").mockResolvedValue(undefined);
    await act(async () => root.render(<Markdown text={`[网页](${url})`} workspacePath="G:/workspace" />));
    await act(async () => {
      container.querySelector("a")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === i18n.t("files.openInApp", { app: "Chrome" }));
    expect(item).toBeDefined();
    expect(open).not.toHaveBeenCalled();
    await act(async () => { item!.click(); });
    expect(open).toHaveBeenCalledWith(expected, { appName: "Google Chrome" });
    expect(native.openFile).not.toHaveBeenCalled();
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it.each(["./demo.wav", "./index.html.txt", "./index.html/assets"]) (
    "omits the Chrome action for non-HTML link %s", async (url) => {
      await act(async () => root.render(<Markdown text={`[文件](${url})`} workspacePath="G:/workspace" />));
      await act(async () => {
        container.querySelector("a")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      });
      expect([...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent === i18n.t("files.openInApp", { app: "Chrome" }))).toBe(false);
    },
  );

  it("shows Chrome launch failures after the menu closes", async () => {
    vi.spyOn(ipc, "openWorkspaceIn").mockRejectedValue(new Error("Chrome executable not found"));
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    await act(async () => root.render(<Markdown text="[网页](./index.html)" workspacePath="G:/workspace" />));
    await act(async () => {
      container.querySelector("a")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === i18n.t("files.openInApp", { app: "Chrome" }));
    expect(item).toBeDefined();
    await act(async () => { item!.click(); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("Chrome executable not found"));
  });

  it.each(["file://server/share/a.wav", "file:relative.wav", "file:////server/share/a.wav", "file:///tmp/a%00.wav", "file:///tmp/bad%ZZ.wav", "javascript:alert(1)", "data:text/html,test"]) (
    "keeps unsupported %s inert", async (url) => {
      await act(async () => root.render(<Markdown text={`[文件](<${url}>)`} workspacePath="G:/workspace" />));
      expect(container.textContent).toBe("文件");
      expect(container.querySelector("a")).toBeNull();
      expect(native.resolve).not.toHaveBeenCalled();
      expect(native.openExternal).not.toHaveBeenCalled();
    },
  );

  it("forwards the intact file URL to the owning conversation without local actions", async () => {
    const url = "file:///tmp/a%2520b%23L53";
    const onOpenFile = vi.fn();
    await act(async () => root.render(<Markdown text={`[文件](${url})`} workspacePath="G:/workspace" onOpenFile={onOpenFile} />));
    await act(async () => { container.querySelector<HTMLAnchorElement>("a")!.click(); });
    expect(onOpenFile).toHaveBeenCalledWith(url);
    expect(native.resolve).not.toHaveBeenCalled();
    expect(native.openFile).not.toHaveBeenCalled();
  });
});
