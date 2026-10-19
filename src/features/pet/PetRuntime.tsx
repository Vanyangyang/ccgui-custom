import { useEffect } from "react";
import { useChatStore } from "@/features/chat/store";
import { ensureMissionPersistenceLoaded } from "@/features/mission/runtime";
import { useMissionStore } from "@/features/mission/store";
import { ipc } from "@/lib/ipc";
import { listen } from "@/lib/transport";
import { derivePetStates, type PetStateSnapshot } from "./pet-state";

const DISPLAY_INTERVAL_MS = 1800;
const COMPLETION_DISPLAY_MS = 5400;

function snapshotSignature(snapshot: PetStateSnapshot): string {
  // lookDirection is owned by the native cursor tracker, not the frontend.
  return [
    snapshot.sessionKey,
    snapshot.sessionName,
    snapshot.status,
    snapshot.activity,
  ].join(":");
}

function isWorkingStatus(status: PetStateSnapshot["status"]): boolean {
  return status === "running" || status === "waiting";
}

const IDLE_SNAPSHOT: PetStateSnapshot = {
  sessionKey: null,
  sessionName: null,
  status: "idle",
  lookDirection: 0,
  activity: "idle",
};

/** Main-window-only bridge. The overlay is a separate Tauri window and loads
 * PetOverlayApp through the #/pet-overlay route. */
export function PetRuntime() {
  useEffect(() => {
    let disposed = false;
    // State derivation walks every session on each chat-store update; skip
    // all of it while the pet is disabled (default). pet_set_scale and
    // pet_save_position bypass update_app_settings, so the toggle and the
    // bypassed writes both arrive through the backend-emitted event.
    let petEnabled = false;
    const reloadPetEnabled = () => {
      void ipc
        .refreshAppSettings()
        .then((settings) => {
          petEnabled = settings.petEnabled ?? false;
          publish();
        })
        .catch(() => {});
    };
    ensureMissionPersistenceLoaded();
    let last = "";
    let displayedKey: string | null = null;
    let previous = new Map<string, PetStateSnapshot>();
    const completions = new Map<
      string,
      { snapshot: PetStateSnapshot; expiresAt: number }
    >();

    const publish = (rotate = false) => {
      if (disposed || !petEnabled) return;
      const now = Date.now();
      const current = derivePetStates(useChatStore.getState(), useMissionStore.getState());
      const currentByKey = new Map(
        current
          .filter((snapshot): snapshot is PetStateSnapshot & { sessionKey: string } =>
            snapshot.sessionKey !== null,
          )
          .map((snapshot) => [snapshot.sessionKey, snapshot]),
      );
      const newlyCompleted: string[] = [];

      for (const [key, before] of previous) {
        if (!currentByKey.has(key) && isWorkingStatus(before.status)) {
          completions.set(key, {
            snapshot: {
              ...before,
              status: "idle",
              activity: "completed",
            },
            expiresAt: now + COMPLETION_DISPLAY_MS,
          });
          newlyCompleted.push(key);
        }
      }
      for (const key of currentByKey.keys()) completions.delete(key);
      for (const [key, completion] of completions) {
        if (completion.expiresAt <= now) completions.delete(key);
      }

      const candidates = [
        ...current,
        ...[...completions.values()].map(({ snapshot }) => snapshot),
      ];
      const candidateKeys = new Set(candidates.map((snapshot) => snapshot.sessionKey));
      const changed = current.find((snapshot) => {
        const before = snapshot.sessionKey ? previous.get(snapshot.sessionKey) : undefined;
        return !before || snapshotSignature(before) !== snapshotSignature(snapshot);
      });
      const focusKey = newlyCompleted[0] ?? changed?.sessionKey ?? null;

      if (focusKey !== null && candidateKeys.has(focusKey)) {
        displayedKey = focusKey;
      } else if (rotate && candidates.length > 1) {
        const index = candidates.findIndex((snapshot) => snapshot.sessionKey === displayedKey);
        displayedKey = candidates[(index + 1) % candidates.length]?.sessionKey ?? null;
      } else if (!candidateKeys.has(displayedKey)) {
        displayedKey = candidates[0]?.sessionKey ?? null;
      }

      previous = new Map(currentByKey);
      const selected = candidates.find((snapshot) => snapshot.sessionKey === displayedKey) ?? IDLE_SNAPSHOT;
      const key = snapshotSignature(selected);
      if (key === last || disposed) return;
      last = key;
      void ipc
        .setPetState({ ...selected, changedAt: Date.now() })
        .catch((error) => console.warn("[pet] state publish failed", error));
    };

    reloadPetEnabled();
    const unlistenSettings = listen("settings://changed", reloadPetEnabled);
    const rotationTimer = window.setInterval(() => publish(true), DISPLAY_INTERVAL_MS);
    const unsubscribeChat = useChatStore.subscribe(() => publish());
    const unsubscribeMission = useMissionStore.subscribe(() => publish());
    return () => {
      disposed = true;
      window.clearInterval(rotationTimer);
      unsubscribeChat();
      unsubscribeMission();
      void unlistenSettings.then((dispose) => dispose());
    };
  }, []);
  return null;
}
