<div align="center">

# CC GUI (Custom Distribution)

<img width="120" alt="ccgui icon" src="./public/app-icon.png" />

**English** · [简体中文](./README.zh-CN.md)

A desktop client for multi-engine AI coding, customized for cross-engine subtask orchestration, task continuity across updates, quota observability, and enhanced privacy boundaries.

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-c4f042?labelColor=black&style=flat-square)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)

</div>

---

## Current Source, Installers & Upgrade Guide

- **Current `main` Source**: Governed by the **V3 persistence contract** and **general plugin SDK 0.3.28** (see the [source synchronization record](./docs/releases/main-2026-10-26.md)). The application display version string remains `1.1.1+protected.35`.
- **Original Tag & Installer Availability**: The build record for the original tag `v1.1.1+protected.35` corresponds to the earlier **V2** architecture (documented in [release record and checksums](./docs/releases/1.1.1+protected.35.md)) and does not reflect current `main`. The `main` source synchronization did not publish a new installer. Check published installers in [GitHub Releases](https://github.com/Vanyangyang/ccgui-custom/releases) against their asset build records; tag Source code ZIP/TAR downloads are raw source files, not packaged installers.
- **Architectural Upgrade (V1/V2 → V3)**:
  - Upgrading to current V3 requires a **full-exit upgrade using the complete installer** built and verified from the intended source.
  - Before upgrading: save pending work, finish active tasks, and completely exit all CC GUI instances along with any running worker or supervisor processes.
  - Run the full installer; user data directories are safely retained.
  - *Note*: Live in-app hot-updates cannot bridge incompatible schema contracts. Bypassing schema compatibility checks, mixing incompatible worker versions, or direct downgrades is not supported. See [Installation and Recovery](./docs/custom-maintenance.zh-CN.md#安装与恢复).

---

## Upstream Project & Acknowledgments

- **Upstream Repository**: [**zhukunpenglinyutong/desktop-cc-gui**](https://github.com/zhukunpenglinyutong/desktop-cc-gui)
- **Official Upstream Releases**: <https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases>

### About CC GUI

**CC GUI (`desktop-cc-gui`)** is an open-source **multi-engine AI coding desktop client** originally created and maintained by [**@zhukunpenglinyutong (Kunpeng Zhu)**](https://github.com/zhukunpenglinyutong), built with **Tauri 2 + React 18 + TypeScript + Rust**.

Through dedicated native protocol adapters in Rust, it unifies diverse command-line AI coding runtimes into a single graphical desktop interface with real-time streaming, collapsible reasoning traces, Git diff and bash tool viewers, session recovery, provider channel management, virtualized file trees, integrated PTY terminal, and an extensible plugin system.

> Special thanks to [**@zhukunpenglinyutong (Kunpeng Zhu)**](https://github.com/zhukunpenglinyutong) and all upstream contributors for their foundational work! For official upstream releases and the full upstream feature guide, please visit the [upstream repository](https://github.com/zhukunpenglinyutong/desktop-cc-gui).

---

## Key Customizations in This Distribution

This distribution maintains a customized build based on upstream `v1.1.0` / `v1.1.1`. Public source is maintained on the **`main`** branch (`custom/protected` serves as the local maintenance branch). Major customizations focus on multi-agent collaboration, task continuity across updates, quota observability, and tightened network and privacy boundaries.

> [!IMPORTANT]
> **Verified CLI Engine Scope**
> Active compatibility checks and continuous regressions in this distribution focus specifically on **4 primary CLI channels**:
> - **Claude Code**
> - **Codex CLI**
> - **Antigravity CLI (AGY)**
> - **Cursor CLI**
>
> Other upstream CLI channels (e.g., Kimi CLI, Grok CLI, Pi CLI, OMP CLI, DeepSeek Harness, OpenCode, Qoder) remain present in source but have **not been verified** in this custom build. Automated source regressions maintain codebase integrity but do not certify every engine, model, and billing tier through live-model end-to-end tests. Windows packaging has an associated build record; macOS/Linux installers are not certified by that record.

### 1. Deep Runtime Integrations for the 4 Verified Engines
- **Cursor CLI Integration**: Native adapter supporting session discovery, model switching, and reasoning effort controls.
- **Antigravity CLI (AGY) & Vertex Channel**: Live CLI model and effort synchronization, host workspace staging, and isolated Vertex billing routing to prevent cross-billing session mixing or silent subscription fallback.
- **Codex Desktop Thread Handoff**: When a thread already has an active Desktop writer, execution automatically delegates to Codex Desktop over its local named pipe, streaming output and progress back into CC GUI.
- **Claude Code Native Subagents & Graceful Interrupts**: Interactive chat continues while background subagents run. The `Stop` action halts only the active reply turn without killing background tasks. Suppressed console flashes during Haiku assist probes on Windows.

### 2. Cross-Engine Subtask Orchestration & Session Messaging (`ccgui` Host MCP)
- **Hierarchical Subtask Orchestration**: Built-in `ccgui` MCP tools (`task_spawn`, `task_list`, `task_wait`, `task_send`, `task_renew`, `task_stop`) manage cross-engine parent/child task trees across Claude, Codex, AGY, and Cursor, with per-engine allowed-model policies and TTL management.
- **Cross-Session Messaging**: Asynchronous inter-chat messaging via `list_chats`, `send_message`, and `get_message_status`.
- **Directory & Authority Preservation**: Cross-workspace children retain their genuine execution directories and native parent authorities. Sidebar project assignment organizes saved chats without relocating working directories; pending cost approvals remain explicit user decisions.

### 3. Lightweight Sidechat, Image Annotation & Interactive Answers (Intelligence UI)
- **Lightweight Sidechat (`/btw` & `/sidechat`)**: Ask temporary `/btw` questions or hold ongoing `/sidechat` dialogues without interrupting main tasks, featuring live Read-Only vs. Execute mode toggles, image attachments, draft insertion, and one-click promotion to a full chat session.
- **Image Lightbox & Region Annotation**: Open message or draft images in a lightbox, draw up to 9 numbered bounding boxes (`#1`–`#9`) with revision notes, and click "Add to draft" to attach both the image and normalized coordinate metadata.
- **Intelligence UI**: Interactive structured answer cards with per-session/code-block parameter state persistence, conflict detection, and one-click draft insertion.

### 4. Native Assistant Notices & Independent Progress Observer
- **Desktop Completion Notifications**: Native desktop completion notification overlay, top-bar bell history, exact session focus jump, and Windows offline voice notifications.
- **Independent Progress Observer**: Optional progress observer generating concise side-notes via isolated, tool-free calls through supported channels such as Vertex, Claude, Codex, or Pi. Channel support does not certify every model through live end-to-end testing.

### 5. Multi-Engine Quota Observability, Telemetry & Context Controls
- **Provider-Specific Quota Presentation**: Displays authentic provider windows where reported (Claude/Codex 5-hour and weekly windows, AGY model quotas, and Cursor billing-period Auto/other-model usage). Missing values stay unknown; reset timestamps and stale samples preserve their actual meaning.
- **Throughput & Cache Telemetry**: Real-time throughput (TPS) where available, prompt cache heat indicators, and per-turn completion summaries (elapsed time, token counts, cache metrics, reasoning volume, tool calls, and average speed).
  > [!NOTE]
  > This client does not display or estimate Cursor TPS metrics. The 5-minute cache window for Cursor and the permanent cache display for Codex are client visualization policies, not proof of provider cache hits or retention guarantees.
- **Context Controls**: Configurable auto-compaction context window thresholds (e.g., Claude 750K default) and isolated automatic session titling.

### 6. Independent Task Workers & Compatibility-Gated Live Updates
- **Worker-Owned Task Execution**: Supported local runs (Claude, Codex, AGY, Cursor) operate through independent background workers with durable event streams and idempotent receipts. Compatible host switches restore supported runs and event cursors. Old host-owned tasks, WSL, and unmanaged runtime paths do not acquire continuity retroactively.
- **Isolated Snapshot Builds**: The coordinator captures an immutable source snapshot and leverages verified cache reuse to avoid recompiling unchanged native code; build duration depends on actual inputs and cache status.
- **Checkpoints & Safe Boundaries**: During a compatible switch, the UI may briefly reconnect. Supported sessions, drafts, attachments, layout, and worker cursors are restored. Unsaved editors or unmanaged resources defer switching until a safe checkpoint is reached.
- **Strict Compatibility Gates & Rollbacks**: Live switching checks worker protocol, checkpoint and persistence-schema compatibility. Failed health checks trigger rollback within the compatible transaction. Incompatible architectural transitions (e.g., V1/V2 to V3) require a full-exit upgrade using the complete installer; hot update cannot bypass incompatible contracts. Live updates cannot promise zero interruption across arbitrary tasks, full recovery of all plugin states, or second-level build times.
- **Self-Dev Workspace**: Register a local checkout as `ccgui-custom [Self-Dev]` to access "Build & Live Update" directly from settings.

### 7. Strict Proxy Tunneling, Launch Protection & Privacy Hardening
- **Strict Proxy Tunneling**: Outbound WebSocket relay tunnels strictly through the configured HTTP CONNECT proxy and refuses direct fallback when the proxy is unavailable, avoiding accidental traffic leaks.
- **Adaptive Single-Instance & Launch Protection**: Release builds feature single-instance mutex fencing and optional pre-launch proxy/firewall validation. Proxy enforcement is off by default on fresh installations; environments with active proxy protection retain that policy across updates.
  > [!NOTE]
  > When protection is enabled, the standard executable entry executes the built-in pre-launch checks as well. An existing "CC GUI (proxy protection)" shortcut adds a local script preflight prior to launching the same binary. The script and firewall configuration are machine-local prerequisites and are not pre-installed on clean systems.
- **Disabled Upstream Online Auto-Updater**: Configured `IS_CUSTOM_DISTRIBUTION = true` and disabled `createUpdaterArtifacts` along with upstream GitHub Release update checks, preventing generic upstream installers from overwriting the custom build. Use a verified complete installer for cold upgrades, or the local update pipeline for compatible changes.
- **Removed Third-Party Telemetry**: Removed Baidu Tongji tracking modules (`analytics.ts`, `baidu_tongji.rs`) and associated IPC commands. The packaged Content Security Policy (CSP) is locked to local and bundled assets (tested in `tests/privacy-boundary.test.ts`), and automatic HTTP redirect following for plugin requests is disabled.

### 8. Project Views & General Plugin SDK 0.3.28
- **Project Workspaces**: Aggregate registered workspace roots into unified projects while strictly preserving each session's actual working directory. Removing an organizational relationship does not delete files or transfer execution permissions.
- **General Plugin SDK 0.3.28**: Capabilities include permission-scoped project publishing, detached windows, native task coordination, persistent discussions, and **owned image attachments**.
- **Fixed Instructions & Bounded Memory**: Fixed instructions use supported native instruction channels; memory extraction operates under `host:memory` strictly from owned source evidence.
- **Update-Close Hooks & Boundary Enforcement**: Update-close hooks drain accepted operations and confirm plugin services have exited prior to switching. All interfaces enforce ownership boundaries, cancellation checks, evidence verification, and non-replay of unknown results. See the [SDK changelog](./packages/plugin-sdk/CHANGELOG.md) and [plugin development guide](./docs/plugin-development-guide.zh-CN.md).

---

## Building from Source

### Prerequisites
- **Node.js**: Version **24** recommended (tested on 24.14; minimum **22.13.0**).
- **pnpm**: Pinned version **11.19.0** (`npm install --global pnpm@11.19.0`).
- **Rust**: Stable **1.95+** (tested on 1.99).
- **Git**.
- **Platform Dependencies**:
  - **Windows**: Install MSVC C++ Build Tools, Windows SDK, and WebView2 according to the [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/) (**Perl is not required**).
  - **macOS / Linux**: System webkit and build libraries required by Tauri 2. (Note: continuous build verification in this repository is performed primarily on Windows).

### Build Steps

```bash
# 1. Clone the repository (recommended folder name: ccgui-custom)
git clone https://github.com/Vanyangyang/ccgui-custom.git ccgui-custom
cd ccgui-custom

# 2. Install dependencies with the pinned package manager
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile

# 3. Verify main, then build the Windows installer from the same clean checkout
pnpm maint:check
pnpm maint:build
# The resulting installer will be located under: src-tauri/target/release/bundle/nsis/
```

### Build & Distribution Notes
- **Verification Consistency**: Keep the checkout clean and at the same Git commit between `pnpm maint:check` and `pnpm maint:build`. Packaging verifies that the commit matches a passing verification record.
- **Path Sanitization**: Source paths, user home directories, and Cargo cache paths **must not contain `=` characters**. MSVC path sanitization only partially trims paths containing `=`, so packaging scripts actively reject them prior to compilation. Spaces and Unicode characters are supported.
- **Standalone Packaging**: Production builds bundle all frontend assets into the binary; no running dev server is required. Distribute only the generated NSIS installer. Do not share local build logs, report files, or user data directories.
- **On-Demand Configuration**: Building and launching CC GUI do not require installing optional AI CLI engines up front; configure engines in the client when ready. Build scripts inherit process environment and Git proxy settings without requiring fixed proxy ports (`maint:integrate` and `maint:install` are internal maintainer workflows and are not needed for standard installation).

To run the local development server with hot-reloading:

```bash
pnpm dev
```

---

## Registering the Self-Dev Workspace & Updating It

1. **Automatic Detection on First Launch**: Running `pnpm maint:build` or `pnpm dev` records the local checkout path into `default-source-root.txt` (a machine-local hint file stored in user app data; never commit or distribute it). First launch under the same OS account automatically populates the `ccgui-custom [Self-Dev]` sidebar workspace and **Settings → Workspaces → CC GUI Self-Dev Workspace**. If moving the installation to another machine or account, configure that machine's local checkout in Settings.
2. **AI-Assisted Update Preparation**: When verified source modifications pass tests, tools can register `coordinate_self_update(ready)`. Registration records readiness; it does not request a build or activation.
3. **Triggering Live Updates**: After `git pull` or manual edits, use **"Build & Live Update"** under Workspace or Update Settings. The system checks compatibility; if candidate contracts are incompatible, live switching is blocked and a full-exit upgrade using the complete installer is required.
4. **Switching & Rollback**: Background builds run against an isolated snapshot. Switching waits for safe ownership/checkpoint boundaries and can briefly reconnect the UI. Supported worker runs and drafts are restored. If health checks fail post-switch, the transaction rolls back cleanly.

---

## Common Development Commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the Tauri application in development mode with hot-reloading |
| `pnpm build` | Run TypeScript type checking and compile frontend production bundles |
| `pnpm test` | Execute the Vitest test suite |
| `pnpm maint:check` | Run the complete custom verification pipeline (privacy, types, Vitest, Rust unit tests) |
| `pnpm maint:build` | Build the Windows NSIS installer with `+protected.N` branding and generate verification records |
| `pnpm maint:self-update` | Package a local live-update candidate bundle |

*Note*: Source publication must exclude machine-local paths, credentials, conversation history, runtime databases, logs, and build artifacts.

---

## Documentation Links

For in-depth architecture specifications and guides (in Chinese):
- [Custom Maintenance Guide](./docs/custom-maintenance.zh-CN.md)
- [Runtime Live Update Specification](./docs/runtime-live-update.zh-CN.md)
- [Assistant Notices & Progress Observer](./docs/assistant-notices.zh-CN.md)
- [UI/UX Specification](./docs/ui-ux-spec.zh-CN.md)
- [Plugin SDK Changelog](./packages/plugin-sdk/CHANGELOG.md)
- [Plugin Development Guide](./docs/plugin-development-guide.zh-CN.md)

---

## License

This project is distributed under the [MIT License](./LICENSE), retaining original copyright notices of `Thomas Ricouard` and `zhukunpenglinyutong (Kunpeng Zhu)`.
