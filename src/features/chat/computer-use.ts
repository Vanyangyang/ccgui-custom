import type { EngineInfo } from "@/lib/ipc";

/**
 * Computer use (电脑操控): frontend helpers shared by the composer's
 * `/ccgui-cua` interception, the send path and the settings section.
 *
 * The driver itself is backend-owned (src-tauri/src/computer_use.rs): the app
 * mounts it as an MCP child on a send whose `computerUse` flag is set, and
 * the virtual pointer overlay (cu_overlay.rs) follows every action target
 * automatically. Nothing here turns the pointer on or off — that is the
 * app's own guarantee, not a model decision.
 */

/** Settings nav key of the Computer Use section (see ./sections). */
export const COMPUTER_USE_SECTION_KEY = "computerUse";

/** Hash deep link into that section (SettingsPage reads ?page=). */
export const COMPUTER_USE_SETTINGS_HASH = `#/settings?page=${COMPUTER_USE_SECTION_KEY}`;

/**
 * Whether this engine can receive the app's computer-use driver.
 *
 * The backend filters the flag against the engine's MCP-mount capability
 * (`supports_computer_use`, exposed here as `supportsComputerUse`), so asking
 * for computer use on an engine that cannot mount the driver would run the
 * prompt text-only without ever saying so. Callers refuse instead of sending
 * a turn the user did not ask for.
 */
export function engineSupportsComputerUse(
  engines: EngineInfo[],
  engine: string,
): boolean {
  return engines.find((entry) => entry.id === engine)?.supportsComputerUse === true;
}
