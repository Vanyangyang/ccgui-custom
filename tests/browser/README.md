# Chat streaming regression

Open `/tests/browser/onboarding.html` for the production feature guide and
Sidechat toolbar button, with synthetic input/settings/image/notice controls.
Use `?topic=handoff`, `btw`, `imageAnnotation`, `proxy`, `selfUpdate`,
`assistantNotices`, or `intelligenceUi` (default: `sidechat`). Instructions stay
still; command examples identify the actual input field and require submission.
Going to an input preserves the draft; locating the build button must leave the
mock build click count at zero. Opening settings reveals its precise control.
Self-update has three manual steps: review the bottom-right list, decide whether
to request the update, then the optional workspace build route. Review must keep
mock requests at zero; locating the status button must also keep it at zero until
the user clicks the real button after leaving the guide. `&update=busy` makes
that button open details instead of requesting another update.
Variants: `&image=1`, `&disabled=1`, `&target=missing`, `&lang=en&theme=dark`;
check desktop and narrow viewports. Storage and IPC are isolated; image/notice
panes and build actions are fixtures. No model runs or real updates occur.

Open `/tests/browser/self-update.html` for the production self-update status chip
and complete change list with synthetic state. Variants: `?mode=rollback`,
`?mode=unverified`, `?mode=building`, `?mode=queued`, `?width=320`, and
`?lang=en&theme=dark`. Check terminal results remain clickable, all eight change
summaries fit, and expanded hashes wrap without horizontal overflow. Queued
changes have a separate details button; only inspect that button in this fixture.
Storage is document-local; no host polling, native IPC, or real update runs.
This does not verify installed-client recovery or a real update transaction.

Open `/tests/browser/cross-session.html` for the production sidebar with synthetic
cross-session requests. Use `?mode=workspace`, `?width=260`, or
`?lang=en&theme=dark` for variants. Start with no indicators; `received` /
`executing` / `awaiting_permission` show both participants without opening any
panel. Click a row indicator for details, close it with Escape, outside press or
the same trigger, and verify hover actions do not move the communication target.
`completed` / `failed` leave unread indicators until that participant's details
are read. The header counts one request once and opens the full overview on
request. Plain row selection, unrelated rows and worktree rows retain their
normal behavior. Storage, IPC and session selection are document-local mocks;
this does not send real messages or verify native engine delivery.

Active participants also show a tinted background and a truncated direction/peer
caption in place of the time/workspace metadata (the original values remain in
the row tooltip). Hover or keyboard-focus either indicator to emphasize its peer;
leaving, blurring or clearing records removes that emphasis. After completion the
row returns to its ordinary background/metadata and retains only the unread
indicator until reviewed. Check both list modes at 260/320 px and in both themes.

Open `/tests/browser/chat-images.html` for generated assistant attachments,
local Markdown images (including linked images), missing files, blocked remote
sources and user uploads. All pixels and paths are synthetic; IPC and storage
are document-local mocks. At a 320 px viewport, open a thumbnail, zoom/pan, close
with Escape and remount history. Images must stay within the content width,
reappear after remount, and never expose base64 as fallback text. This verifies
frontend rendering only; native Codex event/history parsing has separate Rust
tests, and this fixture does not prove installed-client history restoration.

Open `/tests/browser/image-annotation.html` for the production chat image and
lightbox inside a synthetic annotation target. Open the thumbnail, toggle
「批注图片」, drag boxes at fit and after wheel zoom, fill every note and add to
the draft. The overlay box must stay on the same pixels after zoom/pan, the
page shows the attached original plus `*-annotated.png` (same natural size as
the source) and the appended draft block. `?images=0` simulates an engine
without image input (text only). Composer attachment and draft are local mocks;
this does not verify the native paste/save pipeline. Verified 2026-10-19 with
playwright-cli at 1280×800: overlay and image rects matched exactly at 100% and
182%.

Open `/tests/browser/cursor-auxiliary.html` for the production sidebar with
synthetic ordinary Cursor chats, CCE tasks, delegated tasks and a worktree.
Use `?mode=workspace`, `?width=260`, or `?lang=en&theme=dark` for variants.
The auxiliary group starts collapsed; expand it, select a task, move it to
ordinary sessions through the context menu, then move it back. Remount preserves
document-local display preferences. Search must find collapsed auxiliary tasks,
and neither list mode should duplicate them or hide ordinary Cursor chats.
The fixture mocks storage and native IPC before imports; it does not access
saved conversations, alter real settings, run a model, or verify native migration.

Open `/tests/browser/assistant-notices.html` for the production reminder bell,
same-source inline asides and settings. Use `?scene=overlay` for the desktop
surface, `?scene=settings` for settings alone, `?count=one` for one completion,
and `&lang=en&theme=dark` for language/theme variants. Check 360×680 and 320×680
overlay viewports and 736/1024/320 px main layouts: long Chinese/emoji titles
stay at two lines with their complete title available, completion bodies at
three lines, and expanded content/actions remain reachable by internal scrolling.
Exercise pagination, expand/pin/dismiss/draft, failed opening and feed retry.
All IPC and storage are document-local; exact notice IDs/actions are recorded in
`window.__assistantNoticesFixture.state.calls`. This does not test native focus,
click-through, cross-monitor dragging, persistent SQLite or model requests.

For real native reminder-window checks, use the separate debug-only
`assistant-notices-fixture` binary with `test-harness`; do not start a second
ordinary CCGUI instance. Its page is `assistant-notices-native.html`, and its
desktop overlay uses the production `index.html#/assistant-notices` bootstrap.
The fixture exercises real Service/Store/IPC, window focus acknowledgement and
`insertSideAnswer`, but session selection/history are synthetic. No real model,
Vertex credential probe, engine process or production user history is involved.

From the repository root, first check that port 5175 is free without stopping
another process. In a dedicated terminal, build the two fixture pages and start
their static preview server (no HMR or dependency-optimization reloads):

```powershell
node tests/browser/assistant-notices-native.mjs
```

Use `--serve` to reuse the same built fixture when no frontend source changed.
Do not use a cold development server for this acceptance run: its reloads can
duplicate checkpoint registration and trip the production startup watchdog.

In another terminal at the repository root, build and explicitly launch the
fixture (use the configured target directory if `CARGO_TARGET_DIR` is set):

```powershell
New-Item -ItemType Directory -Force .artifacts/native-notices-fixture
cargo build --manifest-path src-tauri/Cargo.toml --features test-harness --bin assistant-notices-fixture
$fixtureArtifacts = (Resolve-Path .artifacts/native-notices-fixture).Path
& .\src-tauri\target\debug\assistant-notices-fixture.exe --artifacts $fixtureArtifacts
```

The binary requires that existing, absolute artifact directory and verifies the
native fixture HTML at the fixed `http://127.0.0.1:5175` origin before opening
windows. Navigation and both frontend URL settings use that origin; there is no
external or production-dist fallback. `TestHarness::new` creates an owned temporary
root and asserts `app_home == root/.ccgui-next`. The Store, empty Outbox, settings
and overlay position are isolated there; main and overlay have separate WebView
data directories. The observer probe is always false. The enabled observer config
only keeps explicitly seeded synthetic asides alive; it cannot start a model.

Keep source A active and seed source B notifications. Use the large click-through
counter area, then expand/pin/dismiss an aside, open its source, and insert into its
visible draft. Test the next-selection failure and retry, mark only fixture records
read, and destroy/recreate the overlay. The details panel reports native window
position/size/visibility/focus and available monitor bounds/scales. A single-monitor
run cannot establish cross-monitor or mixed-DPI correctness; browser screenshots
cannot establish native click-through or focus. These are acceptance scenarios,
not a claim that native GUI acceptance has passed.

The fixture's End button, main-window close and 15-minute watchdog exit only this
test process. Stop only the frontend server started for this run. Normal exit
writes `native-<pid>.jsonl` and `result-<pid>.json` in the artifact directory, then
reports `exitCode`, `scratchRoot` and `scratchRemoved`; verify the result rather
than assuming OS file locks allowed cleanup. Missing output or
`scratchRemoved:false` is an unresolved cleanup result, not a pass. Any subsequent
cleanup must be limited to the exact owned scratch root recorded for that run;
never stop the production client or remove its data to make fixture cleanup pass.

Open `/tests/browser/usage-status.html?engine=agy&credits=0` for separate
Antigravity zero credits and the always-present Vertex promotional-credit
status/link. Use `&quota=unavailable` to verify the Vertex entry survives native
quota failure. Vertex remains explicitly unconnected; no balance is synthesized.

Open `/tests/browser/sidechat.html` for the real BTW card and Sidechat panel.
Use `?lang=en&theme=dark&state=complete` (also `streaming` or `error`).
Run feedback also has `state=waiting`, `quiet`, `tool`, and `retrying` presets.
`quiet` starts with 45 seconds since the last event; both surfaces show the
shared static indicator, elapsed time and an explicit lack-of-activity note.
Click New activity to clear the note, Remount to retain the original elapsed
time, and Complete to remove run feedback while keeping the answer. The timer
is not a heartbeat and does not prove the model is running. These simulated
states do not diagnose a live process or exercise native approval handling.
At 768 and 320 px, verify wrapped controls, Markdown/emoji, copy and insertion.
Insertion appends to the existing main draft without sending. Storage and IPC
are document-local mocks; this is frontend evidence, not a live CLI fork test.
On desktop, drag the Sidechat left edge in both directions, then use the focused
separator's ArrowLeft/ArrowRight/Home/End controls. Close and Reopen, then Remount:
the width should survive. Switch Conversation width to 560/400 px and back to Full
to verify clamping and restoration without horizontal overflow; the geometry
readout reports measured sizes. Below 768 px, the panel stays stacked/full-width
and the horizontal resize handle is hidden. These checks do not call a model.

Open `/tests/browser/turn-summary.html` for complete, partial, time-only and
context-only turn metadata at 768/480/320 px. Use `?lang=en` for English.
Missing fields stay absent; partial history must not calculate cache ratios or
whole-turn speed. These fixtures make no model request.

Open `/tests/browser/interactive-answer.html` for GPT interactive answers. It
renders `tests/fixtures/interactive-answer/gpt-budget.md`, captured from one
real Codex/GPT generation using synthetic budget inputs, through the production
Markdown and closed component runtime. Adjust inputs, reset, hide/show the
answer, replay streaming, and inspect the rejected-action fallback. Check 360 px,
light/dark themes, keyboard slider input and local state preservation. IPC and
browser storage are document-local mocks; opening the fixture makes no model
request and does not use real conversations or settings. This is frontend
acceptance, separate from installed native-client or Spellcast persistence checks.

Open `/tests/browser/auto-review.html` (`?lang=en` for English) for the real
AutoReviewCard, CodexApprovalCard and PermissionMenu. All IPC, localStorage and
sessionStorage are mocked in document-local memory before production imports;
no model, native application, user configuration or saved history is used.
Review all five states, expand the long Chinese/emoji command, and check wide
and 320 px viewports. Auto-review starts as `permission=auto`. The turn-scoped
permission card shows Allow for this turn / Deny. Fail next makes one mocked
submission fail after 800 ms; it must remain pending with an error and allow a
retry. Double clicking during that delay must add only one IPC call. Reset
restores the pending card; the readout retains call/failure/completion counts.
This fixture verifies browser rendering and the shared frontend submit path,
not native enforcement or actual reviewer/model behavior.

Open `/tests/browser/auto-title.html` for manual QA of the real GeneralSection
auto-naming switch/model selector and RenameSessionDialog. All Tauri IPC and
localStorage are mocked in document-local memory; no real settings, models,
transcripts or native app are used. Switch 中文/English with the top buttons;
`?lang=en` starts in English. The **320 px preview** button (or `?width=320`)
opens an isolated iframe with a real 320 px viewport and its own mock state.
Select Changed title / Keep current title / Timeout failure before opening the
rename dialog. With the five-second delay, click Generate and edit while it
runs: the draft, caret and focus must remain after every late outcome, with no
old success/error note; Generate becomes available again. With no intervening
edit, inspect filled-and-selected / unchanged / error feedback. Confirm alone
increments `renameWrites`; unchanged confirmation and Cancel leave it unchanged.
Open with a manual title, clear and confirm to remove the mock lock. The real
settings rows start off/Sonnet; enable and pick Haiku, then inspect the mock
settings readout and IPC log. This fixture does not verify native persistence
or real model behavior.

Open `/tests/browser/handoff.html` for the production ChatConversation, Composer,
HandoffOverlayCard and handoff/chat stores with a synthetic source session.
Use `?lang=en&theme=dark` for variants; `?width=320` or **320 px 独立预览** opens
an isolated iframe with a real 320 px viewport. Both storage objects and all
Tauri IPC/events are replaced before production imports; no saved conversation,
user settings, native application, Cursor process or model request is used.
Enter `/handoff` in the source composer (or fill it with the fixture button and
then send). Check that model compression starts off with zero summary calls.
Open the shared provider/model menu, choose Claude Code and the fixture relay
channel, then enable compression and check `lastSummary.compressionSelection`
for its engine, providerId, model and effort. `destinationModels` must stay unchanged.
The same menu supports Codex, Pi and Cursor; AGY is explicitly unavailable for
compression. Refresh the catalog without making a summary request. The takeover
button must open only the main chat menu, and sending must close/lock the compression
menu. Switch off to use local/detailed digests;
complete the old mocked request and verify that its result is ignored. Append text
after the continuation marker, switch modes, and finish/fail the pending mocked
summary with the toolbar. Retry through the real card; summary replacement must
preserve the added text. Source retention is the default. Choose archive-on-send,
submit the draft, and inspect the pending send before confirming success/failure:
only successful launch confirmation may complete the handoff and archive the
source; failure should retain the draft/card for retry. View the source, return
to the draft, and restore an archived source with the fixture controls.
The read-only `handoff-state` and `handoff-draft` DOM outputs expose archive state,
pending/call counts, last send arguments and the actual draft. Reload for a fresh
scenario. These are manual browser acceptance steps, not recorded pass results;
they do not verify native persistence, actual compression quality or a model run.

Open `/tests/browser/leader-draft.html` (`?engine=codex` or `?lang=en`) for
the real draft sidebar/menu/composer/store. The retained fixture filename does
not imply a mode: right-click the unsent chat and verify there is no Leader
enable/disable entry or mode badge. Submit the first task normally; the fixture
must record `send_message` and adopt a simulated native SID. Controls exercise delayed
Agent preparation, Stop, failed launch and completion. All IPC is mocked:
no model, history file, real workspace or actual native task authority is touched.

Open `/tests/browser/leader-tree.html` for the real sidebar tree, thread menus
and parent-bound child-task management dialog. `?mode=recent` exercises the
all-session view with the same collapsible tree.
Both storage objects and settings IPC are document-local mocks. Expand a root,
switch list modes to retain its disclosure state, and select the grandchild to
reveal ancestors. Right-click a completed leaf to cancel or confirm its own
deletion; after completing all tasks, right-click the analysis branch to delete
it and its grandchild while preserving the root and siblings. Active branches
must disable deletion. The failure checkbox also covers branch deletion and
must preserve survivors for retry. Successful mock calls are recorded in
`window.__LEADER_FIXTURE_DELETES__`; reload resets all synthetic data.
`?scenario=ttl` includes expired Claude/Codex context samples, a cumulative-only
unknown sample, and a mock occupancy reduction; no real compaction runs.
The fixture includes mixed Claude/Codex branches,
recursive grandchildren, expiry, approval waits, completed results and a
starting branch without a native ID. Select the grandchild to reveal ancestors;
renew and stop through the direct parent. Complete all tasks, then use root
management to archive the whole group; the archive manager shows the preserved
tree and restores or explicitly deletes the group. The checkbox simulates a
group action failure and verifies that records stay available for retry.
This uses mocked native IPC and no real models or transcript deletion.
Add `?long-title=1&width=260` to check truncated titles, branch status and hover
actions without any Leader mode badge. Add `&scenario=reclaimed` for a legacy
parent marker whose children were all reclaimed: no mode badge, child disclosure
or group-only protection should remain. Add `&lang=en` for English.

### Collaboration retirement acceptance matrix

These are required scenarios, not recorded pass results. Native delivery,
permissions, worker recovery and update behavior have **not been manually
accepted** in this change. Browser fixtures use synthetic IPC and cannot prove
those native properties. Keep existing fixture filenames for compatibility; an
old fixture toolbar mentioning a mode is not a production control or evidence.

| Scenario | Required result | Evidence boundary |
|---|---|---|
| Blank or saved chat; desktop and Web | No mode toggle or badge; first main-window submission uses ordinary `send_message`; cancel, failure and late preparation retain unsubmitted text, images and later queued input | Draft/browser and frontend tests; real native first-SID provenance remains a separate check |
| Consult an existing chat | Explicit target authorization remains required; communication indicators and per-participant unread state work; target stays independent, outside the caller's task tree and group deletion scope | `cross-session.html` checks rendering only; real authorized delivery not exercised |
| Create a child from an ordinary trusted parent | Public task tools are exactly `task_spawn`, `task_list`, `task_wait`, `task_send`, `task_renew`, `task_stop`; a created branch appears once under its real parent even with no legacy leader marker | Tree fixture covers presentation; real creation and identity binding require native testing |
| Legacy marker, completed child and archive restore | Empty legacy roles do not protect ordinary sessions; retained branches and archived members do; completed results survive; restoring a group restores the same relationships | Frontend relationship tests and synthetic tree fixture; persistence/restart requires native testing |
| Stop and delete | Stopping one branch does not stop descendants or delete history; model tools cannot permanently delete; user deletion preserves idle checks, confirmation, siblings and partial-failure survivors | Synthetic UI validates controls only; native process and filesystem effects not exercised |
| Settings → Collaboration | All four engines expose model policy; missing/null means unrestricted, `[]` prevents new children, nonempty IDs match exactly; defaults and effort fall back correctly; existing chats and children are unchanged | Settings/unit coverage; installed CLI/model availability is separate |
| Worker lifecycle | Registration freezes parent identity/permission; full Interrupt revokes task authority immediately; only registered tokens restore from checkpoints | Native tests/manual run required; no browser assertion establishes this |
| Restart and application update | Active desktop-owned children block update activation; uncertain restarted branches become `unknown` without replay | Native tests/manual run required; not established by a browser reload |
| Retired protocol rejection | Public IPC uses `task_snapshot`, `task_branch_action`, `task_group_action`, `task_delete_branch`, with `task://changed` events; capability is `taskTools`; old `leader_*` names and `leaderMode` fallback are absent, old calls reject without forwarding, unavailable capability stays fail-closed | `scripts/test-host-chat-tool-modes.mjs` checks MCP discovery and rejection against a mock endpoint only; real IPC/relay enforcement is separate |

Only run the tool-discovery script with an absolute path to a trusted executable
freshly built from the changed source. Do not use an installed older binary as
acceptance evidence. `node --check scripts/test-host-chat-tool-modes.mjs` checks
syntax without launching a binary; it does not exercise any native capability.

Open `/tests/browser/quota-status.html` (add `?lang=en` for English) for the real
composer status bar and Claude quota trigger at 768, 480 and 320 px. Synthetic
reset times remain visible beside the percentages without opening details. The
fixture reports PASS only when neither date overflows and both precede usage at
the wide size. Narrow footers wrap, preserving the proxy/context controls.
This uses mocked IPC and no native app, model or quota request.

Open `/tests/browser/usage-status.html` (`?lang=en` for English) for the Codex
weekly-only subscription display and whole-turn throughput.
The real status components and hooks use document-local IPC and storage fixtures.
The fixture starts with turn 50, session A 10 and global 30 tokens/s; switch to
session B for 40 tokens/s. Open both details, expand the initially collapsed
historical throughput, and check valid samples / recorded turns. Exercise statistics
failure/recovery and verify 768/480/320 px wrapping. No real account, model, configuration,
or saved history is accessed. The layout readout is meaningful only after running
the page in a real browser; DOM unit tests alone do not verify browser geometry.

Open `/tests/browser/relay-plugin.html` for the installable Relay plugin's actual
React UI with a fake Agent transport. The plugin source is a sibling checkout at
`../ccgui-plugin/ccgui-plugin-plan-execute-relay` (dev server allows sibling
plugin repos per `vite.config.ts`); without that checkout the page cannot load.
Configure the two nodes, send two planning turns, verify that neither reply
starts execution, then approve the latest plan.
An unsent draft must disable approval. The visible request counter distinguishes
planning and execution. Test editing/version selection, stopping, and returning
to regular chat. No real model, credentials, CLI or workspace files are used.
This is not evidence of native read-only enforcement or live-model correctness.

Open `/tests/browser/process-disclosure-bounded.html` for large process groups.
The production disclosure renders 120 or 500 synthetic tools with at most 40
items per page. Previous/next/latest preserve access to every item; append while
reading an earlier page must not switch it. Arguments and results remain lazy.
This is a DOM-bound check, not a native CPU benchmark.

Open `/tests/browser/performance-diagnostics.html` for the real diagnostic dialog
with synthetic native data and the real renderer monitor. The selectable JSON
summary must be bounded to 12,000 UTF-8 bytes; full export keeps all samples in a
separate JSON file. Check the five-minute/60-sample explanation and default-on
toggle: disabling clears the preview, enabling starts a new recording window.
Clipboard refusal retains the summary for manual copy; save cancellation must
not show success. This fixture mocks preference persistence and native samples,
so it does not verify production CPU, restart persistence or cross-window IPC.

With the Vite development server running, open
`http://localhost:1420/tests/browser/stream-throttle.html`.
The page reports `PASS` after exercising actual React StrictMode commits:
completion, replacement, truncation, pending-timer cleanup, continuous Unicode
appends, coalescing and unmount. It needs no model, account or saved conversation.
The visible update count depends on browser scheduling; it is not a model-speed
or frame-rate benchmark.

Run the deterministic timing, grapheme, Markdown and store regressions with:

```sh
node --experimental-strip-types --test tests/*.test.ts
```

The presentation cursor still reveals text per frame. Markdown parses are
budgeted separately: 32ms up to 4,000 UTF-16 units, 64ms up to 16,000, and 128ms
above that. Completion bypasses the budget. These limits trade parser work
against arrival latency; they do not guarantee a frame-time bound for very
large Markdown documents. A live row that overran the budget extends its own
interval (up to 160ms) so a 200 tok/s stream cannot starve the reveal frames.

Open `/tests/browser/thinking-reveal.html` to check the live thinking panel at
provider speed: the real `ThinkingSurface` replays a 200 tok/s stream (100
characters every 144ms) and samples the rendered body once per animation
frame. The burst must be spread across frames — `largestSingleFrameStep` stays
small and `framesJumpingAtLeast 30 chars` must be 0 after the first paint —
and the page reports `PASS`. Before this fixture's behavior was fixed the
panel rendered each burst in one commit, which read as flashing text. No
model, no IPC, no saved conversation.

Open `/tests/browser/effort-layout.html` to verify the actual model menu keeps
its trigger width and popover position while cycling the engine's reasoning levels.
The fixture waits for fonts and the entrance animation before measuring; it
uses local React state and never changes app settings or sends a model request.
Add `?engine=claude&manual=1` (and `&lang=en` for English) for the actual Claude
five named effort choices and independent Ultracode switch. Resize to 320 px for the
mobile second-level modal, then open the trigger and select Claude Code. Check
that the description wraps, the switch remains clickable, and enabling it leaves
the selected effort and the adjacent mock send control intact. The visible
readout records effort and switch changes separately. Storage and every Tauri
IPC call are mocked before imports; no native config, model, or Tauri app is used.

Use `?engine=agy&manual=1` to check grouped model variants: choosing a level
changes the complete model ID and the composer summary, without changing the
independent effort value. The custom model retains separate effort controls.
Use `?engine=codex&manual=1&lang=en` to check all six named choices and Fast mode.

Open `/tests/browser/usage-pane.html` to check the usage page against a seeded
ledger: the same model recorded once as a relay-qualified slug
("agentrouter qunyou/deepseek-v4-flash") and once as the engine's plain id must
fold into a single row — in 详细数据 and in the chart's hover breakdown — with
the totals summed. A cache-bearing turn is seeded too, so the summary row must
read 累计 = 输入 + 输出 (输入 being the whole prompt side: fresh + cache). It
also replays a live report (`usage://changed`) to show the page growing
mid-turn. No app, no database, no saved state.
Open `/tests/browser/plan-review.html` for the plan preview & approval UI:
timeline cards in every lifecycle state (draft / awaiting / superseded /
approved / expired) with accessible status text, the approval dock over the
composer (three actions, exec-permission readout, no approve focus by
default), and a long Markdown plan (Chinese, emoji, GFM table, code fences,
超长文) both inline and in the full-preview side panel (Esc/backdrop close
sends nothing). The store is seeded statically; no model, no backend, no
saved conversation.

Open `/tests/browser/split-layout.html` to check the conversation split view
(Trellis-style tiling) against real layout: the real `SplitLayout`,
`SplitDragProvider` and `ChatConversation` render one column first; dragging a
sidebar session onto the right edge must create a second pane at the half-width
divider (with its header and one divider, layout persisted in localStorage),
「向下分屏」 must add an empty pane with the drag/new-chat hint, closing it must
return to two panes, dragging a pane header onto another pane's center must swap
their sessions, dragging a session tab from the real tab strip down into the
conversation area must split there too (a horizontal drag inside the strip still
reorders), dragging the divider must follow the pointer ratio and clamp at
the 220px minimum pane, and closing down to one pane must return to the solo
column and clear the stored layout. The chat store's `focusTab` and the git
store's IPC actions are stubbed; no app, no backend, no model.

Open `/tests/browser/collapsible-message.html` to check the long-message
collapse: a user message taller than 480px clamps to 320px behind a bottom
fade into the bubble fill with a centered chevron, the chevron toggles
expand/collapse, and a short message is never clamped. No model or session.

Open `/tests/browser/changelog-dialog.html` to check the version-history
dialog layout (Settings → About → 版本记录): the release-notes body must
scroll (ModalShell's inner Dialog passes the flex height through), the footer
pager stays inside the modal, the header carries the Star button instead of
the old banner strip, and paging reaches the oldest entry. No app or backend.

Open `/tests/browser/file-search-overlay.html` to check the file panel's
workspace search (tree right-click → 搜索文件) inside the panel's own 280px
column: the scope buttons stand in for the right-clicked folder, and the store
readout below the panel shows what the overlay asked the store to do. Typing
`store` under scope **src** must list `src/features/files/store.ts`; typing
`sibling` under scope **src** must show 无匹配文件 while the same query under
**工作区根** finds `src-extra/sibling.ts` — a folder scope may not sweep in a
sibling whose name shares its prefix. Arrow keys move the highlighted row,
Enter opens the file (the readout then shows it under `openFiles` and
`read_file` in `invoked`), Escape closes the overlay. The index and the file
read come from a stubbed `list_file_index` / `read_file`; no app, no database.

Open `/tests/browser/retry-progress.html` to check the tail indicator's
provider-retry chip. The buttons cycle no-retry, claude `api_retry 3/10`,
codex `Reconnecting 1/5` and an omp retry with no reported ceiling: the chip
must read `重试中 x/y` (or `重试中 x` when the CLI reports no max) in the
warning tone at the end of the meta row, carry the provider's own reason as
its tooltip, and be absent entirely when nothing is being retried. No model,
no IPC, no saved conversation.

Open `/tests/browser/touch-scroll-follow.html` in a **touch-emulated** viewport
(390x844) to check the timeline's tail-follow intent on a phone, where the
web-remote UI runs. Swipe up into history and the fixture's refs must read
`following: false`; growing the list (the `grow` button stands in for streaming
and tool rows) must then leave the viewport where the reader left it, not pull
it back to the tail. Swiping back down to the bottom resumes following, and the
next growth pins to the tail again. Both hooks under test (`useScrollFollow`,
`useTailPin`) are the production ones; the rows are static, so no model, no IPC
and no saved conversation. Note the refs are not reactive — read them through
the `window.__live()` probe, not the rendered readout.

Open `/tests/browser/workspace-drag.html` to check the sidebar workspace
drag with synthetic pointer gestures against the real AiChatSidebar:
dropping a row onto another group's container reports
`onDropWorkspaceToSection` with the group id, dropping onto 已归档 reports
the archived sentinel, dropping onto the ungrouped block reports null, a
single-member section still has a working grip, empty groups mount only
mid-drag and accept a drop there, and a plain in-section drag still commits
`onReorderWorkspaces` without also firing a section drop. Static props, no
app, no backend.

Open `/tests/browser/sidebar-collapse.html` to check the sidebar's worktree
disclosures frame by frame: collapsing the「WORKTREES · n」group, re-expanding
it and expanding one worktree child row must each pass through intermediate
region heights (a real grid-template-rows transition) instead of jumping
between two values, and the rows must still be in the DOM while the region
clips shut. The fixture drives the real AiChatSidebar and reports PASS with
the sampled start/end heights and intermediate frame count; a broken version
reads `0 intermediate frames`. Static props, no app, no backend.

Open `/tests/browser/agent-prompt-menus.html` to check the composer's `#`
agent picker and `!` prompt picker against seeded stores: the agent menu
groups 我的智能体 then one section per enabled built-in division (flat when
filtering), and the prompt menu rows carry 工作区/全局 scope badges; both
end in a fixed "new" row that jumps to Settings. No app, no backend.

Open `/tests/browser/delete-confirm-popover.html` to check the session-delete
confirmation: right-clicking the thread row and picking 删除 must open a
pointer-anchored popover (not the centered modal) next to the click point
with 确认 focused; Escape and outside press cancel without deleting, 确认
fires the store's deleteSession once. Real AiChatSidebar, ThreadContextMenu
and ChatPageDialogs; only deleteSession is stubbed. No app, no backend.

Open `/tests/browser/side-panel-overlay.html` to check the right-hand file
panel on a narrow remote viewport, where it used to spill past the screen and
only render half-visible. The real ChatSidePanel renders in overlay mode
inside a 412px row (a stub panel tab stands in for files/changes, so no IPC):
its right edge must sit on the row's right edge with its left edge inside the
row, and the document must not scroll horizontally. No app, no backend.

Open `/tests/browser/cli-channel-dropdown.html` to check the composer's
provider picker with a dozen relays. The flyout must show the current channel
as one dropdown row — no provider names in the DOM until it is opened — and
the opened list must be height-capped (clientHeight ≤ 200 with a taller
scrollHeight). The header's channel filter must narrow that list to the
matching rows while holding it open, and a pick must clear the filter and
close the list. With Claude first and Codex active, a focused channel pick
must leave the Codex panel mounted and return focus to its channel trigger.
The fixture drives the real CliMenu with controlled selection state and reports
PASS/FAIL with measured heights and focus. No app, no backend.

Open `/tests/browser/branch-picker.html` to check the changes-panel branch
dropdown: filtering to `1.0.6` and clicking the `v1.0.6` row must run the
store's checkout for `v1.0.6` while the panel displays
`fix/git-changes-preview-layout` as current. Regression for the stale
`isCurrent` no-op: the cached branch list used to decide "current" from a
snapshot that lagged behind external (CLI) checkouts, silently swallowing
the click. Real ChangesPanelHeader; only the store's checkout is stubbed.
No app, no backend.

Open `/tests/browser/thinking-layout.html` to verify full live thinking text.
Click `Replay thinking` to grow from 2,100 to 8,100 characters, alternating
long wrapped paragraphs and short code-like lines. The production thinking
surface must retain `[row-000]`, never shrink from dropping earlier lines,
and eventually display the exact received text. The result reports PASS,
`prefixRetained: true`, `maxShrink: 0` and `complete: true`. Ordinary upward
movement from newly appended lines is reported separately, not treated as
proof of flicker. The existing manual fold and end-of-thinking fold setting
are unaffected by removing the live 2,000-character window.

Open `/tests/browser/tail-pin.html` for high-rate streaming scroll regression.
Click `Replay 100 chars / 144ms`: the production Markdown renderer, virtualizer,
and follow hooks receive 100-character bursts every 144ms (a synthetic burst
profile, not a measured model token rate), including Chinese, emoji, bold,
inline code and a late tool-sized row. The output must report PASS, zero tail
gaps at resize delivery, and `complete: true` after settling. Scroll upward
during replay to pause follow; `Resume follow` must return to the tail.
This checks browser layout/reveal synchronization, not native IPC latency.
Reload after changing hook implementations to avoid Fast Refresh artifacts.

Open `/tests/browser/git-performance.html` for the Git panel performance
regression. It mounts the production `ChatSidePanel` with 10,001 synthetic
changed files and mocked Git actions. Initial Files view must show zero Git
fetches and zero mounted file rows. Show changes, scroll through the list,
and verify only the visible window plus overscan is mounted. Opening a file
or staging it updates `lastAction` without touching a repository. Write a
commit draft, switch to Files or collapse the sidebar, then return: the draft
must survive, hidden rows must be removed, and the list must still scroll to
the final file. The metrics output reports requests, mounted rows and actions.

Open `/tests/browser/markdown-preview.html` to check the files-feature Markdown
preview (Streamdown) against a document covering GFM tables, heading levels,
lists, task list, blockquote, fenced code, KaTeX math and a Mermaid diagram:
tables render with a bordered wrapper and styled header row, code blocks carry
language header + copy/download controls with `files.markdown.*` labels, the
block formula renders via KaTeX, and the Mermaid diagram stays an empty
container until scrolled into view (IntersectionObserver lazy render), then
draws the flow SVG. No app, no backend, no saved state.

Open `/tests/browser/plugin-detail-rail.html` to check the plugin detail page
at a desktop width (1145x731 in the verification run, with the app's 40px tab
strip and 28px status bar around the real `PluginDetailPage`): a README fence
whose single PowerShell line is 922px wide inside a 728px column must scroll
horizontally inside that column, and the expanded 22-permission rail must end
inside the viewport with its own scrollbar, so `aside.scrollTop` reaches the
链接 rows while the page stays put. Both were reported broken: the code line
painted ~190px across the rail, and the pinned 1042px rail could only be read
by scrolling the README to its end. The readout reports PASS plus the measured
boxes, `clientHeight`/`scrollHeight` and the page's scrollTop. No app shell,
no backend, no saved state.
