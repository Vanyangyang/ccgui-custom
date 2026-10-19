import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import type { SessionMeta, SuggestedSessionTitle } from "@/lib/ipc";
import { PromptDialog } from "@/components/dialogs";

const suggestSessionTitleMock = vi.fn<(engine: string, sessionId: string) => Promise<SuggestedSessionTitle>>();
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    suggestSessionTitle: (engine: string, sessionId: string) =>
      suggestSessionTitleMock(engine, sessionId),
  },
}));

import { RenameSessionDialog, renameIntent, suggestTitleErrorCode } from "./RenameSessionDialog";
import { ChatPageDialogs } from "./ChatPageDialogs";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    engine: "claude",
    sessionId: "s-1",
    workspacePath: "/repo",
    filePath: "/repo/s-1.jsonl",
    fileSize: 1,
    fileMtimeMs: 1,
    title: "🧩 邮箱验证码｜过期修复",
    preview: "",
    createdAt: null,
    updatedAt: null,
    messageCount: 4,
    pinned: false,
    customTitle: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let onRename: ReturnType<typeof vi.fn<(title: string) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

function render(meta: SessionMeta = session()) {
  act(() => {
    root.render(<RenameSessionDialog session={meta} onRename={onRename} onClose={onClose} />);
  });
}

// ModalShell portals into document.body.
function input(): HTMLInputElement {
  const el = document.body.querySelector<HTMLInputElement>("input");
  if (!el) throw new Error("no rename field");
  return el;
}

function button(text: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );
  if (!el) throw new Error(`no button ${text}`);
  return el;
}

function typeInto(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function confirm() {
  act(() => button(i18n.t("common.confirm")).click());
}

function generateButton(): HTMLButtonElement {
  return button(i18n.t("chat.generateTitle"));
}

async function clickGenerate() {
  await act(async () => generateButton().click());
}

function statusText(): string {
  return document.body.querySelector('[role="status"]')?.textContent ?? "";
}

function alertText(): string | null {
  return document.body.querySelector('[role="alert"]')?.textContent ?? null;
}

function pendingSuggestion() {
  let resolve!: (value: SuggestedSessionTitle) => void;
  let reject!: (err: unknown) => void;
  suggestSessionTitleMock.mockReturnValue(new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  }));
  return { resolve, reject };
}

describe("renameIntent", () => {
  it("treats the prefilled title as no change", () => {
    expect(renameIntent(session(), "🧩 邮箱验证码｜过期修复")).toBeNull();
    expect(renameIntent(session(), "  🧩 邮箱验证码｜过期修复  ")).toBeNull();
    expect(renameIntent(session({ customTitle: "Mine" }), "Mine")).toBeNull();
  });

  it("clears the manual title on empty input only when one exists", () => {
    expect(renameIntent(session({ customTitle: "Mine" }), "   ")).toBe("");
    expect(renameIntent(session(), "")).toBeNull();
  });

  it("saves a trimmed new title", () => {
    expect(renameIntent(session(), "  New name ")).toBe("New name");
    // Typing the auto title over a manual one is a real change.
    expect(renameIntent(session({ customTitle: "Mine" }), "🧩 邮箱验证码｜过期修复")).toBe(
      "🧩 邮箱验证码｜过期修复",
    );
  });
});

describe("suggestTitleErrorCode", () => {
  it("maps host error strings and degrades unknown ones to failed", () => {
    expect(suggestTitleErrorCode("timeout")).toBe("timeout");
    expect(suggestTitleErrorCode(new Error("no_content"))).toBe("no_content");
    expect(suggestTitleErrorCode("engine_disabled")).toBe("engine_disabled");
    expect(suggestTitleErrorCode("something exploded")).toBe("failed");
    expect(suggestTitleErrorCode({ code: 1 })).toBe("failed");
  });
});

describe("RenameSessionDialog", () => {
  beforeEach(() => {
    suggestSessionTitleMock.mockReset();
    onRename = vi.fn<(title: string) => void>();
    onClose = vi.fn<() => void>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("prefills the manual title, else the displayed title", () => {
    render(session({ customTitle: "Mine" }));
    expect(input().value).toBe("Mine");
    act(() => root.unmount());
    root = createRoot(container);
    render();
    expect(input().value).toBe("🧩 邮箱验证码｜过期修复");
  });

  it("focuses the field with the title selected", () => {
    render();
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(input().value.length);
  });

  it("keeps the selection and chosen focus on an ordinary rerender", () => {
    render();
    const field = input();
    field.setSelectionRange(2, 5);
    render();
    expect(input()).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(5);

    const cancel = button(i18n.t("common.cancel"));
    act(() => cancel.focus());
    render();
    expect(document.activeElement).toBe(cancel);
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(5);
  });

  it("the shared prompt focuses and selects once without resetting later focus or selection", () => {
    const renderPrompt = () => act(() => root.render(
      <PromptDialog title="Workspace alias" initial="Existing alias" onSubmit={onRename} onCancel={onClose} />,
    ));
    renderPrompt();
    const field = input();
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);

    field.setSelectionRange(3, 7);
    renderPrompt();
    expect(input()).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(3);
    expect(field.selectionEnd).toBe(7);

    const cancel = button(i18n.t("common.cancel"));
    act(() => cancel.focus());
    renderPrompt();
    expect(document.activeElement).toBe(cancel);
    expect(field.selectionStart).toBe(3);
    expect(field.selectionEnd).toBe(7);
  });

  it("closes without renaming when the title is unchanged", () => {
    render();
    confirm();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("closes without renaming when the manual title is confirmed as is", () => {
    render(session({ customTitle: "Mine" }));
    typeInto("  Mine ");
    confirm();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
  });

  it("clears the manual title when confirmed empty", () => {
    render(session({ customTitle: "Mine" }));
    typeInto("   ");
    confirm();
    expect(onRename).toHaveBeenCalledWith("");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("treats an empty confirm without a manual title as no change", () => {
    render();
    typeInto("");
    confirm();
    expect(onRename).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("saves an edited title trimmed", () => {
    render();
    typeInto("  New name ");
    confirm();
    expect(onRename).toHaveBeenCalledWith("New name");
  });

  it("fills and selects a changed suggestion; confirming saves it", async () => {
    suggestSessionTitleMock.mockResolvedValue({ title: "🐛 登录｜修复", changed: true });
    render();
    await clickGenerate();

    expect(suggestSessionTitleMock).toHaveBeenCalledWith("claude", "s-1");
    expect(input().value).toBe("🐛 登录｜修复");
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe("🐛 登录｜修复".length);
    expect(statusText()).toBe(i18n.t("chat.titleSuggestionFilled"));
    expect(onRename).not.toHaveBeenCalled();

    confirm();
    expect(onRename).toHaveBeenCalledWith("🐛 登录｜修复");
  });

  it("says the title already fits when the suggestion is unchanged", async () => {
    suggestSessionTitleMock.mockResolvedValue({ title: "🧩 邮箱验证码｜过期修复", changed: false });
    render();
    typeInto("draft");
    await clickGenerate();

    expect(input().value).toBe("draft");
    expect(statusText()).toBe(i18n.t("chat.titleAlreadyFits"));
    expect(alertText()).toBeNull();
  });

  it("spins and disables the button while the suggestion runs", async () => {
    let resolve!: (value: SuggestedSessionTitle) => void;
    suggestSessionTitleMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render();
    await clickGenerate();

    expect(generateButton().disabled).toBe(true);
    expect(generateButton().querySelector("svg.animate-spin")).not.toBeNull();
    await clickGenerate();
    expect(suggestSessionTitleMock).toHaveBeenCalledTimes(1);

    await act(async () => resolve({ title: "x", changed: false }));
    expect(generateButton().disabled).toBe(false);
    expect(generateButton().querySelector("svg.animate-spin")).toBeNull();
  });

  it.each(["changed", "keep", "failure"] as const)(
    "drops a late %s outcome after the user edits, then allows a fresh request",
    async (outcome) => {
      const pending = pendingSuggestion();
      render();
      await clickGenerate();
      typeInto("My final title");
      input().setSelectionRange(3, 6);
      const cancel = button(i18n.t("common.cancel"));
      act(() => cancel.focus());

      await act(async () => {
        if (outcome === "failure") pending.reject("timeout");
        else pending.resolve({ title: "AI suggestion", changed: outcome === "changed" });
      });

      expect(input().value).toBe("My final title");
      expect(input().selectionStart).toBe(3);
      expect(input().selectionEnd).toBe(6);
      expect(document.activeElement).toBe(cancel);
      expect(statusText()).toBe("");
      expect(alertText()).toBeNull();
      expect(generateButton().disabled).toBe(false);
      expect(generateButton().querySelector("svg.animate-spin")).toBeNull();
      expect(onRename).not.toHaveBeenCalled();

      suggestSessionTitleMock.mockResolvedValue({ title: "Fresh suggestion", changed: true });
      await clickGenerate();
      expect(suggestSessionTitleMock).toHaveBeenCalledTimes(2);
      expect(input().value).toBe("Fresh suggestion");
      expect(statusText()).toBe(i18n.t("chat.titleSuggestionFilled"));
    },
  );

  it("an edit reverted to the starting title still invalidates the pending suggestion", async () => {
    const pending = pendingSuggestion();
    render();
    const original = input().value;
    await clickGenerate();
    typeInto("Temporary edit");
    typeInto(original);
    input().setSelectionRange(2, 2);

    await act(async () => pending.resolve({ title: "AI suggestion", changed: true }));
    expect(input().value).toBe(original);
    expect(input().selectionStart).toBe(2);
    expect(input().selectionEnd).toBe(2);
    expect(statusText()).toBe("");
    expect(generateButton().disabled).toBe(false);
  });

  it.each(["success", "failure"] as const)(
    "switching sessions starts a fresh dialog and drops the old request's %s",
    async (outcome) => {
      const pending = pendingSuggestion();
      const renderDialog = (meta: SessionMeta) => act(() => root.render(
        <ChatPageDialogs dialog={{ kind: "rename", session: meta }} onClose={onClose} />,
      ));
      renderDialog(session());
      typeInto("Old session draft");
      await clickGenerate();

      renderDialog(session({ sessionId: "s-2", title: "Second session" }));
      expect(input().value).toBe("Second session");
      expect(generateButton().disabled).toBe(false);
      typeInto("Second session draft");
      input().setSelectionRange(2, 4);
      const cancel = button(i18n.t("common.cancel"));
      act(() => cancel.focus());

      await act(async () => {
        if (outcome === "failure") pending.reject("timeout");
        else pending.resolve({ title: "Old session suggestion", changed: true });
      });
      expect(input().value).toBe("Second session draft");
      expect(input().selectionStart).toBe(2);
      expect(input().selectionEnd).toBe(4);
      expect(document.activeElement).toBe(cancel);
      expect(statusText()).toBe("");
      expect(alertText()).toBeNull();
      expect(generateButton().disabled).toBe(false);
    },
  );

  it("shows the mapped error as an alert and keeps the draft", async () => {
    suggestSessionTitleMock.mockRejectedValue("timeout");
    render();
    await clickGenerate();

    expect(alertText()).toBe(i18n.t("chat.suggestTitleError.timeout"));
    expect(input().value).toBe("🧩 邮箱验证码｜过期修复");
    expect(generateButton().disabled).toBe(false);
  });

  it("shows the generic failure for unknown errors", async () => {
    suggestSessionTitleMock.mockRejectedValue(new Error("socket closed"));
    render();
    await clickGenerate();

    expect(alertText()).toBe(i18n.t("chat.suggestTitleError.failed"));
  });

  it("drops a suggestion that lands after the dialog closed", async () => {
    let resolve!: (value: SuggestedSessionTitle) => void;
    suggestSessionTitleMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render();
    await clickGenerate();
    act(() => button(i18n.t("common.cancel")).click());
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.render(null));

    await act(async () => resolve({ title: "late", changed: true }));
    expect(document.body.querySelector("input")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("drops a failure that lands after the dialog closed", async () => {
    let reject!: (err: unknown) => void;
    suggestSessionTitleMock.mockReturnValue(
      new Promise((_, r) => {
        reject = r;
      }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render();
    await clickGenerate();
    act(() => root.render(null));

    await act(async () => reject("timeout"));
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("offers no suggestion for remote sessions", () => {
    render(session({ remote: true, remotePath: "/home/u/s-1.jsonl" }));
    expect(
      [...document.body.querySelectorAll("button")].some((b) =>
        b.textContent?.includes(i18n.t("chat.generateTitle")),
      ),
    ).toBe(false);
  });
});
