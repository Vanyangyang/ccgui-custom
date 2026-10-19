<div align="center">

# CC GUI (Custom Distribution)

<img width="120" alt="ccgui icon" src="./public/app-icon.png" />

**English** · [简体中文](./README.zh-CN.md)

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-c4f042?labelColor=black&style=flat-square)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)

</div>

---

## Upstream Repository & Acknowledgments

- **Upstream Open-Source Repository**: [**zhukunpenglinyutong/desktop-cc-gui**](https://github.com/zhukunpenglinyutong/desktop-cc-gui)
- **Official Upstream Releases**: <https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases>

### About the Original CC GUI

**CC GUI (`desktop-cc-gui`)** is an open-source **multi-engine AI coding desktop client** created and maintained by [**@zhukunpenglinyutong (Kunpeng Zhu)**](https://github.com/zhukunpenglinyutong), built with **Tauri 2 + React 18 + TypeScript + Rust**.

Through dedicated native protocol adapters in Rust, it unifies command-line AI coding runtimes — including **Claude Code**, **Codex CLI**, **Kimi CLI**, **Grok CLI**, **Pi CLI**, **OMP CLI**, **DeepSeek Harness (DSH)**, **Antigravity**, **OpenCode**, and **Qoder** — into a single graphical interface with real-time streaming, collapsible thinking traces, Git Diff/Bash tool viewers, session history recovery, provider channel management, a virtualized file tree, CodeMirror editor, integrated PTY terminal, Git panel, LAN Web access, and an extensible plugin system (`@ccgui/plugin-sdk`).

> Special thanks to the original author [**@zhukunpenglinyutong (Kunpeng Zhu)**](https://github.com/zhukunpenglinyutong) and all upstream contributors! For official installers and the full upstream feature guide, please visit the **[upstream repository](https://github.com/zhukunpenglinyutong/desktop-cc-gui)**.

---

## What Changed in This Custom Distribution

This repository is a customized distribution (`custom/protected`) based on upstream `v1.1.0` / `v1.1.1`. It focuses on multi-agent orchestration, task continuity across live updates, quota observability, and stricter privacy boundaries.

> [!IMPORTANT]
> **Verified CLI Channel Compatibility Scope**
> This custom distribution currently checks and verifies compatibility **only for the following 4 CLI channels**:
> - **Claude Code**
> - **Codex CLI**
> - **Antigravity CLI (AGY)**
> - **Cursor CLI**
>
> Other upstream CLI channels (such as Kimi CLI, Grok CLI, Pi CLI, OMP CLI, DeepSeek Harness, OpenCode, Qoder, etc.) have **not been verified** in this custom build.

### 1. Added & Enhanced

1. **Deep Runtime Integrations for the 4 Verified Engines (Claude Code / Codex CLI / Antigravity CLI / Cursor CLI)**
   - **Cursor CLI Engine**: Added native Cursor CLI adapter with session history discovery, model selection, and effort controls.
   - **Antigravity (AGY) & Vertex Channel**: Added live CLI model/effort synchronization, host workspace staging, and isolated Vertex billing routing (preventing cross-billing session mix-ups or silent subscription fallback).
   - **Codex Desktop Thread Handoff**: Automatically delegates turns to Codex Desktop over its local named pipe when a thread already has an active Desktop writer, streaming progress back to CC GUI.
   - **Claude Code Native Interrupts & Background Coexistence**: Chat while background subagents run; `Stop` interrupts only the active reply without killing background tasks. Silenced Windows console flashes during Haiku assist probes.

2. **Cross-Engine Subtask Orchestration & Session Messaging (`ccgui` Host MCP)**
   - Built-in `ccgui` MCP server providing `task_spawn`, `task_list`, `task_wait`, `task_send`, `task_renew`, and `task_stop` to orchestrate parent/child tasks across Claude, Codex, AGY, and Cursor, with per-engine allowed-model policies and TTL management.
   - Cross-session messaging via `list_chats`, `send_message`, and `get_message_status`.

3. **Lightweight Sidechat (`/btw` & `/sidechat`), Image Annotation & Interactive Answers (Intelligence UI)**
   - Ask temporary `/btw` questions or hold continuous `/sidechat` conversations (with **live Read-only / Execute permission mode toggle**, image paste/attachments, copy, insert-to-draft, and promote-to-chat) while the main task continues running.
   - **Image Preview Annotation**: Click any image in a message or composer draft to open the lightbox, draw up to 9 numbered red boxes (`#1`–`#9`) with revision notes, and click "Add to draft" to attach both the image and normalized coordinates.
   - Structured interactive answer cards (Intelligence UI) with per-session/code-block parameter persistence and one-click draft insertion.

4. **Native Assistant Notices & Independent Progress Observer**
   - Native desktop completion notification overlay, top-bar bell history, exact session focus jump, and Windows offline voice notifications.
   - Optional independent progress observer generating concise side-notes via isolated tool-free calls (Vertex, Claude, Codex, or Pi).

5. **Multi-Engine Quota Status, TPS Telemetry & Context Controls**
   - Persistent status bar indicators showing **remaining 5-hour and 7-day quota percentages** and local reset times for Claude, Codex, Antigravity, and Cursor.
   - Dedicated token throughput (TPS) tracking, prompt cache heat indicators, and per-turn completion summaries (elapsed time, tokens, cache, reasoning, tool count, average speed).
   - Configurable auto-compaction context window thresholds for Claude (750K default) and Codex, plus isolated automatic session titling.

6. **Independent Task Workers & Zero-Downtime Live Self-Update**
   - **Detached Task Workers Survive GUI Restarts**: Ordinary local Claude and Codex runs execute in detached `task-worker` processes backed by durable `events.jsonl` logs and idempotent command receipts. Even when the GUI restarts or hot-swaps, active AI tasks keep running and seamlessly resume streaming from their exact event cursors without dropping or duplicating messages.
   - **Zero Disruption to Normal CC GUI Usage During Self-Update**: Built-in `ccgui-self-update` coordinator and `self-update-build.mjs` ensure a smooth, non-intrusive update workflow from build to activation:
     - **Isolated Background Snapshot Builds**: Triggering an update captures an isolated source snapshot and compiles incrementally in the background (frontend-only changes reuse the native binary in seconds). You can keep chatting, switching sessions, or editing code while it builds.
     - **Full UI & Draft State Preservation**: Before switching, CC GUI checkpoints UI state and worker cursors — preserving your active sessions, layout, attached images, and even half-typed composer drafts.
     - **Safe-Boundary Waiting & Automatic Rollback**: If an in-host turn, active PTY terminal, or unsaved editor buffer is busy, the coordinator finishes building in the background and waits for a safe boundary rather than force-killing your work. If the new candidate fails or times out its health check, the supervisor automatically rolls back to the previous version.
   - **Auto-Generated Self-Dev Workspace (`ccgui-custom [Self-Dev]`) & One-Click "Build & Live Update"**: Automatically registers your local `git clone` repository on first launch after building, with a dedicated purple `[Self-Dev]` sidebar badge, explicit removal consent guard, and a one-click **"Build & Live Update"** button in `Settings → Workspaces` and `Settings → Check for Updates → Update while running` to build and hot-swap directly from your working tree after AI edits or `git pull`.

7. **Proxy Tunneling & Tri-State Adaptive Launch Protection**
   - **Strict Proxy Tunneling**: Outbound WebSocket relay tunnels strictly through the configured HTTP CONNECT proxy and refuses direct fallback when the proxy is unavailable, preventing accidental traffic leaks.
   - **Adaptive Single-Instance & Pre-Launch Guard**: Windows release builds and self-update directories (`~/.ccgui-next/runtime-updates/releases/<hash>`) include single-instance mutex fencing and optional pre-launch proxy/firewall verification — off by default on fresh installs so the app works out-of-the-box, while automatically preserving protection across live self-updates when a local proxy guard is active.

---

### 2. Removed & Disabled

1. **Removed Third-Party Analytics & Telemetry**
   - Removed Baidu Tongji analytics modules (`src/lib/analytics.ts`, `src-tauri/src/baidu_tongji.rs`) and related IPC commands.
   - Locked down the packaged CSP to local and bundled sources only (guarded by `tests/privacy-boundary.test.ts`), and disabled automatic HTTP redirect following for plugin network requests.

2. **Disabled Upstream Online Auto-Updater**
   - Enabled `IS_CUSTOM_DISTRIBUTION = true` and disabled `createUpdaterArtifacts` as well as upstream GitHub Release update checks, preventing generic upstream installers from overwriting the custom build. Updates are handled exclusively via the local `runtime-updates` pipeline.

3. **Retired External Spellcast Workbench & Legacy Bridge Plugin**
   - Removed the external Spellcast workbench UI, connection toggles, and legacy IPC/Web routes; permanently disabled the legacy `spellcast-canvas-bridge` plugin in favor of CC GUI's native assistant notices and observer.

4. **Removed Redundant Controls & Legacy Tool Aliases**
   - Removed the quick proxy toggle button from the chat composer footer (proxy settings are managed centrally in Settings).
   - Removed legacy `leader_*` public MCP tool aliases in favor of the unified `task_*` toolset.

---

## Installing from GitHub & Self-Dev Live Update (`ccgui-custom`)

### 1. Clone & Build from GitHub
Prerequisites: **Node.js 24 LTS** (tested; minimum **22.13**), the pinned **pnpm 11.19.0**, **Git**, and **Rust stable 1.95+** (1.99 tested). On Windows, install the MSVC C++ build tools, Windows SDK, and WebView2 as described in the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (**Perl is not required**). Other platforms need their respective Tauri system dependencies; macOS/Linux installer builds are not verified by this Windows workflow.

```bash
# 1. Clone the repository (recommended folder name: ccgui-custom)
git clone https://github.com/Vanyangyang/ccgui-custom.git ccgui-custom
cd ccgui-custom

# 2. Install the pinned package manager and workspace dependencies
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile

# 3. Verify, then build the Windows production installer from the same clean checkout
pnpm maint:check
pnpm maint:build
# Run the generated NSIS installer under src-tauri/target/release/bundle/nsis/
```

**Build & Distribution Notes:**
- **Verification & Packaging Consistency**: Keep the checkout clean and at the same Git commit between `maint:check` and `maint:build`. If a check fails, fix the cause and rerun `maint:check` (`maint:build` requires a matching check record for the current commit).
- **Path Character Constraints**: Windows release path sanitization supports spaces and Unicode, but the checkout, user home, and Cargo home paths **must not contain `=`** (MSVC only partially trims paths containing `=`, so packaging rejects them before compilation).
- **Safe Installer Sharing**: The installed production app bundles its frontend assets and does not require a running dev server. Packaging verifies local source hints and embedded build paths; share only the generated NSIS installer, not local build reports, logs, or your user data directory.
- **On-Demand CLI Configuration**: Building and launching the app do not require installing optional AI CLIs up front — configure an engine whenever you are ready to use it. Build scripts inherit your process environment and Git proxy settings without requiring a fixed local proxy port or reading Claude configs (`maint:integrate` and `maint:install` are internal maintainer workflows and are not needed for standard installation).

For optional development debugging after installing dependencies:

```bash
pnpm dev
```

### 2. Is the `ccgui-custom` Self-Dev Workspace Auto-Generated? Does It Need Manual Building?
**Your local checkout is registered automatically after the first build, enabling zero-downtime live updates directly from inside CC GUI:**

1. **Auto-Generated on First Launch**: Running `pnpm maint:build` or `pnpm dev` records your local checkout path in `default-source-root.txt` (a machine-local hint stored in user app data outside the repository — never commit or distribute it). First launch under the same OS account automatically populates the `ccgui-custom [Self-Dev]` sidebar workspace and **Settings → Workspaces → CC GUI Self-Dev Workspace**. If you copy the installer to another machine, simply select that machine's checkout directory in Settings.
2. **AI-Assisted Live Update**: Start a chat in the `ccgui-custom` workspace and ask AI to customize CC GUI. Once verified, the AI registers the change as ready (`coordinate_self_update(ready)`), and you simply reply **"Update"** to trigger an incremental background build and hot-swap.
3. **One-Click "Build & Live Update" after `git pull` or Manual Edits**: After pulling updates from GitHub (`git pull`) or editing source files yourself, click **"Build & Live Update"** in **Settings → Workspaces → CC GUI Self-Dev Workspace** (or **Settings → Check for Updates → Update while running**) to build and hot-swap without opening a terminal.
4. **Zero Interruption During Updates**: Background builds run against an isolated source snapshot, so you can continue chatting, sending images, or editing code while compilation runs. If an in-host turn or terminal session is active, CC GUI waits for a safe boundary before switching — keeping running `task-worker` sessions, open chats, and in-progress composer drafts completely intact.

---

## Development & Maintenance Commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Start Tauri in development mode |
| `pnpm build` | Run TypeScript typecheck and Vite frontend build |
| `pnpm test` | Run Vitest test suite |
| `pnpm maint:check` | Run full custom verification suite (privacy boundary, types, Vitest, native Rust tests) |
| `pnpm maint:build` | Build the `+protected.N` Windows NSIS installer and verification report |
| `pnpm maint:self-update` | Build a local live-update candidate package |

For detailed architecture and maintenance specifications (in Chinese), see:
- [Custom Maintenance Guide](./docs/custom-maintenance.zh-CN.md)
- [Runtime Live Update Specification](./docs/runtime-live-update.zh-CN.md)
- [Assistant Notices & Progress Observer](./docs/assistant-notices.zh-CN.md)
- [UI/UX Specification](./docs/ui-ux-spec.zh-CN.md)

---

## License

Distributed under the [MIT License](./LICENSE), retaining the original copyright notices of `Thomas Ricouard` and `zhukunpenglinyutong (Kunpeng Zhu)`.
