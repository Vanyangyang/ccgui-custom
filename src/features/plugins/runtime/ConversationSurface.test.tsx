import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { ConversationSurface, mergeConversationSources } from "./ConversationSurface";

const native = vi.hoisted(() => ({ openFile: vi.fn(), resolve: vi.fn() }));
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(async () => { await Promise.all([
  import("@/features/chat/components/Markdown"), import("@/features/chat/components/QuestionCard"),
  import("@/features/chat/components/GrantCard"), import("@/features/chat/components/PlanReviewCard"),
]); }, 15000);
afterAll(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });
vi.mock("react-i18next", async original => ({ ...await original<object>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/platform", () => ({ openExternal: vi.fn() }));
vi.mock("@/features/files/store", () => ({ useFilesStore: Object.assign(vi.fn(), { getState: () => ({ openFile: native.openFile }) }) }));
vi.mock("@/features/chat/project-file-links", () => ({ resolveChatProjectFileLink: native.resolve }));
vi.mock("@/features/chat/components/FileLinkContextMenu", () => ({ FileLinkContextMenu: () => null }));
vi.mock("@/features/chat/components/ChatImage", () => ({ ChatImage: ({ src }: { src: string }) => <img data-testid="chat-image" alt={src} /> }));
let root: Root | undefined;
let container: HTMLDivElement;
async function render(content: ReactNode) {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(content); });
}
afterEach(async () => { await act(async () => { root?.unmount(); }); container?.remove(); root = undefined; vi.clearAllMocks(); });

const conversation = { workspacePath: "G:/project", status: "completed", messages: [
  { seq: 1, role: "user", text: "中文问题👩🏽‍💻", images: ["G:/pasted/img1.png"] },
  { seq: 2, role: "tool", text: "Read", path: "src/main.ts", live: false },
  { seq: 3, role: "assistant", text: "[源码](./src/main.ts)\n\n| 项目 | 内容 |\n| --- | --- |\n| 文字 | 中文😀 |\n\n```js\nconst value = '原文😀';\n```", live: false },
] };

it("mounts exact tool payload only while expanded and removes it on collapse", async () => {
  const args = { query: "中文参数👩🏽‍💻", lines: ["第一行", "第二行😀"] };
  const result = "执行结果✅\n完整中文👩🏽‍💻";
  await render(<ConversationSurface conversation={{ messages: [{ seq: 1, role: "tool", text: "Read", args, result }] }} />);
  const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  expect(toggle.type).toBe("button");
  expect(toggle.getAttribute("aria-label")).toBe("Read: crossSession.expandCard");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("pre")).toBeNull();
  expect(container.textContent).not.toContain("chat.toolCallArgs");
  expect(container.textContent).not.toContain(result);
  toggle.focus(); expect(document.activeElement).toBe(toggle);
  await act(async () => { toggle.click(); });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const payload = [...container.querySelectorAll("pre")];
  expect(payload.map(node => node.textContent)).toEqual([JSON.stringify(args, null, 2), result]);
  await act(async () => { toggle.click(); });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("pre")).toBeNull();
  expect(payload.every(node => !node.isConnected)).toBe(true);
  await act(async () => { toggle.click(); });
  expect([...container.querySelectorAll("pre")].map(node => node.textContent)).toEqual([JSON.stringify(args, null, 2), result]);
});

it("keeps an expanded tool open as running payload becomes a completed result", async () => {
  const message = { seq: 1, role: "tool", text: "Read", live: true, args: { query: "开始😀" }, result: "部分" };
  await render(<ConversationSurface conversation={{ requestId: "run-1", messages: [message] }} />);
  const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  expect(container.querySelector("svg.animate-spin")).not.toBeNull();
  await act(async () => { toggle.click(); });
  const args = { query: "更新👩🏽‍💻" }, result = "完整结果✅\n第二行";
  await act(async () => { root!.render(<ConversationSurface conversation={{ requestId: "run-1", messages: [{ ...message, live: false, args, result }] }} />); });
  expect(container.querySelector("button[aria-expanded]")).toBe(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("svg.animate-spin")).toBeNull();
  expect(container.querySelector("svg.lucide-check")).not.toBeNull();
  expect([...container.querySelectorAll("pre")].map(node => node.textContent)).toEqual([JSON.stringify(args, null, 2), result]);
});

it.each(["source", "session"])("resets tool disclosure when the %s identity changes", async identity => {
  const message = { seq: 1, role: "tool", text: "Read", args: { query: "中文😀" } };
  const project = (id: string, requestId: string) => ({ sources: [{ id, conversation: { requestId, messages: [message] } }] });
  await render(<ConversationSurface conversation={project("source-1", "run-1")} />);
  await act(async () => { container.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click(); });
  expect(container.querySelector("pre")).not.toBeNull();
  await act(async () => { root!.render(<ConversationSurface conversation={project(identity === "source" ? "source-2" : "source-1", identity === "session" ? "run-2" : "run-1")} />); });
  expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("pre")).toBeNull();
});

it("keeps a tool without payload as a plain pill", async () => {
  await render(<ConversationSurface conversation={{ messages: [{ seq: 1, role: "tool", text: "Read", live: false }] }} />);
  expect(container.textContent).toBe("Read");
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector("svg.lucide-check")).not.toBeNull();
});

it("displays host displayText and keeps the untouched injected context in a closed disclosure", async () => {
  await render(<ConversationSurface conversation={{ messages: [{ seq: 1, role: "user", text: "INJECTED COORDINATOR JSON", displayText: "真正的问题😀", ts: null }] }} />);
  const details = container.querySelector("details")!;
  expect(details).not.toBeNull(); expect(details.open).toBe(false);
  expect(details.textContent).toContain("INJECTED COORDINATOR JSON");
  details.remove(); expect(container.textContent).toContain("真正的问题😀"); expect(container.textContent).not.toContain("INJECTED COORDINATOR JSON");
});

it("keeps the current source beyond the 32-source cap and supports an explicit earlier current source", async () => {
  const sources = Array.from({ length: 40 }, (_, i) => ({ id: `source-${i}`, label: `source-${i}`, conversation: { messages: [{ seq: 1, role: "user", text: `row-${i}`, ts: null }] } }));
  await render(<ConversationSurface conversation={{ sources, currentSourceId: "source-0" }} />);
  expect(container.querySelector('[data-conversation-source="source-0"]')).not.toBeNull();
  expect(container.querySelector('[data-conversation-source="source-39"]')).not.toBeNull();
  expect(container.querySelectorAll("[data-conversation-source]")).toHaveLength(32);
});

it("renders native markdown/tools and dispatches a file link to the owner without local file actions", async () => {
  const action = vi.fn();
  await render(<ConversationSurface conversation={conversation} onAction={action} />);
  expect(container.querySelector("table")).not.toBeNull();
  expect(container.querySelector('[data-testid="chat-image"]')?.getAttribute("alt")).toBe("G:/pasted/img1.png");
  expect(container.textContent).toContain("中文问题👩🏽‍💻");
  expect(container.textContent).toContain("Read");
  expect(document.querySelector("pre code")?.textContent).toContain("const value = '原文😀';");
  await act(async () => { container.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  expect(action).toHaveBeenCalledWith({ type: "openFile", path: "./src/main.ts" });
  expect(native.openFile).not.toHaveBeenCalled(); expect(native.resolve).not.toHaveBeenCalled();
});

it("a renderer without an owner callback never opens a file in the detached document", async () => {
  await render(<ConversationSurface conversation={conversation} />);
  await act(async () => { container.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  expect(native.openFile).not.toHaveBeenCalled(); expect(native.resolve).not.toHaveBeenCalled();
});

it("merges native timestamps while preserving source order and labels", async () => {
  const a = { id: "chat", label: "Discussion", conversation: { workspacePath: "G:/project", messages: [
    { seq: 1, role: "user", text: "first", ts: "2026-10-24T00:00:02Z" },
    { seq: 2, role: "assistant", text: "second", ts: "2026-10-24T00:00:01Z" },
  ] } };
  const b = { id: "coordinate", label: "Coordinator", conversation: { workspacePath: "G:/project", requestId: "root", revision: 5, messages: [
    { seq: 1, role: "assistant", text: "[source](./src/main.ts)", ts: "2026-10-24T00:00:00Z" },
  ] } };
  expect(mergeConversationSources([a, b]).map(r => r.message.text)).toEqual(["[source](./src/main.ts)", "first", "second"]);
  const action = vi.fn(); await render(<ConversationSurface conversation={{ sources: [a, b] }} onAction={action} />);
  expect(container.textContent).toContain("Coordinator"); expect(container.textContent).toContain("Discussion");
  await act(async () => { container.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  expect(action).toHaveBeenCalledWith({ type: "openFile", path: "./src/main.ts", sourceId: "coordinate", conversationRequestId: "root", expectedRevision: 5 });
});

const question = { workspacePath: "G:/project", requestId: "root", revision: 3, status: "waiting", messages: [{
  seq: 10, role: "question", text: "", ts: null, question: { status: "pending", runId: "native-run", requestId: "native-ask", questions: [
    { header: "Choice", question: "Which project?", options: [{ label: "Project A", description: "First" }, { label: "Project B", description: "Second" }], multiSelect: false },
  ] },
}] };

it("routes in-place clarification through the owner with exact pending native identity", async () => {
  const action = vi.fn(); await render(<ConversationSurface conversation={{ sources: [{ id: "coord", label: "Coordinator", conversation: question }] }} onAction={action} />);
  const option = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Project A"))!;
  await act(async () => { option.click(); });
  const submit = [...container.querySelectorAll("button")].find(b => b.textContent === "chat.questionSubmit")!;
  await act(async () => { submit.click(); });
  expect(action).toHaveBeenCalledExactlyOnceWith({ type: "answerQuestion", sourceId: "coord", conversationRequestId: "root", expectedRevision: 3,
    seq: 10, runId: "native-run", requestId: "native-ask", answers: { "Which project?": "Project A" } });
});

it("plain mode retains native pending history without active write controls", async () => {
  const action = vi.fn(); await render(<ConversationSurface conversation={{ readOnly: true, sources: [{ id: "coord", label: "Coordinator", conversation: question }] }} onAction={action} />);
  expect(container.textContent).toContain("Which project?");
  expect(container.querySelector("button")).toBeNull(); expect(action).not.toHaveBeenCalled();
});

it("shows native approval waiting and opens its real host UI without approving it", async () => {
  const action = vi.fn();
  const approval = { ...question, messages: [{ ...question.messages[0], question: { ...question.messages[0].question, codexApproval: { kind: "command" } } }] };
  await render(<ConversationSurface conversation={approval} onAction={action} />);
  expect(container.textContent).toContain("chat.questionWaiting");
  await act(async () => { container.querySelector("button")!.click(); });
  expect(action).toHaveBeenCalledExactlyOnceWith({ type: "openNative", conversationRequestId: "root", expectedRevision: 3 });
});

it("does not fabricate timestamps and bounds merged rendering", () => {
  const source = (id: string) => ({ id, conversation: { messages: Array.from({ length: 1100 }, (_, i) => ({ seq: i, role: "assistant", text: `${id}-${i}`, ts: null })) } });
  const merged = mergeConversationSources([source("a"), source("b")]);
  expect(merged).toHaveLength(1000); expect(merged.every(row => row.message.ts === null)).toBe(true);
  expect(merged.map(row => row.message.seq)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 100));
});
