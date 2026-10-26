import type { ComponentType } from "react";
import type * as React from "react";
import type { Disposer } from "./manifest";
import type { HostImagesApi } from "./conversations";

/** JSON-only messages, delivered to the original main-document owner. */
export interface PluginDetachedAction {
  name: string;
  args: unknown[];
}

export interface PluginDetachedSnapshot {
  revision: number;
  state: unknown;
}

/** Props for a renderer-only component in a native plugin window (0.3.17).
 * No PluginContext, chat identity, storage or execution capability is copied
 * into the new document. A resolved dispatch preserves false business results;
 * rejected/unknown outcomes must never be automatically resubmitted. */
export interface PluginDetachedSurfaceProps {
  snapshot: unknown;
  /** Register a synchronous check for edits still held only by the renderer.
   * Called after the host action queue drains. Returning false keeps the
   * window open; remove the guard on unmount. */
  registerReturnGuard(guard: () => boolean): Disposer;
  dispatch(action: PluginDetachedAction): Promise<{
    sequence: number;
    value: unknown;
    snapshot: PluginDetachedSnapshot;
  }>;
}

/** Named main.js export. The host invokes this factory once in the floating
 * document; it must only create a view and must not activate the plugin again. */
export type PluginDetachedRenderer = (context: {
  react: typeof React;
  /** Pure native discussion renderer. It consumes the owner's JSON projection,
   * and grants no chat, storage, execution or approval capability. */
  ConversationView?: ComponentType<{ conversation: unknown; onAction?: (action: { type: string; path?: string }) => void }>;
  /** Scoped image staging/preview channel for this plugin only (0.3.23); grants no chat, task, storage or execution capability. */
  Images?: HostImagesApi;
}) => ComponentType<PluginDetachedSurfaceProps>;

/** Optional center-tab projection (permission ui:detached-window, desktop
 * only). Controller, drafts, subscriptions and side effects remain owned by
 * the original main document. Snapshots/actions must contain JSON values only.
 * Returning/closing flushes queued actions. Explicit return docks the view;
 * closing preserves its presentation preference but marks it closed. The host
 * remembers geometry and restores open views after restart or maintenance.
 * Plugin disable disposes the window; it does not migrate capabilities. */
export interface PluginDetachedSurfaceDefinition {
  /** Initial presentation when no user preference exists (0.3.22). Defaults to docked.
   * Registration alone never opens a new view; only a previously open view is restored. */
  defaultPresentation?: "docked" | "detached";
  /** Name of a PluginDetachedRenderer export in the installed main.js. */
  rendererExport: string;
  getSnapshot(): unknown;
  subscribe(listener: () => void): Disposer;
  dispatch(action: PluginDetachedAction): unknown | Promise<unknown>;
}
