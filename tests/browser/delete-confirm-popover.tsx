// Open /tests/browser/delete-confirm-popover.html with the Vite dev server
// running. Verifies the session-delete confirmation is a pointer-anchored
// popover instead of the centered modal: right-click the thread row, pick
// 删除 in the real context menu, and the [role="alertdialog"] panel must
// open next to the click point (not screen center) with 确认 focused;
// Escape and outside press cancel without deleting, 确认 calls the store's
// deleteSession. Uses the real AiChatSidebar, ThreadContextMenu,
// ChatPageDialogs and pointer-anchor; only the store's deleteSession is
// stubbed (it would invoke Tauri IPC). No app, no backend.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import type { ChatPageDialog } from "../../src/features/chat/ChatPageDialogs";

localStorage.setItem("ccgui-next.language", "zh");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(reason: string): never {
  throw new Error(reason);
}

const session = {
  engine: "claude",
  sessionId: "abc-123",
  workspacePath: "/ws/a",
  filePath: "/ws/a/abc-123.jsonl",
  fileSize: 1,
  fileMtimeMs: 1,
  title: "整理发布脚本",
  preview: "",
  createdAt: null,
  updatedAt: Date.now(),
  messageCount: 1,
  pinned: false,
  customTitle: null,
};

const deleted: string[] = [];

/** Realistic press: pointerdown (records the anchor) then click. */
function press(el: Element, x?: number, y?: number) {
  const rect = el.getBoundingClientRect();
  const cx = x ?? rect.left + rect.width / 2;
  const cy = y ?? rect.top + rect.height / 2;
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: cx, clientY: cy }));
  el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: cx, clientY: cy }));
  (el as HTMLElement).click();
}

async function main() {
  const { default: i18n } = await import("../../src/lib/i18n");
  const { AiChatSidebar } = await import(
    "../../src/components/application/ai-chat/ai-chat-sidebar"
  );
  const { ChatPageDialogs } = await import(
    "../../src/features/chat/ChatPageDialogs"
  );
  const { recentPointerAnchor } = await import("../../src/lib/pointer-anchor");
  const { useChatStore } = await import("../../src/features/chat/store");

  // Stub the destructive store action; every other store field stays default.
  useChatStore.setState({
    deleteSession: async (engine: string, sessionId: string) => {
      deleted.push(`${engine}/${sessionId}`);
    },
  });

  const t = (key: string) => i18n.t(key) as string;

  function Fixture() {
    const [dialog, setDialog] = useState<ChatPageDialog | null>(null);
    return (
      <>
        <AiChatSidebar
          repos={[
            {
              id: "a",
              label: "a",
              defaultOpen: true,
              threads: [
                {
                  id: "claude/abc-123",
                  label: "整理发布脚本",
                  engine: "claude",
                  time: "1分钟",
                },
              ],
            },
          ]}
          onThreadAction={(id, action) => {
            // Same wiring as use-chat-sidebar.handleThreadAction.
            if (id === "claude/abc-123" && action === "delete") {
              setDialog({ kind: "delete", session, anchor: recentPointerAnchor() ?? undefined });
            }
          }}
        />
        <ChatPageDialogs dialog={dialog} onClose={() => setDialog(null)} />
      </>
    );
  }

  createRoot(document.getElementById("fixture")!).render(<Fixture />);
  await sleep(300);

  const threadRow = [...document.querySelectorAll<HTMLElement>("button")]
    .find((el) => el.textContent?.includes("整理发布脚本")) ?? fail("thread row missing");
  const rowRect = threadRow.getBoundingClientRect();

  // Right-click the row → the real thread context menu opens at the pointer.
  const menuX = rowRect.left + 60;
  const menuY = rowRect.top + rowRect.height / 2;
  threadRow.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, clientX: menuX, clientY: menuY }),
  );
  threadRow.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: menuX, clientY: menuY }),
  );
  await sleep(100);

  const menu = document.querySelector('[role="menu"]') ?? fail("context menu missing");
  const deleteItem = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
    el.textContent?.includes(t("chat.deleteSession")),
  ) ?? fail("delete menu item missing");
  // Captured before the press: clicking unmounts the menu, which zeroes the
  // item's rect.
  const itemRect = deleteItem.getBoundingClientRect();
  press(deleteItem);
  await sleep(100);

  // The popover (not the modal) must surface near the delete click.
  const popover = document.querySelector('[role="alertdialog"]') ?? fail("confirm popover missing");
  if (document.querySelector('[role="dialog"]')) fail("centered modal rendered instead of popover");
  const popRect = popover.getBoundingClientRect();
  if (Math.abs(popRect.left - itemRect.left) > 160 || Math.abs(popRect.top - itemRect.top) > 160)
    fail(
      `popover not anchored to click: popover=(${popRect.left},${popRect.top}) click=(${itemRect.left},${itemRect.top})`,
    );
  const centerDx = Math.abs(popRect.left + popRect.width / 2 - window.innerWidth / 2);
  const centerDy = Math.abs(popRect.top + popRect.height / 2 - window.innerHeight / 2);
  if (centerDx < 60 && centerDy < 60) fail("popover sits at screen center — modal placement");
  if (!popover.textContent?.includes(t("chat.confirmDeleteSession"))) fail("message missing");

  const confirm = [...popover.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(t("common.confirm")),
  ) ?? fail("confirm button missing");
  if (document.activeElement !== confirm) fail("confirm button not focused");

  // Escape cancels without deleting.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(100);
  if (document.querySelector('[role="alertdialog"]')) fail("Escape did not close the popover");
  if (deleted.length !== 0) fail("Escape cancelled yet deleteSession fired");

  // Re-open, then an outside press cancels.
  threadRow.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, clientX: menuX, clientY: menuY }),
  );
  threadRow.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: menuX, clientY: menuY }),
  );
  await sleep(100);
  const deleteItem2 = [...(document.querySelector('[role="menu"]')?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    .find((el) => el.textContent?.includes(t("chat.deleteSession"))) ?? fail("delete item missing (2nd)");
  press(deleteItem2);
  await sleep(100);
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));
  await sleep(100);
  if (document.querySelector('[role="alertdialog"]')) fail("outside press did not close the popover");
  if (deleted.length !== 0) fail("outside press cancelled yet deleteSession fired");

  // Re-open and confirm: the store action fires with the session id.
  threadRow.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, clientX: menuX, clientY: menuY }),
  );
  threadRow.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: menuX, clientY: menuY }),
  );
  await sleep(100);
  const deleteItem3 = [...(document.querySelector('[role="menu"]')?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    .find((el) => el.textContent?.includes(t("chat.deleteSession"))) ?? fail("delete item missing (3rd)");
  press(deleteItem3);
  await sleep(100);
  const confirm3 = document.querySelector('[role="alertdialog"]')
    ? [...document.querySelectorAll('[role="alertdialog"] button')].find((b) =>
        b.textContent?.includes(t("common.confirm")),
      )
    : null;
  if (!confirm3) fail("confirm button missing (3rd open)");
  press(confirm3);
  await sleep(100);
  if (deleted.join() !== "claude/abc-123") fail(`deleteSession calls: ${deleted.join()}`);
  if (document.querySelector('[role="alertdialog"]')) fail("popover stayed open after confirm");

  document.getElementById("result")!.textContent = JSON.stringify({
    status: "PASS",
    anchor: { popover: [popRect.left, popRect.top], click: [itemRect.left, itemRect.top] },
    deleted,
  });
}

main().catch((error) => {
  document.getElementById("result")!.textContent = JSON.stringify({
    status: "FAIL",
    error: String(error),
  });
});
