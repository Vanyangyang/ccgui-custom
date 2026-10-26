import { ipc } from "@/lib/ipc";
import { useChatStore } from "@/features/chat/store";
import { dismissCenterSurfaces } from "@/features/chat/center-surfaces";
import { normalizeProjectPath } from "./paths";
/** Only an explicit launch can register a subdirectory; selecting a view is inert. */
export async function launchProjectPath(path: string, registrationError = "Workspace registration could not be verified"): Promise<void> {
  const registered = () => useChatStore.getState().workspaces.some((w) => normalizeProjectPath(w.path) === normalizeProjectPath(path));
  if (!registered()) {
    // The chat-store addWorkspace action intentionally absorbs errors. Use the
    // rejecting IPC boundary here so registration failure cannot start a chat.
    await ipc.addWorkspace(path);
    await useChatStore.getState().refreshWorkspaces();
    if (!registered()) throw new Error(registrationError);
  }
  dismissCenterSurfaces();
  useChatStore.getState().startNewChat(path);
}
