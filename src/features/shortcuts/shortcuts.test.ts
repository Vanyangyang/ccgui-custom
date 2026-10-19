import { describe, expect, it } from "vitest";
import {
  formatShortcutForPlatform,
  matchesShortcutForPlatform,
  splitShortcutForPlatform,
} from "./shortcuts";

describe("splitShortcutForPlatform", () => {
  it("splits shortcuts into key-cap segments on mac", () => {
    expect(splitShortcutForPlatform("cmd+,", true)).toEqual(["⌘", ","]);
    expect(splitShortcutForPlatform("cmd+shift+arrowdown", true)).toEqual([
      "⌘",
      "⇧",
      "↓",
    ]);
    expect(splitShortcutForPlatform("cmd+ctrl+down", true)).toEqual([
      "⌘",
      "⌃",
      "↓",
    ]);
  });

  it("splits shortcuts into text segments on non-mac platforms", () => {
    expect(splitShortcutForPlatform("cmd+o", false)).toEqual(["Ctrl", "O"]);
    expect(splitShortcutForPlatform("cmd+ctrl+a", false)).toEqual([
      "Meta",
      "Ctrl",
      "A",
    ]);
  });

  it("returns null for empty or unparseable values", () => {
    expect(splitShortcutForPlatform(null, true)).toBeNull();
    expect(splitShortcutForPlatform("", true)).toBeNull();
    expect(splitShortcutForPlatform("shift", true)).toBeNull();
  });
});

describe("formatShortcutForPlatform", () => {
  it("formats shortcuts with symbols on mac", () => {
    expect(formatShortcutForPlatform("cmd+o", true)).toBe("⌘O");
    expect(formatShortcutForPlatform("cmd+shift+arrowdown", true)).toBe("⌘⇧↓");
    expect(formatShortcutForPlatform("alt+f1", true)).toBe("⌥F1");
    expect(formatShortcutForPlatform("alt+f7", true)).toBe("⌥F7");
  });

  it("formats shortcuts with text labels on non-mac platforms", () => {
    expect(formatShortcutForPlatform("cmd+o", false)).toBe("Ctrl+O");
    expect(formatShortcutForPlatform("cmd+shift+arrowdown", false)).toBe(
      "Ctrl+Shift+Down",
    );
    expect(formatShortcutForPlatform("cmd+ctrl+a", false)).toBe("Meta+Ctrl+A");
    expect(formatShortcutForPlatform("alt+f7", false)).toBe("Alt+F7");
  });

  it("normalizes legacy arrow aliases in configured shortcut labels", () => {
    expect(formatShortcutForPlatform("cmd+ctrl+down", true)).toBe("⌘⌃↓");
    expect(formatShortcutForPlatform("cmd+shift+up", false)).toBe(
      "Ctrl+Shift+Up",
    );
  });
});

describe("matchesShortcutForPlatform", () => {
  it("does not collapse Cmd+Ctrl shortcuts into Ctrl-only on non-mac platforms", () => {
    const event = {
      key: "a",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
    } as KeyboardEvent;
    const ctrlMetaEvent = {
      ...event,
      metaKey: true,
    } as KeyboardEvent;

    expect(matchesShortcutForPlatform(event, "cmd+ctrl+a", false)).toBe(false);
    expect(matchesShortcutForPlatform(ctrlMetaEvent, "cmd+ctrl+a", false)).toBe(
      true,
    );
    expect(matchesShortcutForPlatform(event, "cmd+a", false)).toBe(true);
  });

  it("matches shifted punctuation keys for configured shortcuts", () => {
    expect(
      matchesShortcutForPlatform(
        {
          key: "{",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        } as KeyboardEvent,
        "cmd+shift+[",
        true,
      ),
    ).toBe(true);
    expect(
      matchesShortcutForPlatform(
        {
          key: "~",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        } as KeyboardEvent,
        "cmd+shift+`",
        true,
      ),
    ).toBe(true);
    expect(
      matchesShortcutForPlatform(
        {
          key: "+",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: true,
        } as KeyboardEvent,
        "cmd+=",
        true,
      ),
    ).toBe(true);
  });

  it("matches configured arrow aliases against DOM Arrow key events", () => {
    expect(
      matchesShortcutForPlatform(
        {
          key: "ArrowDown",
          metaKey: true,
          ctrlKey: true,
          altKey: false,
          shiftKey: false,
        } as KeyboardEvent,
        "cmd+ctrl+down",
        true,
      ),
    ).toBe(true);
    expect(
      matchesShortcutForPlatform(
        {
          key: "ArrowUp",
          metaKey: false,
          ctrlKey: true,
          altKey: false,
          shiftKey: true,
        } as KeyboardEvent,
        "cmd+shift+up",
        false,
      ),
    ).toBe(true);
  });
});
