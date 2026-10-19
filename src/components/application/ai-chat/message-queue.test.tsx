import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { MessageQueue } from "./message-queue";

// React's act() environment flag — a well-known global the runtime can't
// validate, so a named cast with no narrowing is the right boundary.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const QUEUE = [
  { id: "q-1", text: "第一条", images: [], queuedAt: 0 },
  { id: "q-2", text: "第二条", images: [], queuedAt: 1 },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function render(props: Partial<Parameters<typeof MessageQueue>[0]> = {}) {
  return act(async () => {
    root.render(
      <MessageQueue queue={QUEUE} onRemove={() => {}} {...props} />,
    );
  });
}

describe("MessageQueue", () => {
  it("offers send-now per row and reports the row it belongs to", async () => {
    const onSendNow = vi.fn();
    await render({ onSendNow });

    const rows = [...container.querySelectorAll("button[aria-label='发送']")];
    expect(rows).toHaveLength(2);

    // Newest first: the top row is the second message.
    await act(async () => {
      rows[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSendNow).toHaveBeenCalledWith("q-2");
  });

  it("moves a row one step in the direction its arrow names", async () => {
    const onMove = vi.fn();
    await render({ onMove });

    const up = [...container.querySelectorAll<HTMLButtonElement>("button[aria-label='上移']")];
    const down = [...container.querySelectorAll<HTMLButtonElement>("button[aria-label='下移']")];
    expect(up).toHaveLength(2);
    expect(down).toHaveLength(2);

    // Newest first: the top row cannot go up, the bottom row cannot go down.
    expect(up[0].disabled).toBe(true);
    expect(down[0].disabled).toBe(false);
    expect(up[1].disabled).toBe(false);
    expect(down[1].disabled).toBe(true);

    await act(async () => {
      down[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onMove).toHaveBeenCalledWith("q-2", "down");

    await act(async () => {
      up[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onMove).toHaveBeenLastCalledWith("q-1", "up");
  });

  it("accepts live guidance labels and keeps the row identity", async () => {
    const onSendNow = vi.fn();
    await render({ onSendNow, sendNowLabel: "引导", sendNowTitle: "引导当前任务，不停止运行" });
    const actions = [...container.querySelectorAll<HTMLButtonElement>("button[aria-label='引导']")];
    expect(actions).toHaveLength(2);
    expect(actions[0].title).toContain("不停止");
    expect(container.querySelectorAll("button[aria-label='发送']")).toHaveLength(0);
    await act(async () => actions[0].click());
    expect(onSendNow).toHaveBeenCalledWith("q-2");
  });

  it("leaves the reorder arrows out when a single message is queued", async () => {
    await render({ onMove: () => {}, queue: [QUEUE[0]] });

    expect(container.querySelectorAll("button[aria-label='上移']")).toHaveLength(0);
    expect(container.querySelectorAll("button[aria-label='下移']")).toHaveLength(0);
  });

  it("leaves the row actions out when the caller cannot send now", async () => {
    await render();

    expect(container.querySelectorAll("button[aria-label='发送']")).toHaveLength(0);
    expect(container.querySelectorAll("button[aria-label='移出队列']")).toHaveLength(2);
  });
});
