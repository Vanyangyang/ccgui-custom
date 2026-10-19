/**
 * MCP transport: inventory, configuration toggles and explicit connection
 * probes use the host commands through desktop IPC or the authenticated bridge.
 */
import { invoke } from "@/lib/transport";
import type {
  McpConfigEntry,
  McpErrorCode,
  McpInventory,
  McpProbeResult,
} from "./types";

export class McpHubError extends Error {
  readonly code: McpErrorCode;
  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.name = "McpHubError";
    this.code = code;
  }
}

function normalize(error: unknown): McpHubError {
  if (error instanceof McpHubError) return error;
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown };
    return new McpHubError(
      typeof record.code === "string" ? (record.code as McpErrorCode) : "internal",
      typeof record.message === "string" ? record.message : String(error),
    );
  }
  return new McpHubError("internal", String(error));
}

export const mcpApi = {
  inventory: async (workspace: string | null): Promise<McpInventory> => {
    try {
      return await invoke<McpInventory>("mcp_inventory", { workspace });
    } catch (error) {
      throw normalize(error);
    }
  },
  setEnabled: async (
    entry: McpConfigEntry,
    enabled: boolean,
    workspace: string | null,
  ): Promise<McpConfigEntry> => {
    try {
      return await invoke<McpConfigEntry>("mcp_set_enabled", {
        request: {
          entryId: entry.id,
          enabled,
          version: entry.version,
          workspace,
        },
      });
    } catch (error) {
      throw normalize(error);
    }
  },
  /** 显式连接检测：后端按配置里的真实命令/地址启动或连接一次并握手。 */
  probe: async (
    entry: McpConfigEntry,
    workspace: string | null,
  ): Promise<McpProbeResult> => {
    try {
      return await invoke<McpProbeResult>("mcp_probe", {
        request: { entryId: entry.id, workspace },
      });
    } catch (error) {
      throw normalize(error);
    }
  },
};
