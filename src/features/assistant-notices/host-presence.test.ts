import { expect, it, vi } from "vitest";
import { chatHostVisible, publishChatHostPresence, subscribeChatHostPresence } from "./host-presence";
it("tracks actual surfaces and an old pane cleanup cannot hide a newer pane", () => {
  const changed = vi.fn(); const unsubscribe = subscribeChatHostPresence(changed);
  expect(chatHostVisible()).toBe(false);
  const old = publishChatHostPresence(false); expect(chatHostVisible()).toBe(false);
  const next = publishChatHostPresence(true); old(); expect(chatHostVisible()).toBe(true);
  next(); expect(chatHostVisible()).toBe(false); expect(changed).toHaveBeenCalledTimes(4); unsubscribe();
});
