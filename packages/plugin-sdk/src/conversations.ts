import type { Disposer } from "./manifest";
import type { ComponentType } from "react";
import type { HostFixedInstructions } from "./fixed-instructions";

export type ConversationEngine = "claude" | "codex";
export interface ConversationSelection {
  engine: ConversationEngine;
  model?: string;
  effort?: string;
  providerId?: string;
}
export interface ConversationSnapshot {
  threadId: string;
  revision: number;
  workspacePath: string;
  selection: ConversationSelection;
  /** Native-resolved launch arguments, frozen when opened; not evidence of the
   * upstream model that ultimately answered. A changed alias mapping requires a
   * new thread. Credentials/endpoints of the selected provider remain user-managed. */
  effectiveSelection: ConversationSelection;
  sessionRef: { engine: ConversationEngine; sessionId: string; workspacePath: string } | null;
  status: "idle" | "starting" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  /** Transient JSON projection of host Message rows. Render through the host
   * renderer; plugins must not persist, rewrite or infer native session identity
   * from these opaque rows. */
  messages: unknown[];
  error?: string;
  lastRequestId?: string;
}
export interface PluginImageAttachment {
  id: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
}
export interface HostImagesApi {
  importImage(request: {
    dataBase64: string;
    mimeType: string;
    name?: string;
  }): Promise<PluginImageAttachment>;
  readPreview(id: string): Promise<{ dataUrl: string }>;
}
export interface ConversationCatalog {
  /** User's current engine, which may not support read-only discussion. */
  defaultEngine?: string;
  capabilities?: {
    images: boolean;
    fixedInstructions?: boolean;
  };
  engines: Array<{
    id: ConversationEngine;
    label: string;
    available: boolean;
    supportsImages?: boolean;
    models: Array<{ id: string; label: string }>;
    providers: Array<{ id: string; label: string }>;
    efforts?: Array<{ id: string; label: string }>;
    defaultModel: string | null;
    defaultEffort: string | null;
    defaultProviderId: string;
  }>;
  workspaces: Array<{ id: string; path: string; name: string }>;
}
/** Desktop-owner-only host:chat capability. Runs persistent read-only native
 * Sidechat branches (Claude: Read/Grep/Glob, no MCP; Codex: verified read-only
 * sandbox, no network). It can read files in the registered local workspace and
 * sends prompts and inspected context to the selected provider. It consumes
 * provider quota. No execution, promotion, task ledger, or global settings edits
 * are exposed. Closing UI / disposing listeners does not cancel work.
 * A thread's workspace and selection are immutable. Rotate threadId to change
 * either. Missing model/effort resolve once from host defaults; if a default
 * cannot be resolved, open requires an explicit choice instead of relying on
 * mutable CLI defaults. Persisted in-flight work without native proof restores as unknown;
 * it is never silently replayed. Only the latest request is retained per thread;
 * expectedRevision prevents replay of older requests after subsequent turns. */
export interface HostConversationsApi {
  catalog(): Promise<ConversationCatalog>;
  open(request: { threadId: string; workspacePath: string; selection: ConversationSelection }): Promise<ConversationSnapshot>;
  inspect(threadId: string): Promise<ConversationSnapshot>;
  send(request: { threadId: string; requestId: string; expectedRevision: number; prompt: string; images?: string[]; fixedInstructions?: HostFixedInstructions }): Promise<ConversationSnapshot>;
  stop(threadId: string): Promise<ConversationSnapshot>;
  /** Reveal a clicked discussion file link in the owner window's native file UI. */
  openFile(threadId: string, path: string): Promise<void>;
  onEvent(callback: (snapshot: ConversationSnapshot) => void): Disposer;
}

/** Host renderer with no send, storage or approval authority of its own. */
export interface ConversationViewProps {
  conversation: unknown;
  /** Plain/read-only projections never expose coordinator write controls. */
  readOnly?: boolean;
  onAction?: (action: ConversationViewAction) => void;
}
/** Composite views accept { sources: [{ id, label, conversation }], currentSourceId? }.
 * At most 32 recent sources render; an explicit currentSourceId is always retained.
 * Without it the last source is current. sourceId
 * routes an action to its originating projection. The host revalidates ownership. */
export type ConversationViewAction = { type: "openFile"; path: string; sourceId?: string; expectedRevision?: number } | import("./task-conversations").HostTaskConversationAction;
export type ConversationViewComponent = ComponentType<ConversationViewProps>;
