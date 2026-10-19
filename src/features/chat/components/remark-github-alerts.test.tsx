import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Markdown from "./Markdown";
import { isAlertClassName } from "./remark-github-alerts";
import type { AlertType } from "./remark-github-alerts";
import i18n from "@/lib/i18n";

// React's act() environment flag — a well-known global the runtime can't
// validate, so a named cast with no narrowing is the right boundary.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderMarkdown(text: string, streaming = false) {
  await act(async () => {
    root.render(
      <Markdown text={text} workspacePath="/ws" streaming={streaming} />,
    );
  });
}

const ALL_TYPES: AlertType[] = [
  "note",
  "tip",
  "important",
  "warning",
  "caution",
];

describe("isAlertClassName", () => {
  it("reads the type from a hast className array", () => {
    expect(isAlertClassName(["md-alert", "md-alert-warning"])).toBe("warning");
  });

  it("reads the type from a space-separated className string", () => {
    expect(isAlertClassName("md-alert md-alert-note")).toBe("note");
  });

  it("returns null for a plain quote class list", () => {
    expect(isAlertClassName("md-alert")).toBeNull();
    expect(isAlertClassName(undefined)).toBeNull();
  });
});

describe("GitHub-style blockquote alerts", () => {
  it.each(ALL_TYPES)("renders a %s callout card with no raw marker", async (type) => {
    await renderMarkdown(`> [!${type.toUpperCase()}]\n> body of the alert`);
    const card = container.querySelector(`blockquote.md-alert-${type}`);
    expect(card).not.toBeNull();
    expect(card?.querySelector(".md-alert-title")).not.toBeNull();
    expect(container.textContent).not.toContain(`[!${type.toUpperCase()}]`);
    expect(card?.textContent).toContain("body of the alert");
  });

  it("keeps the body when the marker shares the paragraph (`> [!NOTE]\\n> body`)", async () => {
    await renderMarkdown("> [!NOTE]\n> inline body");
    const card = container.querySelector("blockquote.md-alert-note");
    expect(card).not.toBeNull();
    expect(container.textContent).not.toContain("[!NOTE]");
    expect(card?.textContent).toContain("inline body");
  });

  it("splits consecutive alerts merged by a quoted blank line", async () => {
    await renderMarkdown("> [!NOTE]\n> note body\n>\n> [!TIP]\n> tip body\n>\n> [!IMPORTANT]\n> important body");
    expect(container.querySelectorAll("blockquote.md-alert").length).toBe(3);
    expect(container.querySelector("blockquote.md-alert-note")?.textContent).toContain("note body");
    expect(container.querySelector("blockquote.md-alert-tip")?.textContent).toContain("tip body");
    expect(container.querySelector("blockquote.md-alert-important")?.textContent).toContain("important body");
    expect(container.textContent).not.toContain("[!TIP]");
    expect(container.textContent).not.toContain("[!IMPORTANT]");
  });

  it("splits consecutive alerts that share one paragraph", async () => {
    await renderMarkdown("> [!NOTE]\n> note body\n> [!TIP]\n> tip body");
    expect(container.querySelectorAll("blockquote.md-alert").length).toBe(2);
    expect(container.querySelector("blockquote.md-alert-note")?.textContent).toContain("note body");
    expect(container.querySelector("blockquote.md-alert-tip")?.textContent).toContain("tip body");
    expect(container.textContent).not.toContain("[!TIP]");
  });

  it("splits a leftover '> [!TIP]' mashed into the previous alert body", async () => {
    await renderMarkdown("> [!NOTE]\n> note body. > [!TIP] tip body");
    expect(container.querySelectorAll("blockquote.md-alert").length).toBe(2);
    expect(container.querySelector("blockquote.md-alert-note")?.textContent).toContain("note body.");
    expect(container.querySelector("blockquote.md-alert-tip")?.textContent).toContain("tip body");
    expect(container.textContent).not.toContain("[!TIP]");
  });

  it("renders five consecutive alerts as five cards", async () => {
    await renderMarkdown(
      "> [!NOTE]\n> n\n>\n> [!TIP]\n> t\n>\n> [!IMPORTANT]\n> i\n>\n> [!WARNING]\n> w\n>\n> [!CAUTION]\n> c",
    );
    expect(container.querySelector("blockquote.md-alert-note")).not.toBeNull();
    expect(container.querySelector("blockquote.md-alert-tip")).not.toBeNull();
    expect(container.querySelector("blockquote.md-alert-important")).not.toBeNull();
    expect(container.querySelector("blockquote.md-alert-warning")).not.toBeNull();
    expect(container.querySelector("blockquote.md-alert-caution")).not.toBeNull();
    expect(container.querySelectorAll("blockquote.md-alert").length).toBe(5);
  });

  it("keeps inline markup in the body after a marker-only first line", async () => {
    await renderMarkdown("> [!NOTE]\n> **bold** body");
    const card = container.querySelector("blockquote.md-alert-note");
    expect(card).not.toBeNull();
    expect(container.textContent).not.toContain("[!NOTE]");
    expect(card?.querySelector("strong")?.textContent).toBe("bold");
    expect(card?.textContent).toContain("body");
  });

  it("renders multiple body paragraphs inside one card", async () => {
    await renderMarkdown("> [!WARNING]\n> first\n>\n> second");
    const card = container.querySelector("blockquote.md-alert-warning");
    expect(card?.querySelectorAll("p").length).toBe(2);
    expect(card?.textContent).toContain("first");
    expect(card?.textContent).toContain("second");
  });

  it("leaves a plain quote flattened (no alert card)", async () => {
    await renderMarkdown("> just a quote");
    const quote = container.querySelector("blockquote");
    expect(quote).not.toBeNull();
    expect(quote?.className).toBe("");
    expect(container.querySelector(".md-alert")).toBeNull();
    expect(container.querySelector(".md-alert-title")).toBeNull();
  });

  it("does not match a decorated marker (`> **[!NOTE]**`)", async () => {
    await renderMarkdown("> **[!NOTE]**");
    const quote = container.querySelector("blockquote");
    expect(quote?.className).toBe("");
    expect(container.textContent).toContain("[!NOTE]");
  });

  it("does not match a marker with trailing text on the line", async () => {
    // GitHub only treats the marker as an alert when it owns the line.
    await renderMarkdown("> [!NOTE] not a marker");
    const quote = container.querySelector("blockquote");
    expect(quote?.className).toBe("");
    expect(container.textContent).toContain("[!NOTE]");
  });

  it("does not match a marker with trailing inline markup on the line", async () => {
    await renderMarkdown("> [!NOTE] **important**");
    const quote = container.querySelector("blockquote");
    expect(quote?.className).toBe("");
    expect(container.querySelector(".md-alert")).toBeNull();
    expect(container.textContent).toContain("[!NOTE]");
    expect(container.querySelector("strong")?.textContent).toBe("important");
  });

  it("does not match a marker with trailing inline code on the line", async () => {
    await renderMarkdown("> [!NOTE] `code`");
    const quote = container.querySelector("blockquote");
    expect(quote?.className).toBe("");
    expect(container.querySelector(".md-alert")).toBeNull();
    expect(container.textContent).toContain("[!NOTE]");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("does not swallow an incomplete marker that already has a body line", async () => {
    // Finished (or mistyped) quote, not a streaming prefix of `> [!WARNING]`.
    await renderMarkdown("> [!WARNING\n> this is a quote");
    expect(container.querySelector(".md-alert")).toBeNull();
    expect(container.textContent).toContain("[!WARNING");
    expect(container.textContent).toContain("this is a quote");
  });

  it("drops the hard break that only separated the marker from the body", async () => {
    await renderMarkdown("> [!NOTE]  \n> body after break");
    const card = container.querySelector("blockquote.md-alert-note");
    expect(card).not.toBeNull();
    expect(card?.querySelector("br")).toBeNull();
    expect(container.textContent).not.toContain("[!NOTE]");
    expect(card?.textContent).toContain("body after break");
  });

  it("renders the translated alert title", async () => {
    const previous = i18n.language;
    try {
      await act(async () => {
        await i18n.changeLanguage("zh");
      });
      await renderMarkdown("> [!NOTE]\n> body");
      expect(container.querySelector(".md-alert-title")?.textContent).toContain("注意");

      await act(async () => {
        await i18n.changeLanguage("en");
      });
      await renderMarkdown("> [!NOTE]\n> body");
      expect(container.querySelector(".md-alert-title")?.textContent).toContain("Note");
    } finally {
      await act(async () => {
        await i18n.changeLanguage(previous);
      });
    }
  });

  it("renders an empty title-only card while the body has not arrived", async () => {
    await renderMarkdown("> [!TIP]");
    const card = container.querySelector("blockquote.md-alert-tip");
    expect(card).not.toBeNull();
    expect(card?.querySelector(".md-alert-title")).not.toBeNull();
    expect(container.textContent).not.toContain("[!TIP]");
  });

  it("blanks a partially-arrived marker instead of flashing raw text", async () => {
    // Streaming snapshot: `> [!NO` is a strict prefix of `[!NOTE]`.
    await renderMarkdown("> [!NO");
    expect(container.textContent).not.toContain("[!NO");
    expect(container.querySelector(".md-alert")).toBeNull();

    // Marker completes: the card appears.
    await renderMarkdown("> [!NOTE]\n> arrived");
    expect(container.querySelector("blockquote.md-alert-note")).not.toBeNull();
    expect(container.textContent).toContain("arrived");
  });

  it("keeps reveal spans on the alert body while streaming (offset parity)", async () => {
    await renderMarkdown("> [!NOTE]\n> streaming body", true);
    const card = container.querySelector("blockquote.md-alert-note");
    expect(card).not.toBeNull();
    // Reveal-plan stamps `dataStreamStart` on the HAST, where the host span
    // override consumes it and renders RevealText — so the DOM shows a plain
    // span wrapping the body's moving prefix. A bare text node would mean the
    // blockquote was left out of the reveal plan after the marker removal.
    expect(card?.querySelector("p span")).not.toBeNull();
    expect(card?.textContent).not.toContain("[!NOTE]");
  });
});
