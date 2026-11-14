import type {
  ActionInspection, ActionReceipt, DetachedInit, DetachedSnapshot, SnapshotEvent, SnapshotUpdate, WindowIdentity,
} from "./protocol";

/** Internal wire encoding. The public plugin API continues to receive a
 * complete, isolated snapshot after its original action has settled. */
export interface IncrementalSnapshotEvent extends WindowIdentity { update: SnapshotUpdate; dark: boolean }
export type SnapshotWireEvent = SnapshotEvent | IncrementalSnapshotEvent;
export interface IncrementalActionReceipt extends Omit<ActionReceipt, "snapshot"> { update: SnapshotUpdate }
export interface IncrementalActionInspection extends Omit<ActionInspection, "receipt"> { receipt?: IncrementalActionReceipt }
export type NativeDetachedInit = DetachedInit & { incremental?: boolean };
export type SnapshotRead = WindowIdentity & { snapshot: DetachedSnapshot; dark: boolean };
