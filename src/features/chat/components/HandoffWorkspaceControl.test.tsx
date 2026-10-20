import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { useChatStore, sessionKey } from "../store";
import { useHandoffStore } from "../session-cleanup";
import { EMPTY_SESSION } from "../store/stream";
import { HandoffWorkspaceControl } from "./HandoffWorkspaceControl";
import { useComposerImages } from "./use-composer-images";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const original = useChatStore.getState();
const source = "C:/source/project";
const target = "D:/target/project";
const archived = "D:/archived/project";
let container: HTMLDivElement;
let root: Root;
const originalLanguage = i18n.language;

function Harness() {
  const active = useChatStore((s) => s.active);
  const entry = useHandoffStore((s) => s.byWorkspace[active?.workspacePath ?? ""]);
  return active && entry ? <HandoffWorkspaceControl workspacePath={active.workspacePath} entry={entry} /> : null;
}

beforeEach(async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }));
  await i18n.changeLanguage("en");
  useHandoffStore.setState({ byWorkspace: {} });
  useChatStore.setState({
    ...original, active: null, activeEngine: "codex", openTabs: [], drafts: {}, bySession: {},
    workspaces: [source, target, archived].map((path, i) => ({ id: String(i), path, name: "project", sortOrder: i, lastOpenedAt: 1, groupId: null })),
    archivedWorkspaces: ["2"],
  });
  useHandoffStore.getState().startHandoff({
    workspacePath: source, sourceEngine: "codex", sourceSessionId: "source-session", sourceTitle: "Source",
    sourceState: { ...EMPTY_SESSION, messages: [{ seq: 1, ts: "1", role: "assistant", text: "Inspect src/main.ts" }] },
    initialMode: "local",
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useHandoffStore.setState({ byWorkspace: {} });
  useChatStore.setState(original);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await i18n.changeLanguage(originalLanguage);
});

async function select(path: string) {
  const control = container.querySelector("select")!;
  expect(control).not.toBeNull();
  await act(async () => {
    control.value = path;
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("shows distinct full paths, switches the real draft and explains source-relative paths", async () => {
  const options = Array.from(container.querySelectorAll("option")).map(o => o.value);
  expect(options).toContain(source);
  expect(options).toContain(target);
  expect(options).not.toContain(archived);
  await select(target);
  expect(useChatStore.getState().active?.workspacePath).toBe(target);
  expect(container.textContent).toContain("Source: C:/source/project");
  expect(container.textContent).toContain("historical relative paths refer to the source");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await select(source);
  expect(useChatStore.getState().active?.workspacePath).toBe(source);
  expect(container.textContent).not.toContain("historical relative paths");
});

it("reports conflicts inline without replacing either draft", async () => {
  const sourceDraft = useChatStore.getState().drafts[sessionKey("codex", null, source)];
  useChatStore.getState().setDraft(sessionKey("codex", null, target), "Keep my target draft");
  await select(target);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your current draft is preserved");
  expect(useChatStore.getState().active?.workspacePath).toBe(source);
  expect(useChatStore.getState().drafts[sessionKey("codex", null, source)]).toBe(sourceDraft);
  expect(useChatStore.getState().drafts[sessionKey("codex", null, target)]).toBe("Keep my target draft");
});

it("disables the selector during submission", async () => {
  const entry = useHandoffStore.getState().byWorkspace[source];
  await act(async () => useHandoffStore.getState().setSending(source, entry.id, true));
  expect(container.querySelector("button")?.disabled).toBe(true);
  expect(container.textContent).toContain(source);
});

it.each([
  { path: source, image: "/attachments/keep.png" }, { path: target, image: "/attachments/keep.png" },
  { path: source, image: "images/keep.png" }, { path: target, image: "images/keep.png" },
])("protects component-owned $image attachments in $path", async ({ path, image }) => {
  const attachmentDraft = { paths: [image], getPaths: () => [image], update: vi.fn() };
  function AttachmentOwner() {
    useComposerImages(sessionKey("codex", null, path), attachmentDraft);
    return null;
  }
  await act(async () => root.render(<><Harness /><AttachmentOwner /></>));
  await select(target);
  expect(useChatStore.getState().active?.workspacePath).toBe(source);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("attachments");
  expect(attachmentDraft.update).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness />));
  await select(target);
  expect(useChatStore.getState().active?.workspacePath).toBe(target);
});

it("keeps the source workspace while an attachment import is pending", async () => {
  let complete!: (paths: string[]) => void;
  const imported = new Promise<string[]>((resolve) => { complete = resolve; });
  vi.spyOn(ipc, "importAttachments").mockReturnValue(imported);
  let owner!: ReturnType<typeof useComposerImages>;
  function AttachmentOwner() {
    owner = useComposerImages(sessionKey("codex", null, source));
    return null;
  }
  await act(async () => root.render(<><Harness /><AttachmentOwner /></>));
  await act(async () => owner.importImageFiles(["images/keep.png"], true));
  await select(target);
  expect(useChatStore.getState().active?.workspacePath).toBe(source);
  await act(async () => { complete(["/app/pasted-images/copied.png"]); await imported; });
  expect(owner.images).toEqual(["/app/pasted-images/copied.png"]);
  await act(async () => owner.removeImage("/app/pasted-images/copied.png"));
  await select(target);
  expect(useChatStore.getState().active?.workspacePath).toBe(target);
});
