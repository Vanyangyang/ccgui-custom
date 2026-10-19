---
name: ccgui-collab
description: Use for explicitly requested saved-chat communication, or creating and coordinating child tasks within the user's authorized task in CCGUI.
---

# CCGUI communication

Use saved-chat communication only when explicitly authorized for the target. You may create and coordinate useful child tasks within the user's authorized task without a separate mode switch. Management authority follows the actual parent-child relationship bound by the host; it does not grant control over unrelated conversations.

## Saved chats

Use `list_chats` to resolve the target. `send_message` requires the human's explicit authorization to contact that target; when receiving a `[Message from CC GUI ...]` prompt, answer directly in your normal assistant response (which is automatically captured and returned to the sender in `text`) rather than calling `send_message` back. Preserve the target's settings and approval state.

`send_message` and `get_message_status` wait up to `wait_seconds` (0–20s, default 20s) for the target chat's turn to settle and return its assistant reply in `text` (`receipt.text`) when `status` reaches `"completed"`. If `status` is still `"queued"`, `"received"`, or `"executing"` after the initial wait, call `get_message_status` with the same `request_id` to continue waiting for completion and read `receipt.text`. For multi-turn consultation, send follow-up `send_message` calls with a new `request_id`. After an unknown transport outcome, inspect `get_message_status` with the original `request_id` before retrying; a missing receipt after a restart does not authorize replay.

## Child tasks

The host exposes `task_spawn`, `task_list`, `task_wait`, `task_send`, `task_renew`, and `task_stop` in ordinary conversations. No Leader mode is required. Create a new Claude Code, Codex, AGY or Cursor child with `task_spawn`; use the task tools to manage only your actual direct children. A directly launched CLI is not a managed child, and saved-chat activity does not establish its process status.

Delegate when useful within the authorized task. Give each child enough context to act: the objective, relevant paths and facts, edit scope and constraints, and the expected verification. Children share workspace files and receive only their task text, so coordinate overlapping edits. Review their deliverables and uncertainty before accepting results.

Before selecting a model, inspect `task_list.modelPolicy` for the intended engine: `allowedModels: null` means no model restriction, `[]` blocks new children for that engine, and a nonempty list permits exact ids only. An omitted model uses the effective `defaultModel`. Choose effort supported by the engine, or omit it to use that engine's default; the host applies the engine's supported effort behavior. These restrictions apply only when creating future child tasks. Parent conversations, existing children and saved-chat consultations keep their settings.

Use `task_list` or `task_wait` to inspect progress and results. Follow up with `task_send` only when more work is needed. Use stable request IDs for creation and follow-up; inspect state after an uncertain outcome instead of duplicating work. TTL expiry calls for inspection; it does not automatically stop or reassign work. Completion preserves conversations, and `task_stop` stops execution without deleting history. Use `task_renew` when an existing task needs more time.

Archive, restore, reclaim and permanent deletion remain user actions in the GUI. Do not treat task creation or management as permission to delete conversations or their results. The old `leader_*` tools are removed; use only the `task_*` tools above.
