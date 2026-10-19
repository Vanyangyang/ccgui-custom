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
   - Ordinary local Claude and Codex runs execute in detached `task-worker` processes backed by durable `events.jsonl` logs and idempotent command receipts, surviving GUI restarts.
   - Built-in `ccgui-self-update` coordinator and `self-update-build.mjs`: supports isolated source-snapshot incremental builds, externalized frontend asset bundles, UI/cursor checkpointing, supervisor-managed live host switching, and automatic rollback on health timeout.
   - **Auto-Generated Self-Dev Workspace (`ccgui-custom [Self-Dev]`) & One-Click "Build & Live Update"**: Automatically registers your local `git clone` repository on first launch after building, with a dedicated purple `[Self-Dev]` sidebar badge, explicit removal consent guard, and a one-click **"Build & Live Update"** button in `Settings → Workspaces` and `Settings → Check for Updates → Update while running` to build and hot-swap directly from your working tree after AI edits or `git pull`.

7. **Proxy Tunneling & Tri-State Adaptive Launch Protection**
   - Outbound WebSocket relay tunnels strictly through the configured HTTP CONNECT proxy and refuses direct fallback when the proxy is unavailable.
   - Windows single-instance mutex fencing and optional pre-launch proxy/firewall verification: off by default on fresh installs so the app launches out-of-the-box, while automatically preserving protection on live self-updates when a local proxy is active.

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
Prerequisites: **Node.js 20+**, **pnpm 9+**, **Rust (stable)**, and platform Tauri 2 / WebView2 build dependencies.

```bash
# 1. Clone the repository (recommended folder name: ccgui-custom)
git clone https://github.com/Vanyangyang/ccgui-custom.git ccgui-custom
cd ccgui-custom

# 2. Install workspace dependencies
pnpm install

# 3. Option A: Build the desktop installer (recommended for daily use)
pnpm maint:build
# Run the generated NSIS installer under src-tauri/target/release/bundle/nsis/

# 3. Option B: Run directly in development mode
pnpm dev
```

### 2. Is the `ccgui-custom` Self-Dev Workspace Auto-Generated? Does It Need Manual Building?
**It is automatically generated after building from `git clone`, and no manual terminal build is needed during daily use:**
1. **Auto-Generated on First Launch**: Running `pnpm maint:build` or `pnpm dev` automatically records your local Git checkout path; when CC GUI opens, both the sidebar (`ccgui-custom [Self-Dev]`) and **Settings → Workspaces → CC GUI Self-Dev Workspace** are automatically populated without manual folder selection.
2. **AI-Assisted Live Update**: Ask AI in a `ccgui-custom` chat to customize CC GUI. Once verified, the AI registers the change as ready (`coordinate_self_update(ready)`), and you simply say **"Update"** to build and hot-swap in the background.
3. **One-Click "Build & Live Update" after `git pull` or Manual Edits**: After pulling updates from GitHub (`git pull`) or editing source files yourself, click **"Build & Live Update"** in **Settings → Workspaces → CC GUI Self-Dev Workspace** (or **Settings → Check for Updates → Update while running**) to trigger an incremental background build and hot-swap without touching the command line.

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

---

## License

Distributed under the [MIT License](./LICENSE), retaining the original copyright notices of `Thomas Ricouard` and `zhukunpenglinyutong (Kunpeng Zhu)`.
