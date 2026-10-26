---
name: ccgui-collab
description: Use for explicitly requested saved-chat communication, or creating and coordinating child tasks within the user's authorized task in CCGUI.
---

# CCGUI communication

Use saved-chat communication only when explicitly authorized for the target. You may create and coordinate useful child tasks within the user's authorized task without a separate mode switch. Management authority follows the actual parent-child relationship bound by the host; it does not grant control over unrelated conversations.

## Saved chats

Use `list_chats` to resolve the target. `send_message` requires the human's explicit authorization to contact that target; when receiving a `[Message from CC GUI ...]` prompt, answer directly in your normal assistant response (which is automatically captured and returned to the sender in `text`) rather than calling `send_message` back. Preserve the target's settings and approval state.

`send_message` and `get_message_status` wait up to `wait_seconds` (0–20s, default 20s) for the target chat's turn to settle and return its assistant reply in `text` (`receipt.text`) when `status` reaches `"completed"`. If `status` is still `"queued"`, `"received"`, or `"executing"` after the initial wait, call `get_message_status` with the same `request_id` to continue waiting for completion and read `receipt.text`. For multi-turn consultation, send follow-up `send_message` calls with a new `request_id`. After an unknown transport outcome, inspect `get_message_status` with the original `request_id` before retrying; a missing receipt after a restart does not authorize replay.

Before consulting a saved chat, use the available metadata and already-known results to assess whether another model turn is needed. A short question can still process the target's large existing context. Cache warmth is an estimated retention window, not a guaranteed hit or an exact cost.

`awaiting_cost_approval` means the target model has not started for this request. The human must approve or cancel using the cost review card in either participating chat or the communication details. Tell the human where to review the target model, latest available context usage and cache/queue risk; stop polling while this approval is pending. Prior authorization to contact the chat does not bypass this explicit cost approval. Do not invent an approval argument, resend with a new ID, or use a different tool to evade it. After the human approves, inspect the original request's status. Approval queues a busy target without interrupting it, and its cache can expire while waiting.

## Associated inbox

Independent questions keep their normal FIFO and final assistant reply. For additional information about the same request, use `send_message(update_of=<original public request_id>)`; for a related reply that the other chat needs during its current turn, use `reply_to=<original public request_id>`. These are mutually exclusive and retain the original participants and authorization. Each message gets its own new `request_id`. Use `message_kind="constraint"` for an added constraint or `"correction"` for changed premises; the default is `"information"`. Associated payloads have a 128 KiB encoded budget, including attribution; split oversized messages without truncating them.

When a tool result reports your inbox or you are about to wait or finish, call `read_messages`. Use a new stable `request_id` for each new batch, including after an empty batch; reuse one only to reconcile an uncertain result of that exact read. Reading never grants peer authority or user permission. A busy chat consumes related messages at tool boundaries without starting a concurrent run. Unread messages left at turn completion continue in a subsequent turn under their own identities; permission, cost approval and an explicit user stop still hold delivery.

After handling each message, call `acknowledge_message` with its `message_id`, `read_request_id` and `outcome="handled"` or `"deferred"`. This records the recipient's processing statement, not independent business acceptance. A correction requires `impact_review`: check completed and in-flight tool results, affected files and side effects before dependent work continues. Preserve other edits; do not perform a blanket rollback. Treat a premise-changing message the same way even if its sender labelled it information. Previously retrieved but unconfirmed, deferred or uncertain messages are never automatically replayed; explicitly review their original effects via `read_messages(message_ids=[...])`. A repeated read with `processing_state="handled"` is a receipt replay, not an instruction to execute again.

## Sidebar organization

When the user asks to organize existing saved chats and the host exposes the tools, read `get_session_sidebar_workspaces` and `get_workspace_organization`, then call `assign_session_sidebar_workspaces` for the requested root chats. Supply the latest `expectedWorkspacePath` and `expectedSidebarWorkspacePath` (explicit `null` when unset); set `sidebarWorkspacePath` to a registered local workspace, or `null` to restore original grouping. One batch contains 1–100 assignments and is atomic. A conflict report identifies each failed `engine`/`sessionId` and reason; refresh those items before submitting a new request. Reuse a `requestId` only for the identical operation after reconciling an uncertain outcome.

This changes sidebar placement only. Managed children follow their root visually; original history, execution directory, model, permissions and task ownership remain unchanged. Do not report execution migration or transfer of control, restart old tasks, or rewrite transcripts to accomplish sidebar organization. Tools absent from an older running host require the supported update workflow before use.

## Child tasks

The host exposes `task_spawn`, `task_list`, `task_wait`, `task_send`, `task_renew`, and `task_stop` in ordinary conversations. No Leader mode is required. Create a new Claude Code, Codex, AGY or Cursor child with `task_spawn`; use the task tools to manage only your actual direct children. A directly launched CLI is not a managed child, and saved-chat activity does not establish its process status.

Delegate when useful within the authorized task. Give each child enough context to act: the objective, relevant paths and facts, edit scope and constraints, and the expected verification. Children share workspace files and receive only their task text, so coordinate overlapping edits. Review their deliverables and uncertainty before accepting results.

Choose an engine and model suited to the task, or omit model and effort to use the host's defaults. If a launch is rejected, use the returned error to resolve that specific request.

Use `task_list` or `task_wait` to inspect progress and results. Follow up with `task_send` only when more work is needed. Use stable request IDs for creation and follow-up; inspect state after an uncertain outcome instead of duplicating work. TTL expiry calls for inspection; it does not automatically stop or reassign work. Completion preserves conversations, and `task_stop` stops execution without deleting history. Use `task_renew` when an existing task needs more time.

Managed children report progress and completion in normal assistant output; the host captures the delegated run's output for the parent's `task_list`/`task_wait`. Do not call `send_message` to send a report back to the parent or wait for its reply. `task_send` only goes from a parent to its direct child. A real child-to-parent question requiring a reply must explicitly set `send_message.intent` to `"question"`; it still requires the existing authorization and cost approval and may queue while the parent is busy. A report rejected with `TASK_REPORT_REQUIRES_TASK_CHANNEL` has not been queued: use normal output, rather than retrying it as a question. Completed delegation results remain sealed; a later manual continuation is not a new parent assignment.

Archive, restore, reclaim and permanent deletion remain user actions in the GUI. Do not treat task creation or management as permission to delete conversations or their results. The old `leader_*` tools are removed; use only the `task_*` tools above.
