// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { applySnapshotUpdate, createSnapshotReader, createSnapshotUpdate, snapshotJsonBytes, SnapshotBaselineError } from "./json-snapshot";
import { copyJson, MAX_JSON_BYTES, MAX_RESULT_BYTES, type DetachedSnapshot, type JsonChange, type JsonValue, type SnapshotUpdate } from "./protocol";

const full = (revision: number, state: JsonValue): DetachedSnapshot => applySnapshotUpdate(undefined, { kind: "full", snapshot: { revision, state } });
const patch = (baseRevision: number, revision: number, changes: JsonChange[]): SnapshotUpdate => ({ kind: "patch", baseRevision, revision, changes });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const nested = (depth: number, value: JsonValue = 0): JsonValue => { for (let i = 0; i < depth; i++) value = { child: value }; return value; };
function deeplyFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) deeplyFreeze(child); Object.freeze(value); }
  return value;
}
const history = () => deeplyFreeze(Array.from({ length: 320 }, (_, id) => ({ id, content: ("中文原文👩🏽‍💻🌏\n```ts\nconst original = '保持';\n```\n|引用|历史|\n").repeat(30), complete: true })));

describe("snapshot reader", () => {
  it("keeps long conversation snapshots above the old eight MiB ceiling intact", () => {
    const original = "中文👩🏽‍💻\n```ts\nconst value = '原文';\n```\n" + "x".repeat(10 * 1024 * 1024);
    const source = { conversation: { messages: [{ role: "assistant", text: original }] }, draft: "继续🌏" };
    const snapshot = createSnapshotReader().read(source) as typeof source;
    expect(snapshot.conversation.messages[0].text).toBe(original);
    expect(snapshot.draft).toBe("继续🌏");
    expect(snapshotJsonBytes(snapshot)).toBe(bytes(source));
  });
  it("keeps the separate action-result budget at eight MiB", () => {
    expect(copyJson("x".repeat(MAX_RESULT_BYTES - 2), MAX_RESULT_BYTES)).toHaveLength(MAX_RESULT_BYTES - 2);
    expect(() => copyJson("x".repeat(MAX_RESULT_BYTES - 1), MAX_RESULT_BYTES)).toThrow(/size/);
  });
  it("detaches and deeply freezes mutable JSON without mutating the source", () => {
    const read = createSnapshotReader().read;
    const source = { draft: "中文🌏", rows: [{ text: "first" }] };
    const first = read(source) as typeof source;
    expect(first).toEqual(source); expect(first).not.toBe(source); expect(first.rows).not.toBe(source.rows);
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.rows[0])).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
    source.rows[0].text = "second";
    const second = read(source) as typeof source;
    expect(first.rows[0].text).toBe("first"); expect(second.rows[0].text).toBe("second");
    expect(() => { first.rows[0].text = "caller mutation"; }).toThrow();
  });
  it("caches only proven deeply frozen subtrees, never a frozen parent around mutable children", () => {
    const read = createSnapshotReader().read;
    const rows = deeplyFreeze([{ text: "stable" }]);
    const mutable = { text: "one" };
    const source = Object.freeze({ rows, mutable });
    const first = read(source) as typeof source;
    mutable.text = "two";
    const second = read(source) as typeof source;
    expect(second).not.toBe(first); expect(second.rows).toBe(first.rows);
    expect(second.mutable.text).toBe("two"); expect(first.mutable.text).toBe("one");
    expect(second.rows).not.toBe(rows);
    Object.freeze(mutable);
    const frozen = read(source);
    expect(read(source)).toBe(frozen);
  });
  it("does not cache frozen accessors or custom toJSON normalization", () => {
    const read = createSnapshotReader().read;
    let current = "one";
    const accessor = Object.freeze({ get text() { return current; } });
    const first = read(accessor); current = "two";
    expect(read(accessor)).toEqual({ text: "two" }); expect(first).toEqual({ text: "one" });
    const dynamic = Object.freeze(Object.defineProperty({}, "toJSON", { value: () => ({ text: current }) }));
    const previous = read(dynamic); current = "three";
    expect(read(dynamic)).toEqual({ text: "three" }); expect(previous).toEqual({ text: "two" });
  });
  it("revalidates the legacy accessor result and cannot recurse forever", () => {
    const read = createSnapshotReader().read;
    let calls = 0;
    const value = { get changing() { return ++calls === 1 ? 1 : new Date(0); } };
    expect(read(value)).toEqual({ changing: new Date(0).toJSON() });
    const cycle: any = {};
    Object.defineProperty(cycle, "toJSON", { value: () => cycle });
    cycle.self = cycle;
    expect(() => read(cycle)).toThrow(/cycles/);
  });
  it.each([undefined, NaN, Infinity, new Date(), () => 1, 1n, Symbol("value"), { value: undefined }, { [Symbol("key")]: 1 }, Object.create({ inherited: true }), [, 1]])("rejects non-JSON input %s", value => {
    expect(() => createSnapshotReader().read(value)).toThrow();
  });
  it("rejects cycles but accepts shared non-cyclic branches", () => {
    const read = createSnapshotReader().read;
    const loop: any = {}; loop.self = loop; Object.freeze(loop);
    expect(() => read(loop)).toThrow(/cycles/);
    const branch = { value: "shared" };
    expect(read({ a: branch, b: branch })).toEqual({ a: branch, b: branch });
    expect(() => read(new Array(0xffff_ffff))).toThrow(/JSON/);
  });
  it("counts UTF-8 JSON bytes exactly, including escaped keys, emoji, surrogates and finite numbers", () => {
    const reader = createSnapshotReader();
    const values: JsonValue[] = [null, true, false, -0, 1e-7, 1e21, Number.MAX_VALUE, Number.MIN_VALUE, "", "\0\b\t\n\f\r\u001f\"\\",
      "中文👩🏽‍💻🌏\u2028\u2029", "\ud800x\udfff", [0, [], {}], JSON.parse('{"__proto__":{"x":1},"a\\\"\\n":3}')];
    let seed = 17;
    for (let i = 0; i < 100; i++) {
      let text = "";
      for (let j = 0; j < 30; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += String.fromCharCode(seed & 0xffff); }
      values.push({ [text]: [text, i / 7, false, null] });
    }
    for (const value of values) {
      const copied = reader.read(value);
      expect(snapshotJsonBytes(copied)).toBe(bytes(value));
      expect(snapshotJsonBytes(value)).toBe(bytes(value));
    }
    expect(Object.is(reader.read(-0), -0)).toBe(false);
  });
  it("enforces depth and exact full-state size even when a cached branch is nested deeper", () => {
    const read = createSnapshotReader().read;
    const atLimit = deeplyFreeze(nested(64));
    expect(read(atLimit)).toEqual(atLimit);
    expect(() => read({ child: atLimit })).toThrow(/nesting/);
    expect(() => read(nested(65))).toThrow(/nesting/);
    expect(snapshotJsonBytes(read("a".repeat(MAX_JSON_BYTES - 2)))).toBe(MAX_JSON_BYTES);
    expect(() => read("a".repeat(MAX_JSON_BYTES - 1))).toThrow(/size/);
  });
  it("reads a large frozen history once across 24 draft changes without full serialization", () => {
    let historyReads = 0;
    const source = history();
    const observed = new Proxy(source, { ownKeys(target) { historyReads++; return Reflect.ownKeys(target); } });
    const reader = createSnapshotReader();
    let previous = reader.read({ draft: "", history: observed }) as { draft: string; history: JsonValue };
    expect(historyReads).toBeGreaterThan(0);
    historyReads = 0;
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      for (let i = 1; i <= 24; i++) {
        const next = reader.read({ draft: `逐键中文👩🏽‍💻 ${i}`, history: observed }) as typeof previous;
        expect(next.history).toBe(previous.history);
        expect(snapshotJsonBytes(next)).toBeGreaterThan(500_000);
        previous = next;
      }
      expect(historyReads).toBe(0);
      expect(stringify).not.toHaveBeenCalled();
    } finally { stringify.mockRestore(); }
    expect(snapshotJsonBytes(previous)).toBe(bytes(previous));
  });
  it("never retains a frozen array's unproved extra mutable properties as a cached source", () => {
    const source = [1] as number[] & { extra?: { value: number } };
    source.extra = { value: 1 }; Object.freeze(source);
    const read = createSnapshotReader().read;
    const first = read(source); source.extra.value = 2;
    expect(read(source)).toEqual([1]); expect(read(source)).not.toBe(first);
  });
});

describe("snapshot updates", () => {
  it("round-trips a small delta and copies only changed containers", () => {
    const reader = createSnapshotReader();
    const rows = history();
    const a = { revision: 4, state: reader.read({ form: { draft: "one", obsolete: true }, rows, stable: { x: 1 } }) };
    const b = { revision: 7, state: reader.read({ form: { draft: "two", added: null }, rows, stable: { x: 1 } }) };
    const current = full(a.revision, a.state);
    const update = createSnapshotUpdate(a, b);
    expect(update.kind).toBe("patch");
    expect(bytes(update)).toBeLessThan(500);
    const next = applySnapshotUpdate(current, update);
    expect(next).toEqual(b);
    expect((next.state as any).rows).toBe((current.state as any).rows);
    expect((next.state as any).stable).toBe((current.state as any).stable);
    expect((next.state as any).form).not.toBe((current.state as any).form);
    expect((current.state as any).form).toEqual({ draft: "one", obsolete: true });
    expect(snapshotJsonBytes(next.state)).toBe(bytes(next.state));
    expect(applySnapshotUpdate(next, update)).toBe(next);
  });
  it("detaches full and patch values from callers and safely preserves __proto__ keys", () => {
    const initial = JSON.parse('{"__proto__":{"value":1},"constructor":{"safe":true},"value":0}');
    const current = full(0, initial); initial.__proto__.value = 9;
    expect((current.state as any).__proto__.value).toBe(1);
    const added = { value: 2 };
    const update = patch(0, 1, [{ op: "set", path: ["__proto__"], value: added }]);
    const next = applySnapshotUpdate(current, update); added.value = 10;
    expect(Object.getPrototypeOf(next.state)).toBe(Object.prototype);
    expect(Object.hasOwn(next.state as object, "__proto__")).toBe(true);
    expect((next.state as any).__proto__.value).toBe(2);
    expect(({} as any).value).toBeUndefined();
    expect(snapshotJsonBytes(next.state)).toBe(bytes(next.state));
  });
  it("uses full updates when patches cost more, exceed bytes, or exceed the operation limit", () => {
    expect(createSnapshotUpdate(undefined, { revision: 0, state: null }).kind).toBe("full");
    expect(createSnapshotUpdate({ revision: 0, state: "a" }, { revision: 1, state: "b" }).kind).toBe("full");
    const rows = history(), reader = createSnapshotReader();
    const base = { revision: 0, state: reader.read({ rows, fields: {} }) };
    const fields = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`key${index}`, index]));
    const limit = { revision: 1, state: reader.read({ rows, fields }) };
    expect(createSnapshotUpdate(base, limit).kind).toBe("patch");
    expect(createSnapshotUpdate(base, { revision: 1, state: reader.read({ rows, fields: { ...fields, extra: true } }) }).kind).toBe("full");
    expect(createSnapshotUpdate(base, { revision: 1, state: reader.read({ rows, fields: { large: "x".repeat(256 * 1024) } }) }).kind).toBe("full");
  });
  it("enforces the exact patch byte limit and counts escaped paths", () => {
    const current = full(0, { "中文\"\n": "", padding: "p".repeat(300_000) });
    const changes: JsonChange[] = [{ op: "set", path: ["中文\"\n"], value: "" }];
    const atLimit = patch(0, 1, changes);
    (changes[0] as Extract<JsonChange, { op: "set" }>).value = "x".repeat(256 * 1024 - bytes(atLimit));
    expect(bytes(atLimit)).toBe(256 * 1024);
    expect(applySnapshotUpdate(current, atLimit).revision).toBe(1);
    (changes[0] as Extract<JsonChange, { op: "set" }>).value += "x";
    expect(() => applySnapshotUpdate(current, atLimit)).toThrow(/size/);
  });
  it("supports existing array index replacement and replaces whole arrays for length changes", () => {
    const current = full(0, { list: [1, { text: "a" }], padding: "p".repeat(500) });
    const next = applySnapshotUpdate(current, patch(0, 1, [{ op: "set", path: ["list", 1, "text"], value: "b" }]));
    expect((next.state as any).list).toEqual([1, { text: "b" }]);
    const changedLength = { revision: 2, state: { list: [1, { text: "b" }, 3], padding: "p".repeat(500) } };
    const update = createSnapshotUpdate(next, changedLength);
    expect(update).toMatchObject({ kind: "patch", changes: [{ op: "set", path: ["list"] }] });
    expect(applySnapshotUpdate(next, update)).toEqual(changedLength);
    for (const change of [
      { op: "set", path: ["list", 2], value: 3 }, { op: "set", path: ["list", "length"], value: 0 },
      { op: "set", path: ["list", "0"], value: 3 }, { op: "remove", path: ["list", 0] },
    ] as JsonChange[]) expect(() => applySnapshotUpdate(current, patch(0, 1, [change]))).toThrow();
  });
  it("preserves primitive roots and allows root set but not root remove", () => {
    const current = full(0, 1);
    const next = applySnapshotUpdate(current, patch(0, 1, [{ op: "set", path: [], value: [false, null] }]));
    expect(next.state).toEqual([false, null]);
    expect(() => applySnapshotUpdate(next, patch(1, 2, [{ op: "remove", path: [] }]))).toThrow();
  });
  it("requires exact snapshot fields and rejects accessors without invoking them", () => {
    const getter = vi.fn(() => 0);
    for (const invalid of [
      { revision: 0, state: null, extra: true },
      { state: null },
      Object.defineProperty({ state: null }, "revision", { enumerable: true, get: getter }),
      Object.defineProperty({ revision: 0 }, "state", { enumerable: true, get: getter }),
      Object.defineProperty({ state: null }, "revision", { value: 0 }),
      { revision: 0, state: null, [Symbol("hidden")]: true },
    ]) {
      expect(() => applySnapshotUpdate(undefined, { kind: "full", snapshot: invalid as DetachedSnapshot })).toThrow();
      expect(() => createSnapshotUpdate(undefined, invalid as DetachedSnapshot)).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects duplicate and ancestor/descendant paths in either order", () => {
    const current = full(0, { a: { b: 0 } });
    const set = (path: (string | number)[]): JsonChange => ({ op: "set", path, value: 1 });
    for (const changes of [[set(["a"]), set(["a"])], [set(["a"]), set(["a", "b"])], [set(["a", "b"]), set(["a"])], [set([]), set(["a"])]]) {
      expect(() => applySnapshotUpdate(current, patch(0, 1, changes))).toThrow(/Overlapping/);
    }
  });
  it("validates all changes before applying anything and enforces resulting depth/size", () => {
    const current = full(0, { first: 1, deep: nested(63) });
    expect(() => applySnapshotUpdate(current, patch(0, 1, [{ op: "set", path: ["first"], value: 2 }, { op: "remove", path: ["missing"] }]))).toThrow();
    expect((current.state as any).first).toBe(1);
    expect(() => applySnapshotUpdate(current, patch(0, 1, [{ op: "set", path: ["deep", ...Array(63).fill("child")], value: { tooDeep: 1 } }]))).toThrow(/nesting/);
    const large = full(0, { padding: "x".repeat(MAX_JSON_BYTES - 50), draft: "" });
    expect(() => applySnapshotUpdate(large, patch(0, 1, [{ op: "set", path: ["draft"], value: "x".repeat(100) }]))).toThrow(/size/);
    expect((large.state as any).draft).toBe("");
  });
  it("uses a dedicated baseline error only for valid updates lacking the required state", () => {
    const update = patch(3, 5, [{ op: "set", path: ["a"], value: 1 }]);
    expect(() => applySnapshotUpdate(undefined, update)).toThrow(SnapshotBaselineError);
    expect(() => applySnapshotUpdate(full(2, {}), update)).toThrow(SnapshotBaselineError);
    expect(() => applySnapshotUpdate(full(4, {}), update)).toThrow(SnapshotBaselineError);
    expect(() => applySnapshotUpdate(undefined, { kind: "unchanged", revision: 0 })).toThrow(SnapshotBaselineError);
    expect(() => applySnapshotUpdate(full(3, {}), { kind: "unchanged", revision: 4 })).toThrow(SnapshotBaselineError);
    const current = full(5, {});
    expect(applySnapshotUpdate(current, { kind: "unchanged", revision: 5 })).toBe(current);
    expect(applySnapshotUpdate(current, { kind: "unchanged", revision: 4 })).toBe(current);
  });
  it("checks same-revision full state and every patch final effect, including removes", () => {
    const current = full(5, { nested: { value: 2 }, array: [1, 2] });
    expect(applySnapshotUpdate(current, { kind: "full", snapshot: { revision: 5, state: { array: [1, 2], nested: { value: 2 } } } })).toBe(current);
    expect(() => applySnapshotUpdate(current, { kind: "full", snapshot: { revision: 5, state: null } })).toThrow(/Conflicting/);
    const duplicate = patch(2, 5, [{ op: "set", path: ["nested", "value"], value: 2 }, { op: "remove", path: ["missing"] }, { op: "set", path: ["array", 1], value: 2 }]);
    expect(applySnapshotUpdate(current, duplicate)).toBe(current);
    for (const change of [{ op: "set", path: ["nested", "value"], value: 3 }, { op: "remove", path: ["nested"] }, { op: "set", path: ["missing"], value: 1 }] as JsonChange[]) {
      expect(() => applySnapshotUpdate(current, patch(2, 5, [change]))).toThrow(/Conflicting/);
    }
    expect(() => applySnapshotUpdate(current, patch(2, 5, [{ op: "remove", path: ["absentParent", "key"] }]))).toThrow();
  });
  it("validates stale updates before ignoring them, without needing their old baseline", () => {
    const current = full(10, { stable: true });
    expect(applySnapshotUpdate(current, patch(0, 2, [{ op: "set", path: ["former", "path"], value: 1 }]))).toBe(current);
    expect(applySnapshotUpdate(current, { kind: "full", snapshot: { revision: 1, state: null } })).toBe(current);
    for (const changes of [
      [{ op: "set", path: ["x"], value: NaN }], [{ op: "set", path: ["x"], value: undefined }],
      [{ op: "set", path: ["x"], value: new Date() }], [{ op: "remove", path: ["x", 0] }],
      Array.from({ length: 257 }, (_, i) => ({ op: "set", path: [String(i)], value: 0 })),
    ]) expect(() => applySnapshotUpdate(current, patch(0, 2, changes as JsonChange[]))).toThrow();
    expect(() => applySnapshotUpdate(full(2, null), patch(0, 1, [{ op: "set", path: Array(64).fill("x"), value: { x: 0 } }]))).toThrow(/nesting/);
    expect(applySnapshotUpdate(current, patch(0, 2, [{ op: "set", path: Array(64).fill("x"), value: 0 }]))).toBe(current);
  });
  it("rejects malformed patch containers and paths even when stale", () => {
    const current = full(10, null);
    const pathWithSymbol = Object.assign(["key"], { [Symbol("hidden")]: 1 });
    const changesWithSymbol = Object.assign([], { [Symbol("hidden")]: 1 });
    for (const bad of [
      { kind: "patch", baseRevision: 0, revision: 2, changes: [], extra: true },
      { kind: "patch", baseRevision: 0, revision: 2, changes: changesWithSymbol },
      patch(0, 2, [{ op: "set", path: pathWithSymbol, value: 0 }]),
      patch(0, 2, [{ op: "set", path: [NaN], value: 0 }]),
      patch(0, 2, [{ op: "set", path: [-1], value: 0 }]),
      patch(0, 2, [{ op: "set", path: Array(65).fill("a"), value: 0 }]),
      patch(2, 2, []), patch(3, 2, []),
    ]) expect(() => applySnapshotUpdate(current, bad as SnapshotUpdate)).toThrow();
    const getter = vi.fn(() => "patch");
    expect(() => applySnapshotUpdate(current, Object.defineProperty({}, "kind", { enumerable: true, get: getter }) as SnapshotUpdate)).toThrow();
    expect(() => applySnapshotUpdate(current, patch(0, 2, [Object.defineProperty({}, "op", { enumerable: true, get: getter }) as JsonChange]))).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid revisions %s", invalid => {
    expect(() => full(invalid, null)).toThrow();
    expect(() => applySnapshotUpdate(full(0, null), { kind: "unchanged", revision: invalid })).toThrow();
    expect(() => applySnapshotUpdate(undefined, patch(invalid, 2, []))).toThrow();
  });
  it("advances an unchanged state with a valid patch and rejects backwards/conflicting creation", () => {
    const current = full(Number.MAX_SAFE_INTEGER - 1, { padding: "p".repeat(200) });
    const next = { revision: Number.MAX_SAFE_INTEGER, state: current.state };
    const update = createSnapshotUpdate(current, next);
    expect(update).toMatchObject({ kind: "patch", changes: [] });
    expect(applySnapshotUpdate(current, update)).toEqual(next);
    expect(createSnapshotUpdate(next, next)).toEqual({ kind: "unchanged", revision: next.revision });
    expect(() => createSnapshotUpdate(next, current)).toThrow(/backwards/);
    expect(() => createSnapshotUpdate(current, { revision: current.revision, state: null })).toThrow(/Conflicting/);
  });
  it("matches full JSON replacement over deterministic mixed-object/array changes", () => {
    let seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const generate = (depth: number): JsonValue => {
      const choice = random() % (depth ? 7 : 5);
      if (choice === 0) return null;
      if (choice === 1) return random() % 2 === 0;
      if (choice === 2) return random() / 31 - 10;
      if (choice === 3) return `中文👩🏽‍💻\u0001\\\" ${random()}`;
      if (choice === 4) return "";
      if (choice === 5) return Array.from({ length: random() % 4 }, () => generate(depth - 1));
      const result: Record<string, JsonValue> = {};
      for (let i = 0, count = random() % 4; i < count; i++) Object.defineProperty(result, ["__proto__", "constructor", "中文\n", ""][i], { value: generate(depth - 1), enumerable: true, configurable: true, writable: true });
      return result;
    };
    let current = full(0, { padding: "p".repeat(5000), payload: generate(4) });
    for (let i = 1; i <= 100; i++) {
      const previous = JSON.stringify(current);
      const next = { revision: i, state: { padding: "p".repeat(5000), payload: generate(4) } };
      const update = createSnapshotUpdate(current, next);
      const applied = applySnapshotUpdate(current, update);
      expect(applied).toEqual(next); expect(snapshotJsonBytes(applied.state)).toBe(bytes(next.state));
      expect(JSON.stringify(current)).toBe(previous); expect(applySnapshotUpdate(applied, update)).toBe(applied);
      current = applied;
    }
  });
  it("keeps 24 draft deltas small and reuses frozen history during read, diff and apply", () => {
    const rows = history(), reader = createSnapshotReader();
    let current = full(0, reader.read({ rows, draft: "" }));
    const originalRows = (current.state as any).rows;
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      for (let i = 1; i <= 24; i++) {
        const next = { revision: i, state: reader.read({ rows, draft: `中文👩🏽‍💻 ${i}` }) };
        const update = createSnapshotUpdate(current, next);
        expect(update).toMatchObject({ kind: "patch", changes: [{ op: "set", path: ["draft"] }] });
        current = applySnapshotUpdate(current, update);
        expect(current).toEqual(next); expect((current.state as any).rows).toBe(originalRows);
      }
      expect(stringify).not.toHaveBeenCalled();
    } finally { stringify.mockRestore(); }
  });
});
