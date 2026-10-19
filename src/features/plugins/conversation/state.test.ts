import { describe, expect, it } from "vitest";
import { ConversationModeState } from "./state";

describe("conversation mode state", () => {
  it("retains locked draft identity and recovery mode through pruning, unload and reload", () => {
    let identities: Record<string, string> = {};
    let locks: Record<string, string> = {};
    const state = new ConversationModeState({}, (value) => { identities = value; }, {}, (value) => { locks = value; });
    const identity = state.identity("new:pi:/a", "/a", true);
    state.select(identity, "plugin:relay", false, 0);
    state.setExitBlocked(identity, "plugin:relay", true);
    state.exit(identity);
    state.removeMode("plugin:relay");
    state.retain([]);
    expect(state.identity("new:pi:/a", "/a", true)).toBe(identity);
    expect(state.selected(identity)).toBe("plugin:relay");
    const restored = new ConversationModeState(identities, () => {}, locks);
    expect(restored.isTabCloseBlocked("new:pi:/a", "/a")).toBe(true);
    expect(restored.isTabCloseBlocked("new:pi:/b", "/b")).toBe(false);
    expect(restored.selected(identity)).toBe("plugin:relay");
    restored.setExitBlocked(identity, "plugin:other", false);
    expect(restored.isExitBlocked(identity)).toBe(true);
    restored.setExitBlocked(identity, "plugin:relay", false);
    expect(restored.isTabCloseBlocked("new:pi:/a", "/a")).toBe(false);
    restored.retain([]);
    expect(restored.identity("new:pi:/a", "/a", true)).not.toBe(identity);
  });
  it("restores draft identity after reload and persists pruning closed sessions", () => {
    let saved: Record<string, string> = {};
    const state = new ConversationModeState({}, (value) => { saved = value; });
    const identity = state.identity("new:pi:/a", "/a", true);
    const restored = new ConversationModeState(saved, (value) => { saved = value; });
    expect(restored.identity("new:pi:/a", "/a", true)).toBe(identity);
    restored.retain([]);
    expect(saved).toEqual({});
    expect(restored.identity("new:pi:/a", "/a", true)).not.toBe(identity);
  });
  it("uses full session keys and workspace boundaries, with stable unique draft lifetimes", () => {
    const state = new ConversationModeState();
    const first = state.identity("new:codex:/a", "/a", true);
    expect(state.identity("new:codex:/a", "/a", true)).toBe(first);
    expect(state.identity("new:codex:/b", "/b", true)).not.toBe(first);
    expect(state.identity("codex/id", "/a", false)).not.toBe(state.identity("pi/id", "/a", false));
    expect(state.identity("codex/id", "/a", false)).not.toBe(state.identity("codex/id", "/b", false));
    state.retain([]);
    expect(state.identity("new:codex:/a", "/a", true)).not.toBe(first);
  });
  it("keeps selections per session and rejects busy entry", () => {
    const state = new ConversationModeState();
    expect(state.select("first", "relay", true, 0)).toBe(false);
    expect(state.select("first", "relay", false, 1)).toBe(false);
    expect(state.selected("first")).toBeUndefined();
    expect(state.select("first", "relay", false, 0)).toBe(true);
    expect(state.selected("second")).toBeUndefined();
    state.exit("second");
    expect(state.selected("first")).toBe("relay");
    state.removeMode("relay");
    expect(state.selected("first")).toBeUndefined();
  });
});
