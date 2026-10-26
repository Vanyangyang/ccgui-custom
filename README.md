<div align="center">

# CC GUI (Custom Distribution)

<img width="120" alt="ccgui icon" src="./public/app-icon.png" />

**English** · [简体中文](./README.zh-CN.md)

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-c4f042?labelColor=black&style=flat-square)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)

</div>

---

## Current source, installers and upgrades

- **Main source (2026-10-26): V3 persistence contract, general plugin SDK 0.3.28.** See the [source synchronization record and scope](./docs/releases/main-2026-10-26.md). The independent game workbench plugin, assets and dedicated acceptance scripts are excluded; shared client and SDK capabilities remain.
- **Original tag `v1.1.1+protected.35`: V2, Windows x64.** Its [release record and checksums](./docs/releases/1.1.1+protected.35.md) describe the original build, not current main. The displayed application version remains `1.1.1+protected.35`; distinguish builds by their source revision, schema probe and installer SHA-256.
- Find published custom installers in [this repository's Releases](https://github.com/Vanyangyang/ccgui-custom/releases), and check the asset's build record. A tag's Source code ZIP/TAR is source, not an installer. The main source synchronization did not publish a new installer.
- **V1/V2 → current V3 requires a complete installer built and verified from the intended source.** Save work, finish tasks, exit every CC GUI instance and related worker/supervisor, then install while retaining the data directory. The original V2 installer cannot perform this upgrade. Do not bypass schema checks, mix incompatible workers or directly downgrade. See [installation and recovery](./docs/custom-maintenance.zh-CN.md#安装与恢复).

## Upstream Repository & Acknowledgments

- **Upstream Open-Source Repository**: [**zhukunpenglinyutong/desktop-cc-gui**](https://github.com/zhukunpenglinyutong/desktop-cc-gui)
- **Official Upstream Releases**: <https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases>

### About the Original CC GUI

**CC GUI (`desktop-cc-gui`)** is an open-source **multi-engine AI coding desktop client** created and maintained by [**@zhukunpenglinyutong (Kunpeng Zhu)**](https://github.com/zhukunpenglinyutong), built with **Tauri 2 + React 18 + TypeScript + Rust**.

Through dedicated native protocol adapters in Rust, it unifies command-line AI coding runtimes — including **Claude Code**, **Codex CLI**, **Kimi CLI**, **Grok CLI**, **Pi CLI**, **OMP CLI**, **DeepSeek Harness (DSH)**, **Antigravity**, **OpenCode**, and **Qoder** — into a single graphical interface with real-time streaming, collapsible thinking traces, Git Diff/Bash tool viewers, session history recovery, provider channel management, a virtualized file tree, CodeMirror editor, integrated PTY terminal, Git panel, LAN Web access, and an extensible plugin system (`@ccgui/plugin-sdk`).

> Special thanks to the original author [**@zhukunpenglinyutong (Kunpeng Zhu)**](https://github.com/zhukunpenglinyutong) and all upstream contributors! For official installers and the full upstream feature guide, please visit the **[upstream repository](https://github.com/zhukunpenglinyutong/desktop-cc-gui)**.

---

## What Changed in This Custom Distribution

This repository maintains a customized distribution based on upstream `v1.1.0` / `v1.1.1`. **Use `main` for the public source described here**; `custom/protected` is the local maintenance branch. The focus is multi-agent orchestration, compatible-update task continuity, quota observability, shared plugin capabilities and stricter privacy boundaries.

> [!IMPORTANT]
> **Verified CLI Channel Compatibility Scope**
> This custom distribution currently checks and verifies compatibility **only for the following 4 CLI channels**:
> - **Claude Code**
> - **Codex CLI**
> - **Antigravity CLI (AGY)**
> - **Cursor CLI**
>
> Other upstream CLI channels (such as Kimi CLI, Grok CLI, Pi CLI, OMP CLI, DeepSeek Harness, OpenCode, Qoder, etc.) have **not been verified** in this custom build.
>
> Automated source regressions do not certify every engine/model/billing combination through live-model end-to-end tests. Windows packaging has a build record; macOS/Linux installers are not certified by that record.

### 1. Added & Enhanced

1. **Deep Runtime Integrations for the 4 Verified Engines (Claude Code / Codex CLI / Antigravity CLI / Cursor CLI)**
   - **Cursor CLI Engine**: Added native Cursor CLI adapter with session history discovery, model selection, and effort controls.
   - **Antigravity (AGY) & Vertex Channel**: Added live CLI model/effort synchronization, host workspace staging, and isolated Vertex billing routing (preventing cross-billing session mix-ups or silent subscription fallback).
   - **Codex Desktop Thread Handoff**: Automatically delegates turns to Codex Desktop over its local named pipe when a thread already has an active Desktop writer, streaming progress back to CC GUI.
   - **Claude Code Native Interrupts & Background Coexistence**: Chat while background subagents run; `Stop` interrupts only the active reply without killing background tasks. Silenced Windows console flashes during Haiku assist probes.

2. **Cross-Engine Subtask Orchestration & Session Messaging (`ccgui` Host MCP)**
   - Built-in `ccgui` MCP server providing `task_spawn`, `task_list`, `task_wait`, `task_send`, `task_renew`, and `task_stop` to orchestrate parent/child tasks across Claude, Codex, AGY, and Cursor, with per-engine allowed-model policies and TTL management.
   - Cross-session messaging via `list_chats`, `send_message`, and `get_message_status`.
   - Cross-workspace children retain their real execution directories and native parent authority. Session sidebar assignment organizes saved chats without moving their execution directories; pending cost approval remains a human decision.

3. **Lightweight Sidechat (`/btw` & `/sidechat`), Image Annotation & Interactive Answers (Intelligence UI)**
   - Ask temporary `/btw` questions or hold continuous `/sidechat` conversations (with **live Read-only / Execute permission mode toggle**, image paste/attachments, copy, insert-to-draft, and promote-to-chat) while the main task continues running.
   - **Image Preview Annotation**: Click any image in a message or composer draft to open the lightbox, draw up to 9 numbered red boxes (`#1`–`#9`) with revision notes, and click "Add to draft" to attach both the image and normalized coordinates.
   - Structured interactive answer cards (Intelligence UI) with per-session/code-block parameter persistence and one-click draft insertion.

4. **Native Assistant Notices & Independent Progress Observer**
   - Native desktop completion notification overlay, top-bar bell history, exact session focus jump, and Windows offline voice notifications.
   - Optional independent progress observer generating concise side-notes via isolated tool-free calls (Vertex, Claude, Codex, or Pi).

5. **Multi-Engine Quota Status, TPS Telemetry & Context Controls**
   - Provider-specific quota presentation: Claude/Codex five-hour and weekly windows where reported, AGY model quotas, and Cursor billing-period Auto/other-model usage. Missing values stay unknown; reset times and stale samples retain their actual meaning.
   - Throughput where available, prompt cache heat indicators and per-turn completion summaries (elapsed time, tokens, cache, reasoning, tool count, average speed). Cursor has no TPS estimate. Its five-minute cache window and Codex's permanent-cache display are client policies, not proof of a provider cache hit or retention guarantee.
   - Configurable auto-compaction context window thresholds for Claude (750K default) and Codex, plus isolated automatic session titling.

6. **Independent Task Workers & Compatibility-Gated Live Updates**
   - **Worker-owned task continuity**: Supported ordinary and managed local Claude/Codex/AGY/Cursor runs use independent workers with durable events and idempotent receipts. Compatible host switches restore the same runs and event cursors. Old host-owned tasks, WSL and other unsupported runtime paths do not acquire continuity retroactively.
   - **Isolated background builds**: The coordinator captures a source snapshot. Verified cache reuse can avoid recompiling unchanged native code; build duration depends on the actual inputs and cache state.
   - **Supported checkpoints and safe boundaries**: The UI may briefly reconnect. Supported sessions, drafts, attachments, layout and worker cursors are restored; unsaved editors, active host-owned resources and unsupported plugin views can block switching. Missing or invalid recovery evidence prevents health confirmation.
   - **Compatibility and rollback gates**: Worker protocol, checkpoint and persistence contracts must match. Health failure can roll back within a compatible transaction; V1/V2 → V3 requires the complete cold upgrade above. A button cannot make incompatible data contracts hot-upgradable.
   - **Self-Dev workspace and build entry**: A local checkout can be registered as `ccgui-custom [Self-Dev]`, with **"Build & Live Update"** in workspace/update settings. After edits or `git pull`, the same compatibility checks determine whether live activation is available.

7. **Proxy Tunneling & Tri-State Adaptive Launch Protection**
   - **Strict Proxy Tunneling**: Outbound WebSocket relay tunnels strictly through the configured HTTP CONNECT proxy and refuses direct fallback when the proxy is unavailable, preventing accidental traffic leaks.
   - **Adaptive Single-Instance & Pre-Launch Guard**: Windows release builds and self-update directories (`~/.ccgui-next/runtime-updates/releases/<hash>`) include single-instance mutex fencing and optional pre-launch proxy/firewall verification — off by default on fresh installs so the app works out-of-the-box, while automatically preserving protection across live self-updates when a local proxy guard is active.
   - When protection is enabled, the ordinary executable entry runs the built-in checks too. An existing **CC GUI (proxy protection)** shortcut adds a local script preflight before launching the same executable; that script and firewall setup are machine-local prerequisites, not automatically installed on every fresh machine.

8. **Project Views & General Plugin SDK 0.3.28**
   - Organize registered workspace roots into projects, share file/reference views and retain each session's actual cwd. Removing an organizational relationship does not delete files or transfer execution permissions.
   - Permission-scoped project publication, detached windows, native task coordination, persistent discussion/task conversations and owned image attachments. Fixed instructions use supported native instruction channels; bounded memory extraction works from owned source evidence under `host:memory`.
   - Update-close hooks drain accepted operations and confirm plugin services have exited. Ownership, cancellation, unknown-result non-replay and evidence checks apply across the interfaces. See the [SDK changelog](./packages/plugin-sdk/CHANGELOG.md) and [plugin development guide](./docs/plugin-development-guide.zh-CN.md).

---

### 2. Removed & Disabled

1. **Removed Third-Party Analytics & Telemetry**
   - Removed Baidu Tongji analytics modules (`src/lib/analytics.ts`, `src-tauri/src/baidu_tongji.rs`) and related IPC commands.
   - Locked down the packaged CSP to local and bundled sources only (guarded by `tests/privacy-boundary.test.ts`), and disabled automatic HTTP redirect following for plugin network requests.

2. **Disabled Upstream Online Auto-Updater**
   - Enabled `IS_CUSTOM_DISTRIBUTION = true` and disabled `createUpdaterArtifacts` as well as upstream GitHub Release update checks, preventing generic upstream installers from overwriting the custom build. Use a verified complete custom installer for cold upgrades, or the local update pipeline for compatible changes.

3. **Removed Redundant Composer Proxy Toggle**
   - Removed the quick proxy toggle button from the chat composer footer (proxy settings are managed centrally in Settings).

---

## Building from GitHub & Self-Dev Updates (`ccgui-custom`)

### 1. Clone & Build from GitHub
Prerequisites: **Node.js 24** (24.14 tested; minimum **22.13.0**), the pinned **pnpm 11.19.0**, **Git**, and **Rust stable 1.95+** (1.99 tested). On Windows, install the MSVC C++ build tools, Windows SDK, and WebView2 as described in the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (**Perl is not required**). Other platforms need their respective Tauri system dependencies; macOS/Linux installer builds are not verified by this Windows workflow.

```bash
# 1. Clone the repository (recommended folder name: ccgui-custom)
git clone https://github.com/Vanyangyang/ccgui-custom.git ccgui-custom
cd ccgui-custom

# 2. Install the pinned package manager and workspace dependencies
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile

# 3. Verify main, then build the Windows installer from the same clean checkout
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

### 2. Registering the Self-Dev Workspace and Updating It
**The build records your local checkout for the same OS account. Live activation is available only when the running and candidate contracts are compatible. In particular, do not use live update to cross from the original V2 tag into current V3 main.**

1. **Auto-Generated on First Launch**: Running `pnpm maint:build` or `pnpm dev` records your local checkout path in `default-source-root.txt` (a machine-local hint stored in user app data outside the repository — never commit or distribute it). First launch under the same OS account automatically populates the `ccgui-custom [Self-Dev]` sidebar workspace and **Settings → Workspaces → CC GUI Self-Dev Workspace**. If you copy the installer to another machine, simply select that machine's checkout directory in Settings.
2. **AI-assisted preparation**: A verified source change can register `coordinate_self_update(ready)`. Registration records readiness; it does not request a build or activation. An explicit update request enters the coordinator, which still checks compatibility and switching blockers.
3. **After `git pull` or manual edits**: For compatible changes, use **"Build & Live Update"** in workspace/update settings. An incompatible candidate is rejected; follow the complete installer upgrade procedure instead of bypassing the check.
4. **During a compatible update**: Background builds use an isolated snapshot. Switching waits for safe ownership/checkpoint boundaries and can briefly reconnect the UI. Supported worker runs and drafts are restored; unowned processes or unsupported views can require finishing work first. Only a committed healthy transaction means the update succeeded.

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

Source publication must exclude machine-local paths, credentials, conversation history, runtime databases, logs and build artifacts. A clean scan of current source does not remove information already present in older Git history.

For detailed architecture and maintenance specifications (in Chinese), see:
- [Custom Maintenance Guide](./docs/custom-maintenance.zh-CN.md)
- [Runtime Live Update Specification](./docs/runtime-live-update.zh-CN.md)
- [Assistant Notices & Progress Observer](./docs/assistant-notices.zh-CN.md)
- [UI/UX Specification](./docs/ui-ux-spec.zh-CN.md)

---

## License

Distributed under the [MIT License](./LICENSE), retaining the original copyright notices of `Thomas Ricouard` and `zhukunpenglinyutong (Kunpeng Zhu)`.
