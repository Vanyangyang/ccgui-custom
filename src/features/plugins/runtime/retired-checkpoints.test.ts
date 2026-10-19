import { describe, expect, it } from "vitest";
import { createRuntimeCheckpointCoordinator, type RuntimeCheckpoint } from "@/lib/runtime-checkpoint";
import { retainRetiredHostChatCheckpoints } from "./retired-checkpoints";

const id = "host-chat-bridge:spellcast-canvas-bridge";
function restored(participants: RuntimeCheckpoint["participants"]) {
  const checkpoint: RuntimeCheckpoint = { version: 1, participants };
  const coordinator = createRuntimeCheckpointCoordinator();
  coordinator.initialize(checkpoint, { requiredParticipants: [] });
  const dispose = retainRetiredHostChatCheckpoints(checkpoint, coordinator);
  return { coordinator, dispose };
}

describe("retired host chat checkpoint compatibility", () => {
  it("preserves opaque queued and executing records across repeated handoffs without an execution owner", async () => {
    const state = { version: 1, pluginId: "spellcast-canvas-bridge", ledger: { entries: [
      { prompt: "保留中文🙂", receipt: { status: "queued", runId: "queued-original" } },
      { receipt: { status: "executing", runId: "running-original" } },
    ] }, pendingTerminals: [["running-original", { output: "历史结果" }]] };
    const { coordinator, dispose } = restored({ [id]: state });
    await coordinator.resume();
    expect(coordinator.isPaused()).toBe(false);
    const next = await coordinator.prepare();
    expect(next.participants[id]).toEqual(state);
    state.ledger.entries[0].prompt = "later mutation";
    expect(next.participants[id]).not.toEqual(state);
    const again = restored(next.participants);
    await again.coordinator.resume();
    expect((await again.coordinator.prepare()).participants).toEqual(next.participants);
    dispose(); again.dispose();
  });

  it("keeps other missing owners blocked even alongside the retired plugin", async () => {
    const { coordinator, dispose } = restored({
      [id]: { version: 1, pluginId: "spellcast-canvas-bridge" },
      "host-chat-bridge:spellcast-other": { version: 1, pluginId: "spellcast-other" },
      "unknown-participant": {},
    });
    await expect(coordinator.awaitReady()).rejects.toThrow(/spellcast-other.*unknown-participant/);
    expect(coordinator.readiness()).not.toContainEqual({ participant: id, reason: "checkpoint-not-restored" });
    dispose();
  });

  it.each([null, { version: 2, pluginId: "spellcast-canvas-bridge" }, { version: 1, pluginId: "other" }])(
    "rejects a mismatched retired participant: %j", state => {
      expect(() => restored({ [id]: state })).toThrow("Invalid retired host chat bridge checkpoint");
    },
  );
});
