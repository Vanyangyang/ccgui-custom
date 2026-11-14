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

it.each(["idle", "awaiting_permission", "unknown", "future-activity", null])("does not show thinking when aggregate coordination is running but native status is %s", async nativeStatus => {
  await render(<ConversationSurface conversation={{ ...conversation, status: "running", nativeStatus }} />);
  expect(container.textContent).not.toContain("sidechat.thinkingLive");
  expect(container.querySelector('[role="log"]')?.getAttribute("aria-busy")).toBe("false");
});
it.each([{ nativeStatus: "busy" }, {}])("keeps native generation and legacy-host thinking visible: %j", async extra => {
  await render(<ConversationSurface conversation={{ ...conversation, status: "running", ...extra }} />);
  expect(container.textContent).toContain("sidechat.thinkingLive");
  expect(container.querySelector('[role="log"]')?.getAttribute("aria-busy")).toBe("true");
});

it.each(["idle", "unknown", "awaiting_permission"])("ignores busy history when the current queued coordinator is %s", async nativeStatus => {
  const action = vi.fn();
  await render(<ConversationSurface conversation={{ currentSourceId: "current", sources: [
    { id: "history", label: "History", conversation: { ...conversation, nativeStatus: "busy", readOnly: true } },
    { id: "current", label: "Current", conversation: { status: "starting", nativeStatus, sessionId: null, runId: null, children: [], messages: [{ seq: 1, role: "user", text: "queued input" }] } },
  ] }} onAction={action} />);
  expect(container.textContent).not.toContain("sidechat.thinkingLive");
  expect(container.querySelector('[role="log"]')?.getAttribute("aria-busy")).toBe("false");
  expect(container.textContent).toContain("queued input");
  expect(container.textContent).toContain("中文问题👩🏽‍💻");
  expect(action).not.toHaveBeenCalled();
});

it.each(["missing", ""])("does not fall back to history when explicit current source %j is absent", async currentSourceId => {
  await render(<ConversationSurface conversation={{ currentSourceId, sources: [
    { id: "history", conversation: { ...conversation, nativeStatus: "busy" } },
  ] }} />);
  expect(container.textContent).not.toContain("sidechat.thinkingLive");
  expect(container.querySelector('[role="log"]')?.getAttribute("aria-busy")).toBe("false");
});

it("does not turn a real unbound coordinator projection without nativeStatus into thinking", async () => {
  await render(<ConversationSurface conversation={{ currentSourceId: "current", sources: [
    { id: "history", conversation: { ...conversation, nativeStatus: "busy", readOnly: true } },
    { id: "current", conversation: { requestId: "queued-original", revision: 1, inputRevision: 0,
      sessionRef: null, status: "starting", messages: [], deliveries: [], children: [], canSend: false } },
  ] }} />);
  expect(container.textContent).not.toContain("sidechat.thinkingLive");
  expect(container.querySelector('[role="log"]')?.getAttribute("aria-busy")).toBe("false");
});

it("shows native busy for the exact current source even before the last source", async () => {
  await render(<ConversationSurface conversation={{ currentSourceId: "current", sources: [
    { id: "current", conversation: { status: "waiting", nativeStatus: "busy", messages: [] } },
    { id: "history", conversation: { ...conversation, nativeStatus: "idle" } },
  ] }} />);
  expect(container.textContent).toContain("sidechat.thinkingLive");
  expect(container.querySelector('[role="log"]')?.getAttribute("aria-busy")).toBe("true");
});

it("preserves any-source busy selection for legacy projections without currentSourceId", async () => {
  await render(<ConversationSurface conversation={{ sources: [
    { id: "first", conversation: { nativeStatus: "busy", messages: [] } },
    { id: "last", conversation: { nativeStatus: "idle", messages: [] } },
  ] }} />);
  expect(container.textContent).toContain("sidechat.thinkingLive");
  expect(container.querySelector('[role="log"]')?.getAttribute("aria-busy")).toBe("true");
});

it.each(["starting", "running", "queued"])("keeps legacy single-source status %s semantics without nativeStatus", async status => {
  await render(<ConversationSurface conversation={{ status, messages: [] }} />);
  expect(container.textContent?.includes("sidechat.thinkingLive")).toBe(status !== "queued");
  expect(container.querySelector('[role="log"]')?.getAttribute("aria-busy")).toBe(String(status !== "queued"));
});

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

it("keeps every source including an explicit earlier current source", async () => {
  const sources = Array.from({ length: 40 }, (_, i) => ({ id: `source-${i}`, label: `source-${i}`, conversation: { messages: [{ seq: 1, role: "user", text: `row-${i}`, ts: null }] } }));
  await render(<ConversationSurface conversation={{ sources, currentSourceId: "source-0" }} />);
  expect(container.querySelector('[data-conversation-source="source-0"]')).not.toBeNull();
  expect(container.querySelector('[data-conversation-source="source-39"]')).not.toBeNull();
  expect(container.querySelectorAll("[data-conversation-source]")).toHaveLength(40);
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

it("labels consecutive messages once and labels each source transition even when names match", async () => {
  const row = (seq: number, role: string, text: string, second: number) => ({ seq, role, text, ts: `2026-10-29T00:00:0${second}Z` });
  const a = { id: "coordinate-a", label: "协调执行", conversation: { requestId: "a", messages: [
    row(1, "user", "用户原文😀", 1), row(2, "assistant", "首次回复", 2),
    row(3, "assistant", "同一会话继续", 5), row(4, "assistant", "完成回复", 6),
  ] } };
  const b = { id: "coordinate-b", label: "协调执行", conversation: { requestId: "b", messages: [
    row(1, "assistant", "另一会话回复", 3), row(2, "assistant", "另一会话完成", 4),
  ] } };
  await render(<ConversationSurface conversation={{ sources: [a, b] }} />);
  const rows = [...container.querySelectorAll("[data-conversation-source]")];
  expect(rows.map(node => node.getAttribute("data-conversation-source"))).toEqual([
    "coordinate-a", "coordinate-a", "coordinate-b", "coordinate-b", "coordinate-a", "coordinate-a",
  ]);
  expect(rows.map(node => node.querySelector(":scope > span")?.textContent ?? null)).toEqual([
    "协调执行", null, "协调执行", null, "协调执行", null,
  ]);
  ["用户原文😀", "首次回复", "另一会话回复", "另一会话完成", "同一会话继续", "完成回复"].forEach((text, index) => {
    expect(rows[index].textContent).toContain(text);
  });
  await act(async () => { root!.render(<ConversationSurface conversation={{ sources: [a] }} />); });
  expect(container.querySelectorAll("[data-conversation-source] > span")).toHaveLength(1);
  expect(container.querySelectorAll("[data-conversation-source]")).toHaveLength(4);
});

const question = { workspacePath: "G:/project", requestId: "root", revision: 3, status: "waiting", messages: [{
  seq: 10, role: "question", text: "", ts: null, question: { status: "pending", runId: "native-run", requestId: "native-ask", questions: [
    { header: "Choice", question: "Which project?", options: [{ label: "Project A", description: "First" }, { label: "Project B", description: "Second" }], multiSelect: false },
  ] },
}] };

it.each(["thread", "session", "engine", "workspace"])("isolates standalone tool and pending form state by %s identity, preserving same-session updates", async identity => {
  const project = (next: boolean, revision = 3) => ({ ...question, revision,
    threadId: next && identity === "thread" ? "thread-b" : "thread-a",
    sessionRef: { engine: next && identity === "engine" ? "claude" : "codex",
      sessionId: next && identity === "session" ? "native-b" : "native-a",
      workspacePath: next && identity === "workspace" ? "G:/other" : "G:/project" },
    messages: [{ seq: 1, role: "tool", text: "Read", args: { query: "原文😀" }, result: `更新-${revision}` }, ...question.messages],
  });
  const action = vi.fn();
  await render(<ConversationSurface conversation={project(false)} onAction={action} />);
  const tool = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  const choice = container.querySelector<HTMLButtonElement>('button[role="radio"]')!;
  await act(async () => { tool.click(); choice.click(); });
  expect(choice.getAttribute("aria-checked")).toBe("true");
  await act(async () => { root!.render(<ConversationSurface conversation={project(false, 4)} onAction={action} />); });
  expect(container.querySelector('button[role="radio"]')).toBe(choice);
  expect(choice.getAttribute("aria-checked")).toBe("true");
  expect(tool.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("更新-4");
  await act(async () => { root!.render(<ConversationSurface conversation={project(true, 4)} onAction={action} />); });
  expect(container.querySelector('button[role="radio"]')).not.toBe(choice);
  expect(container.querySelector('button[role="radio"]')?.getAttribute("aria-checked")).toBe("false");
  expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("pre")).toBeNull();
  expect(action).not.toHaveBeenCalled();
});

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

it("preserves all message references and source order beyond the old history caps", () => {
  const source = (id: string) => ({ id, conversation: { messages: Array.from({ length: 1100 }, (_, i) => ({ seq: i, role: "assistant", text: `${id}-${i}`, ts: null })) } });
  const sources = Array.from({ length: 40 }, (_, index) => source(String(index)));
  const merged = mergeConversationSources(sources);
  expect(merged).toHaveLength(44000); expect(merged.every(row => row.message.ts === null)).toBe(true);
  for (const source of sources) {
    expect(merged.filter(row => row.source === source).map(row => row.message)).toEqual(source.conversation.messages);
  }
  expect(merged[0].message).toBe(sources[0].conversation.messages[0]);
  expect(merged.at(-1)?.message).toBe(sources.at(-1)?.conversation.messages.at(-1));
});

it("aligns the user bubble from a flex row with its own bubble hook instead of the shared tertiary token", async () => {
  await render(<ConversationSurface conversation={{ messages: [
    { seq: 1, role: "user", text: "短问题😀", ts: null },
    { seq: 2, role: "tool", text: "Read", live: false },
    { seq: 3, role: "assistant", text: "回答", live: false, ts: null },
  ] }} />);
  const [userRow, toolRow, replyRow] = [...container.querySelectorAll<HTMLElement>("[data-conversation-segment]")];
  // `self-end` only aligns inside a flex container: the row must be one.
  expect(userRow.classList).toContain("flex"); expect(userRow.classList).toContain("flex-col");
  const bubble = userRow.querySelector<HTMLElement>('[data-conversation-bubble="user"]')!;
  expect(bubble.textContent).toBe("短问题😀");
  expect(bubble.classList).toContain("self-end"); expect(bubble.classList).toContain("w-fit");
  expect(bubble.className).toContain("--conversation-user-bubble-bg");
  expect(bubble.classList).not.toContain("bg-background-tertiary-default");
  expect(toolRow.querySelector("[data-conversation-bubble]")).toBeNull();
  expect(replyRow.querySelector("[data-conversation-bubble]")).toBeNull();
});

it("marks source segment starts and continuations without relying on label text", async () => {
  const row = (seq: number, role: string, text: string, second: number) => ({ seq, role, text, ts: `2026-10-29T00:00:0${second}Z` });
  const a = { id: "a", label: "同名来源", conversation: { messages: [row(1, "user", "一", 1), row(2, "assistant", "二", 2), row(3, "assistant", "五", 5)] } };
  const b = { id: "b", label: "同名来源", conversation: { messages: [row(1, "assistant", "三", 3), row(2, "assistant", "四", 4)] } };
  const unlabeled = { id: "c", conversation: { messages: [row(1, "assistant", "六", 6)] } };
  await render(<ConversationSurface conversation={{ sources: [a, b, unlabeled] }} />);
  const rows = [...container.querySelectorAll("[data-conversation-source]")];
  expect(rows.map(node => node.getAttribute("data-conversation-segment"))).toEqual(["start", "continue", "start", "continue", "start", "start"]);
  expect(rows.map(node => node.querySelector(":scope > [data-conversation-source-label]")?.textContent ?? null)).toEqual(["同名来源", null, "同名来源", null, "同名来源", null]);
});

it("offers a compact accessible copy of the raw reply only after completion, with native time", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const raw = "**“原文”**与 `code`\n\n| a | b |\n| - | - |\n| 1 | 2 |";
  const live = { seq: 1, role: "assistant", text: raw.slice(0, 8), live: true, ts: "2026-10-29T08:05:00Z" };
  await render(<ConversationSurface conversation={{ requestId: "r", messages: [live] }} />);
  expect(container.querySelector('button[aria-label="sidechat.copyAnswer"]')).toBeNull();
  const prose = container.querySelector(".prose-chat");
  const meta = container.querySelector("[data-conversation-reply-meta]");
  expect(meta).not.toBeNull();
  await act(async () => { root!.render(<ConversationSurface conversation={{ requestId: "r", messages: [{ ...live, text: raw, live: false }] }} />); });
  // Completion keeps the same Markdown and metadata nodes (no remount jump).
  expect(container.querySelector(".prose-chat")).toBe(prose);
  expect(container.querySelector("[data-conversation-reply-meta]")).toBe(meta);
  expect(container.textContent).not.toContain("sidechat.copyAnswer");
  const copy = container.querySelector<HTMLButtonElement>('button[aria-label="sidechat.copyAnswer"]')!;
  expect(copy.type).toBe("button"); expect(copy.title).toBe("sidechat.copyAnswer");
  // Hidden until hover/focus on pointer devices, always visible on touch.
  expect(copy.className).toContain("focus-visible:opacity-100");
  expect(copy.className).toContain("[@media(hover:none)]:opacity-100");
  const time = container.querySelector("time")!;
  expect(time.dateTime).toBe("2026-10-29T08:05:00Z");
  expect(time.title).toBe(new Date("2026-10-29T08:05:00Z").toLocaleString());
  expect(time.textContent).not.toBe("");
  await act(async () => { copy.click(); });
  expect(writeText).toHaveBeenCalledExactlyOnceWith(raw);
  expect(copy.getAttribute("aria-label")).toBe("common.copied");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("common.copied");
});

it("never fabricates a reply time and updates the time when only ts changes", async () => {
  const message = { seq: 1, role: "assistant", text: "回答", live: false, ts: null as string | null };
  await render(<ConversationSurface conversation={{ messages: [message] }} />);
  expect(container.querySelector("time")).toBeNull();
  expect(container.querySelector('button[aria-label="sidechat.copyAnswer"]')).not.toBeNull();
  await act(async () => { root!.render(<ConversationSurface conversation={{ messages: [{ ...message, ts: "not a date" }] }} />); });
  expect(container.querySelector("time")).toBeNull();
  await act(async () => { root!.render(<ConversationSurface conversation={{ messages: [{ ...message, ts: "2026-10-29T01:02:03Z" }] }} />); });
  expect(container.querySelector("time")?.dateTime).toBe("2026-10-29T01:02:03Z");
});
