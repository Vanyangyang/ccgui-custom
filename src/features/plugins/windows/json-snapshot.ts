import { copyJson, equalJson, MAX_JSON_BYTES, type DetachedSnapshot, type JsonChange, type JsonValue, type SnapshotUpdate } from "./protocol";

const MAX_DEPTH = 64;
const MAX_CHANGES = 256;
const MAX_PATCH_BYTES = 256 * 1024;
type Container = JsonValue[] | { [key: string]: JsonValue };
interface Metadata { bytes: number; depth: number }
interface ReadResult extends Metadata { value: JsonValue; stable: boolean }
// Only detached, recursively frozen values constructed by this module enter here.
const owned = new WeakMap<Container, Metadata>();
const ownedSnapshots = new WeakSet<DetachedSnapshot>();

export class SnapshotBaselineError extends Error {
  constructor(message = "Detached snapshot baseline unavailable") { super(message); this.name = "SnapshotBaselineError"; }
}

/** Exact JSON UTF-8 length, including escapes and lone UTF-16 surrogates. */
function stringBytes(value: string): number {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92) bytes += 2;
    else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; } else bytes += 6;
    } else bytes += code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
  }
  return bytes;
}
function primitiveMetadata(value: null | boolean | number | string): Metadata {
  return { bytes: typeof value === "string" ? stringBytes(value) : String(value).length, depth: 0 };
}
function metadata(value: JsonValue): Metadata {
  if (value === null || typeof value !== "object") return primitiveMetadata(value);
  const result = owned.get(value);
  if (!result) throw new Error("Detached snapshot contains an unowned value");
  return result;
}
function assertLimits(info: Metadata, atDepth = 0) {
  if (atDepth + info.depth > MAX_DEPTH) throw new Error("Detached payload exceeds nesting limit");
  if (info.bytes > MAX_JSON_BYTES) throw new Error("Detached payload exceeds size limit");
}
function setOwn(target: Container, key: string | number, value: JsonValue) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
function finish(value: Container): Metadata {
  const keys = Object.keys(value);
  let bytes = 2 + Math.max(0, keys.length - 1), depth = 0;
  for (const key of keys) {
    const child = metadata((value as Record<string, JsonValue>)[key]);
    bytes += child.bytes + (Array.isArray(value) ? 0 : stringBytes(key) + 1);
    depth = Math.max(depth, child.depth + 1);
  }
  const info = { bytes, depth };
  assertLimits(info);
  Object.freeze(value); owned.set(value, info);
  return info;
}

/** A mutable parent is always reread, even if Object.freeze was applied only to it. */
export function createSnapshotReader(): { read(value: unknown): JsonValue } {
  const frozenSources = new WeakMap<object, ReadResult>();
  function read(value: unknown, ancestors: Set<object>, depth: number, normalized = false): ReadResult {
    if (depth > MAX_DEPTH) throw new Error("Detached payload exceeds nesting limit");
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) {
      const info = primitiveMetadata(value); assertLimits(info, depth);
      return { value: Object.is(value, -0) ? 0 : value, ...info, stable: true };
    }
    if (!value || typeof value !== "object") throw new Error("Detached payload must be JSON");
    const local = owned.get(value as Container);
    if (local) { assertLimits(local, depth); return { value: value as Container, ...local, stable: true }; }
    const cached = frozenSources.get(value);
    if (cached) { assertLimits(cached, depth); return cached; }
    if (ancestors.has(value)) throw new Error("Detached payload must not contain cycles");
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new Error("Detached payload must contain plain objects");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key === "symbol")) throw new Error("Detached payload must be JSON");
    // Legacy normalization is retained for accessors/custom array serialization.
    // It never makes the original source eligible for identity caching.
    const dynamic = Object.values(descriptors).some(descriptor => !("value" in descriptor))
      || typeof descriptors.toJSON?.value === "function" || array && prototype !== Array.prototype;
    if (dynamic && !normalized) {
      const result = read(copyJson(value), ancestors, depth, true);
      return { ...result, stable: false };
    }
    ancestors.add(value);
    try {
      const result: Container = array ? [] : {};
      let stable = Object.isFrozen(value) && !dynamic;
      // Ignored non-enumerable data is not proved deeply frozen; do not cache it.
      if (Object.entries(descriptors).some(([key, descriptor]) => !descriptor.enumerable && !(array && key === "length"))) stable = false;
      if (array && Object.keys(descriptors).some(key => key !== "length" && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) stable = false;
      const visit = (key: string) => {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor)) throw new Error("Detached payload must be JSON");
        const child = read(descriptor.value, ancestors, depth + 1, normalized);
        setOwn(result, key, child.value); stable &&= child.stable;
      };
      if (array) for (let index = 0; index < value.length; index++) visit(String(index));
      else for (const key of Object.keys(value)) visit(key);
      const info = finish(result); assertLimits(info, depth);
      const entry = { value: result, ...info, stable };
      if (stable) frozenSources.set(value, entry);
      return entry;
    } finally { ancestors.delete(value); }
  }
  return { read: value => read(value, new Set(), 0).value };
}

const boundaryReader = createSnapshotReader();
export function snapshotJsonBytes(value: JsonValue): number { return metadata(boundaryReader.read(value)).bytes; }
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid snapshot revision");
}
function snapshot(value: DetachedSnapshot): DetachedSnapshot {
  keys(value, ["revision", "state"]);
  const nextRevision = value.revision;
  revision(nextRevision);
  if (ownedSnapshots.has(value)) return value;
  const result = Object.freeze({ revision: nextRevision, state: boundaryReader.read(value.state) });
  ownedSnapshots.add(result);
  return result;
}
function objectBytes(entries: [string, number][]): number {
  return 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, [key, bytes]) => sum + stringBytes(key) + 1 + bytes, 0);
}
function arrayBytes(bytes: number[]): number { return 2 + Math.max(0, bytes.length - 1) + bytes.reduce((sum, value) => sum + value, 0); }
function patchBytes(update: Extract<SnapshotUpdate, { kind: "patch" }>): number {
  const changes = update.changes.map(change => {
    const fields: [string, number][] = [["op", stringBytes(change.op)], ["path", arrayBytes(change.path.map(part => primitiveMetadata(part).bytes))]];
    if (change.op === "set") fields.push(["value", metadata(change.value).bytes]);
    return objectBytes(fields);
  });
  return objectBytes([["kind", stringBytes("patch")], ["baseRevision", primitiveMetadata(update.baseRevision).bytes], ["revision", primitiveMetadata(update.revision).bytes], ["changes", arrayBytes(changes)]]);
}
function fullBytes(value: DetachedSnapshot): number {
  return objectBytes([["kind", stringBytes("full")], ["snapshot", objectBytes([["revision", primitiveMetadata(value.revision).bytes], ["state", metadata(value.state).bytes]])]]);
}
function full(value: DetachedSnapshot): SnapshotUpdate { return Object.freeze({ kind: "full", snapshot: value }); }

export function createSnapshotUpdate(base: DetachedSnapshot | undefined, next: DetachedSnapshot): SnapshotUpdate {
  const after = snapshot(next), before = base && snapshot(base);
  if (!before) return full(after);
  if (after.revision < before.revision) throw new Error("Detached snapshot revision moved backwards");
  if (after.revision === before.revision) {
    if (!equalJson(before.state, after.state)) throw new Error("Conflicting detached snapshot revision");
    return Object.freeze({ kind: "unchanged", revision: after.revision });
  }
  const changes: JsonChange[] = [];
  function diff(a: JsonValue, b: JsonValue, path: (string | number)[]) {
    if (a === b || changes.length > MAX_CHANGES) return;
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) changes.push({ op: "set", path, value: b });
        else for (let i = 0; i < a.length && changes.length <= MAX_CHANGES; i++) diff(a[i], b[i], [...path, i]);
      } else {
        const left = a as Record<string, JsonValue>, right = b as Record<string, JsonValue>;
        for (const key of Object.keys(left)) {
          if (changes.length > MAX_CHANGES) return;
          if (!Object.hasOwn(right, key)) changes.push({ op: "remove", path: [...path, key] });
        }
        for (const key of Object.keys(right)) {
          if (changes.length > MAX_CHANGES) return;
          if (Object.hasOwn(left, key)) diff(left[key], right[key], [...path, key]);
          else changes.push({ op: "set", path: [...path, key], value: right[key] });
        }
      }
    } else changes.push({ op: "set", path, value: b });
  }
  diff(before.state, after.state, []);
  const update: Extract<SnapshotUpdate, { kind: "patch" }> = { kind: "patch", baseRevision: before.revision, revision: after.revision, changes };
  if (changes.length > MAX_CHANGES) return full(after);
  const bytes = patchBytes(update);
  if (bytes > MAX_PATCH_BYTES || bytes >= fullBytes(after)) return full(after);
  for (const change of changes) { Object.freeze(change.path); Object.freeze(change); }
  Object.freeze(changes);
  return Object.freeze(update);
}

interface ChangeNode { change?: JsonChange; children: Map<string | number, ChangeNode> }
function node(): ChangeNode { return { children: new Map() }; }
function keys(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error("Invalid detached snapshot update");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expected.length || expected.some(key => !Object.hasOwn(value, key)) || ownKeys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor);
  })) throw new Error("Invalid detached snapshot update");
}
function dataTag(value: object, key: string) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Invalid detached snapshot update");
}
function staticArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error("Invalid detached snapshot array");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key !== "length" && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
      || !("value" in Object.getOwnPropertyDescriptor(value, key)!)) throw new Error("Invalid detached snapshot array");
  }
}
function validatePatch(update: Extract<SnapshotUpdate, { kind: "patch" }>): { patch: Extract<SnapshotUpdate, { kind: "patch" }>; tree: ChangeNode } {
  keys(update, ["kind", "baseRevision", "revision", "changes"]);
  revision(update.baseRevision); revision(update.revision);
  if (update.revision <= update.baseRevision || !Array.isArray(update.changes) || update.changes.length > MAX_CHANGES) throw new Error("Invalid detached snapshot patch");
  staticArray(update.changes);
  const tree = node(), changes: JsonChange[] = [];
  for (const raw of update.changes) {
    if (!raw || typeof raw !== "object") throw new Error("Invalid detached snapshot change");
    dataTag(raw, "op");
    if (raw.op === "set") keys(raw, ["op", "path", "value"]);
    else if (raw.op === "remove") keys(raw, ["op", "path"]);
    else throw new Error("Invalid detached snapshot change");
    if (!Array.isArray(raw.path) || raw.path.length > MAX_DEPTH || !raw.path.length && raw.op !== "set") throw new Error("Invalid detached snapshot path");
    staticArray(raw.path);
    const path: (string | number)[] = [];
    for (const part of raw.path) {
      if (typeof part !== "string" && !(typeof part === "number" && Number.isSafeInteger(part) && part >= 0)) throw new Error("Invalid detached snapshot path");
      path.push(part);
    }
    if (raw.op === "remove" && typeof path.at(-1) !== "string") throw new Error("Cannot remove a detached array index");
    const change: JsonChange = raw.op === "set" ? { op: "set", path, value: boundaryReader.read(raw.value) } : { op: "remove", path };
    if (change.op === "set") assertLimits(metadata(change.value), path.length);
    let target = tree;
    for (const part of path) {
      if (target.change) throw new Error("Overlapping detached snapshot paths");
      let child = target.children.get(part);
      if (!child) { child = node(); target.children.set(part, child); }
      target = child;
    }
    if (target.change || target.children.size) throw new Error("Overlapping detached snapshot paths");
    target.change = change; changes.push(change);
  }
  const patch = { kind: "patch" as const, baseRevision: update.baseRevision, revision: update.revision, changes };
  if (patchBytes(patch) > MAX_PATCH_BYTES) throw new Error("Detached snapshot patch exceeds size limit");
  return { patch, tree };
}
function containerKey(value: JsonValue, key: string | number): asserts value is Container {
  if (value === null || typeof value !== "object") throw new Error("Invalid detached snapshot path");
  if (Array.isArray(value) ? typeof key !== "number" || key >= value.length : typeof key !== "string") throw new Error("Invalid detached snapshot path");
}
function consistent(value: JsonValue, tree: ChangeNode): boolean {
  if (tree.change) return tree.change.op === "set" && equalJson(value, tree.change.value);
  for (const [key, child] of tree.children) {
    containerKey(value, key);
    const exists = Object.hasOwn(value, key);
    if (child.change?.op === "remove") {
      if (Array.isArray(value)) throw new Error("Cannot remove a detached array index");
      if (exists) return false;
    } else if (!exists || !consistent((value as Record<string | number, JsonValue>)[key], child)) return false;
  }
  return true;
}
function apply(value: JsonValue, tree: ChangeNode): JsonValue {
  if (tree.change) {
    if (tree.change.op !== "set") throw new Error("Cannot remove detached snapshot root");
    return tree.change.value;
  }
  if (!tree.children.size) return value;
  let result: Container | undefined;
  for (const [key, child] of tree.children) {
    containerKey(value, key);
    if (!result) {
      result = Array.isArray(value) ? [] : {};
      for (const ownKey of Object.keys(value)) setOwn(result, ownKey, (value as Record<string, JsonValue>)[ownKey]);
    }
    const exists = Object.hasOwn(value, key);
    if (child.change?.op === "remove") {
      if (Array.isArray(value) || !exists) throw new Error("Invalid detached snapshot removal");
      delete (result as Record<string | number, JsonValue>)[key];
    } else {
      if (!exists && !child.change) throw new Error("Invalid detached snapshot path");
      setOwn(result, key, child.change?.op === "set" ? child.change.value : apply((value as Record<string | number, JsonValue>)[key], child));
    }
  }
  finish(result!);
  return result!;
}

export function applySnapshotUpdate(current: DetachedSnapshot | undefined, update: SnapshotUpdate): DetachedSnapshot {
  if (!update || typeof update !== "object") throw new Error("Invalid detached snapshot update");
  dataTag(update, "kind");
  const before = current && snapshot(current);
  if (update.kind === "full") {
    keys(update, ["kind", "snapshot"]);
    const after = snapshot(update.snapshot);
    if (!before || after.revision > before.revision) return after;
    if (after.revision === before.revision && !equalJson(after.state, before.state)) throw new Error("Conflicting detached snapshot revision");
    return before;
  }
  if (update.kind === "unchanged") {
    keys(update, ["kind", "revision"]); revision(update.revision);
    if (!before || before.revision < update.revision) throw new SnapshotBaselineError();
    return before;
  }
  if (update.kind !== "patch") throw new Error("Invalid detached snapshot update");
  const { patch, tree } = validatePatch(update);
  if (before && patch.revision < before.revision) return before;
  if (before && patch.revision === before.revision) {
    if (!consistent(before.state, tree)) throw new Error("Conflicting detached snapshot revision");
    return before;
  }
  if (!before || before.revision !== patch.baseRevision) throw new SnapshotBaselineError();
  return snapshot({ revision: patch.revision, state: apply(before.state, tree) });
}
