/** Closed, bounded subset of OpenUI Lang accepted by the GPT trial. */
export const INTERACTIVE_LANGUAGE = "ccgui-ui";
export const ANSWER_COMPONENTS = ["Stack", "Grid", "Card", "Heading", "Text", "Metric", "Badge", "Divider", "Slider", "NumberInput", "Select", "Toggle", "Table", "BarChart"] as const;
export const ANSWER_FUNCTIONS = ["Round", "Abs", "Floor", "Ceil", "Count", "Sum", "Avg", "Min", "Max"] as const;
export const ANSWER_LIMITS = { bytes: 32_768, tokens: 4_096, expressionTokens: 256, statements: 80, states: 16, depth: 24, expandedNodes: 4_096, expandedText: 131_072, array: 64, string: 2_000 } as const;
export type AnswerValue = string | number | boolean;
export type AnswerState = Record<string, AnswerValue>;
export type ProgramCheck = { ok: true; source: string; defaults: AnswerState } | { ok: false; reason: "size" | "syntax" | "unsupported" | "references" };

type Token = { kind: "string" | "number" | "id" | "state" | "builtin" | "symbol" | "newline"; raw: string; value?: string | number };
type Expr =
  | { kind: "literal"; value: AnswerValue | null }
  | { kind: "ref" | "state"; name: string }
  | { kind: "call"; name: string; builtin: boolean; args: Expr[] }
  | { kind: "array"; values: Expr[] }
  | { kind: "object"; entries: [string, Expr][] }
  | { kind: "unary"; op: string; value: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "conditional"; condition: Expr; yes: Expr; no: Expr };
type Statement = { name: string; state: boolean; expr: Expr };
class InvalidProgram extends Error { constructor(readonly reason: Exclude<ProgramCheck, { ok: true }>["reason"]) { super(reason); } }
function reject(reason: InvalidProgram["reason"]): never { throw new InvalidProgram(reason); }
const reserved = new Set(["__proto__", "prototype", "constructor", "__reactive", "k", "type", "typeName", "props", "mappedProps", "statementId"]);
const names = new Set<string>(ANSWER_COMPONENTS);
const functions = new Set<string>(ANSWER_FUNCTIONS);
const precedence: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, ">": 4, "<": 4, ">=": 4, "<=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
function validName(name: string): boolean { return identifier.test(name) && !reserved.has(name) && !["true", "false", "null"].includes(name); }

/** Unlike the upstream streaming lexer, reject every unrecognized byte. */
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === " " || char === "\t" || char === "\r") { i++; continue; }
    if (char === "\n") { tokens.push({ kind: "newline", raw: "\n" }); i++; }
    else if (char === '"') {
      const start = i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i++] === '"') { closed = true; break; }
      }
      if (!closed) reject("syntax");
      const raw = source.slice(start, i);
      let value: unknown;
      try { value = JSON.parse(raw); } catch { reject("syntax"); }
      if (typeof value !== "string" || value.length > ANSWER_LIMITS.string || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) reject("size");
      tokens.push({ kind: "string", raw, value });
    } else if (/[0-9]/.test(char)) {
      const raw = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i))?.[0];
      if (!raw) reject("syntax");
      const value = Number(raw);
      if (!Number.isFinite(value) || Math.abs(value) > 1e12) reject("size");
      tokens.push({ kind: "number", raw, value }); i += raw.length;
    } else if (/[A-Za-z_$@]/.test(char)) {
      const match = /^([$@]?)([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i));
      if (!match || !identifier.test(match[2]) || reserved.has(match[2])) reject("unsupported");
      tokens.push({ kind: match[1] === "$" ? "state" : match[1] === "@" ? "builtin" : "id", raw: match[0], value: match[2] }); i += match[0].length;
    } else {
      const raw = /^(?:==|!=|>=|<=|&&|\|\||[()[\]{},:=+*/%!?<>-])/.exec(source.slice(i))?.[0];
      if (!raw) reject("syntax");
      tokens.push({ kind: "symbol", raw }); i += raw.length;
    }
    if (tokens.length > ANSWER_LIMITS.tokens) reject("size");
  }
  return tokens;
}

class ExpressionParser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}
  private peek(): Token | undefined { return this.tokens[this.index]; }
  private take(): Token { return this.tokens[this.index++] ?? reject("syntax"); }
  private expect(raw: string): void { if (this.take().raw !== raw) reject("syntax"); }
  parse(): Expr {
    const value = this.expression(0, 0);
    if (this.index !== this.tokens.length) reject("syntax");
    return value;
  }
  private expression(min: number, depth: number): Expr {
    if (depth > ANSWER_LIMITS.depth) reject("size");
    let left = this.primary(depth + 1);
    while (this.peek() && precedence[this.peek()!.raw] !== undefined && precedence[this.peek()!.raw] >= min) {
      const op = this.take().raw;
      left = { kind: "binary", op, left, right: this.expression(precedence[op] + 1, depth + 1) };
    }
    if (min === 0 && this.peek()?.raw === "?") {
      this.take(); const yes = this.expression(0, depth + 1); this.expect(":");
      left = { kind: "conditional", condition: left, yes, no: this.expression(0, depth + 1) };
    }
    return left;
  }
  private primary(depth: number): Expr {
    if (depth > ANSWER_LIMITS.depth) reject("size");
    const token = this.take();
    if (["!", "+", "-"].includes(token.raw)) return { kind: "unary", op: token.raw, value: this.primary(depth + 1) };
    if (token.kind === "number" || token.kind === "string") return { kind: "literal", value: token.value as number | string };
    if (token.kind === "id" && ["true", "false", "null"].includes(token.raw)) return { kind: "literal", value: token.raw === "null" ? null : token.raw === "true" };
    if (token.raw === "(") { const value = this.expression(0, depth + 1); this.expect(")"); return value; }
    if (token.raw === "[") return { kind: "array", values: this.list("]", depth) };
    if (token.raw === "{") {
      const entries: [string, Expr][] = [], keys = new Set<string>();
      if (this.peek()?.raw === "}") { this.take(); return { kind: "object", entries }; }
      do {
        const key = this.take();
        if (key.kind !== "string" && key.kind !== "id") reject("syntax");
        const name = String(key.value ?? key.raw);
        if (!validName(name) || keys.has(name)) reject("unsupported");
        keys.add(name); this.expect(":"); entries.push([name, this.expression(0, depth + 1)]);
        if (entries.length > 32) reject("size");
        if (this.peek()?.raw === "}") { this.take(); return { kind: "object", entries }; }
        this.expect(",");
      } while (this.peek());
      return reject("syntax");
    }
    if (token.kind === "state") return { kind: "state", name: token.raw };
    if (token.kind === "builtin" || token.kind === "id") {
      const name = String(token.value);
      if (this.peek()?.raw !== "(") {
        if (token.kind === "builtin" || !validName(name)) reject("unsupported");
        return { kind: "ref", name };
      }
      const builtin = token.kind === "builtin";
      if (!(builtin ? functions : names).has(name)) reject("unsupported");
      this.take(); const args = this.list(")", depth);
      if (args.length > 16) reject("size");
      return { kind: "call", name, builtin, args };
    }
    return reject("syntax");
  }
  private list(end: string, depth: number): Expr[] {
    const values: Expr[] = [];
    if (this.peek()?.raw === end) { this.take(); return values; }
    do {
      values.push(this.expression(0, depth + 1));
      if (values.length > ANSWER_LIMITS.array) reject("size");
      if (this.peek()?.raw === end) { this.take(); return values; }
      this.expect(",");
    } while (this.peek());
    return reject("syntax");
  }
}

function statements(tokens: Token[]): Statement[] {
  const result: Statement[] = [], ids = new Set<string>();
  let group: Token[] = [], brackets: string[] = [];
  const finish = () => {
    if (!group.length) return;
    const [name, equal, ...expression] = group; group = [];
    if (!["id", "state"].includes(name.kind) || !validName(String(name.value)) || equal?.raw !== "=" || !expression.length) reject("syntax");
    if (ids.has(name.raw)) reject("references");
    if (expression.length > ANSWER_LIMITS.expressionTokens) reject("size");
    ids.add(name.raw);
    result.push({ name: name.raw, state: name.kind === "state", expr: new ExpressionParser(expression).parse() });
    if (result.length > ANSWER_LIMITS.statements) reject("size");
  };
  for (const token of tokens) {
    if (token.kind === "newline") { if (!brackets.length) finish(); continue; }
    if (["(", "[", "{"].includes(token.raw)) brackets.push(token.raw);
    if ([")", "]", "}"].includes(token.raw)) {
      if (brackets.pop() !== ({ ")": "(", "]": "[", "}": "{" } as Record<string, string>)[token.raw]) reject("syntax");
    }
    if (brackets.length > ANSWER_LIMITS.depth) reject("size");
    group.push(token);
  }
  if (brackets.length) reject("syntax");
  finish(); return result;
}
function children(expr: Expr): Expr[] {
  switch (expr.kind) {
    case "call": return expr.args;
    case "array": return expr.values;
    case "object": return expr.entries.map(([, value]) => value);
    case "unary": return [expr.value];
    case "binary": return [expr.left, expr.right];
    case "conditional": return [expr.condition, expr.yes, expr.no];
    default: return [];
  }
}
function serialize(expr: Expr): string {
  switch (expr.kind) {
    case "literal": return JSON.stringify(expr.value);
    case "ref": case "state": return expr.name;
    case "call": return `${expr.builtin ? "@" : ""}${expr.name}(${expr.args.map(serialize).join(", ")})`;
    case "array": return `[${expr.values.map(serialize).join(", ")}]`;
    case "object": return `{${expr.entries.map(([key, value]) => `${JSON.stringify(key)}: ${serialize(value)}`).join(", ")}}`;
    case "unary": return `(${expr.op}${serialize(expr.value)})`;
    case "binary": return `(${serialize(expr.left)} ${expr.op} ${serialize(expr.right)})`;
    case "conditional": return `(${serialize(expr.condition)} ? ${serialize(expr.yes)} : ${serialize(expr.no)})`;
  }
}

type NumericRange = readonly [number, number];
/** The upstream evaluator coerces invalid numeric inputs and zero divisors to 0.
 * Refuse those ambiguous programs instead of displaying a plausible wrong result. */
function checkCalculations(all: Statement[], defaults: AnswerState, controls: Map<string, NumericRange>): void {
  const values = new Map(all.map(item => [item.name, item.expr]));
  const resolveArray = (expr: Expr): Expr[] | null => expr.kind === "array" ? expr.values : expr.kind === "ref" ? resolveArray(values.get(expr.name)!) : null;
  const numeric = (expr: Expr): boolean => {
    switch (expr.kind) {
      case "literal": return typeof expr.value === "number";
      case "state": return typeof defaults[expr.name] === "number";
      case "ref": return numeric(values.get(expr.name)!);
      case "unary": return expr.op !== "!" && numeric(expr.value);
      case "binary": return ["+", "-", "*", "/", "%"].includes(expr.op) && numeric(expr.left) && numeric(expr.right);
      case "conditional": return numeric(expr.yes) && numeric(expr.no);
      case "call": return expr.builtin;
      default: return false;
    }
  };
  const unknown: NumericRange = [-Infinity, Infinity];
  const range = (expr: Expr): NumericRange => {
    if (expr.kind === "literal" && typeof expr.value === "number") return [expr.value, expr.value];
    if (expr.kind === "state") return controls.get(expr.name) ?? (typeof defaults[expr.name] === "number" ? [defaults[expr.name] as number, defaults[expr.name] as number] : unknown);
    if (expr.kind === "ref") return range(values.get(expr.name)!);
    if (expr.kind === "unary") { const [lo, hi] = range(expr.value); return expr.op === "-" ? [-hi, -lo] : expr.op === "+" ? [lo, hi] : unknown; }
    if (expr.kind === "binary") {
      const [a, b] = range(expr.left), [c, d] = range(expr.right);
      if (expr.op === "+") return [a + c, b + d];
      if (expr.op === "-") return [a - d, b - c];
      const results = expr.op === "*" ? [a * c, a * d, b * c, b * d] : expr.op === "/" && (c > 0 || d < 0) ? [a / c, a / d, b / c, b / d] : [];
      return results.length && results.every(Number.isFinite) ? [Math.min(...results), Math.max(...results)] : unknown;
    }
    if (expr.kind === "call" && expr.builtin) {
      if (["Min", "Max", "Sum", "Avg", "Count"].includes(expr.name)) {
        const list = expr.args[0] && resolveArray(expr.args[0]);
        if (!list) return unknown;
        if (expr.name === "Count") return [list.length, list.length];
        if (!list.length) return expr.name === "Sum" ? [0, 0] : unknown;
        const ranges = list.map(range), lows = ranges.map(value => value[0]), highs = ranges.map(value => value[1]);
        if (expr.name === "Max") return [Math.max(...lows), Math.max(...highs)];
        if (expr.name === "Min") return [Math.min(...lows), Math.min(...highs)];
        const divisor = expr.name === "Avg" ? list.length : 1;
        return [lows.reduce((sum, value) => sum + value, 0) / divisor, highs.reduce((sum, value) => sum + value, 0) / divisor];
      }
      if (!expr.args[0]) return unknown;
      const [lo, hi] = range(expr.args[0]);
      if (expr.name === "Abs") return [lo <= 0 && hi >= 0 ? 0 : Math.min(Math.abs(lo), Math.abs(hi)), Math.max(Math.abs(lo), Math.abs(hi))];
      if (expr.name === "Floor") return [Math.floor(lo), Math.floor(hi)];
      if (expr.name === "Ceil") return [Math.ceil(lo), Math.ceil(hi)];
    }
    return unknown;
  };
  const branchProofs = (condition: Expr, truthy: boolean, proofs: Set<string>): Set<string> => {
    const next = new Set(proofs);
    if (condition.kind === "unary" && condition.op === "!") return branchProofs(condition.value, !truthy, next);
    if (condition.kind !== "binary") return next;
    if ((condition.op === "&&" && truthy) || (condition.op === "||" && !truthy)) return branchProofs(condition.right, truthy, branchProofs(condition.left, truthy, next));
    const zeroLeft = condition.left.kind === "literal" && condition.left.value === 0;
    const zeroRight = condition.right.kind === "literal" && condition.right.value === 0;
    if ((zeroLeft || zeroRight) && (truthy ? [">", "<", "!="].includes(condition.op) : [">=", "<=", "=="].includes(condition.op))) next.add(serialize(zeroLeft ? condition.right : condition.left));
    return next;
  };
  const visit = (expr: Expr, proofs: Set<string>): void => {
    if (expr.kind === "call" && expr.builtin) {
      const aggregate = ["Count", "Sum", "Avg", "Min", "Max"].includes(expr.name);
      if (aggregate) {
        const list = expr.args[0] && resolveArray(expr.args[0]);
        if (expr.args.length !== 1 || !list || (expr.name !== "Count" && list.some(value => !numeric(value))) || (["Avg", "Min", "Max"].includes(expr.name) && !list.length)) reject("unsupported");
      } else {
        if (!expr.args[0] || !numeric(expr.args[0]) || expr.args.length > (expr.name === "Round" ? 2 : 1)) reject("unsupported");
        if (expr.args[1] && (expr.args[1].kind !== "literal" || typeof expr.args[1].value !== "number" || !Number.isInteger(expr.args[1].value) || expr.args[1].value < 0 || expr.args[1].value > 6)) reject("unsupported");
      }
    }
    if (expr.kind === "binary") {
      if (["-", "*", "/", "%", ">", "<", ">=", "<="].includes(expr.op) && (!numeric(expr.left) || !numeric(expr.right))) reject("unsupported");
      if (["/", "%"].includes(expr.op)) {
        const [lo, hi] = range(expr.right);
        if (!proofs.has(serialize(expr.right)) && !(lo > 0 || hi < 0)) reject("unsupported");
      }
      if (expr.op === "&&" || expr.op === "||") {
        visit(expr.left, proofs); visit(expr.right, branchProofs(expr.left, expr.op === "&&", proofs)); return;
      }
    }
    if (expr.kind === "conditional") {
      visit(expr.condition, proofs); visit(expr.yes, branchProofs(expr.condition, true, proofs)); visit(expr.no, branchProofs(expr.condition, false, proofs)); return;
    }
    for (const child of children(expr)) visit(child, proofs);
  };
  for (const statement of all) visit(statement.expr, new Set());
}

/** Validate before the upstream parser can recursively expand references. */
export function checkInteractiveProgram(raw: string): ProgramCheck {
  try {
    if (raw.length > ANSWER_LIMITS.bytes || new TextEncoder().encode(raw).length > ANSWER_LIMITS.bytes) reject("size");
    const all = statements(lex(raw)), byName = new Map(all.map(item => [item.name, item]));
    if (!byName.has("root")) reject("syntax");
    const defaults: AnswerState = Object.create(null);
    for (const statement of all.filter(item => item.state)) {
      // State stays primitive; no user-controlled object graphs or action expressions.
      let value: AnswerValue | null;
      if (statement.expr.kind === "literal") value = statement.expr.value;
      else if (statement.expr.kind === "unary" && ["-", "+"].includes(statement.expr.op) && statement.expr.value.kind === "literal" && typeof statement.expr.value.value === "number") value = statement.expr.op === "-" ? -statement.expr.value.value : statement.expr.value.value;
      else reject("unsupported");
      if (value === null || (typeof value === "string" && value.length > 256)) reject("unsupported");
      defaults[statement.name] = value;
    }
    if (Object.keys(defaults).length > ANSWER_LIMITS.states) reject("size");
    const controlRanges = new Map<string, NumericRange>();
    const inspectControls = (expr: Expr, depth = 0): void => {
      if (depth > ANSWER_LIMITS.depth) reject("size");
      if (expr.kind === "call" && ["Slider", "NumberInput", "Select", "Toggle"].includes(expr.name)) {
        const binding = expr.args[0];
        if (binding?.kind !== "state" || !Object.hasOwn(defaults, binding.name)) reject("unsupported");
        const value = defaults[binding.name];
        if (expr.name === "Select") {
          const options = expr.args[2];
          if (typeof value !== "string" || options?.kind !== "array" || !options.values.length || options.values.some(option => option.kind !== "literal" || typeof option.value !== "string") || !options.values.some(option => option.kind === "literal" && option.value === value)) reject("unsupported");
        } else if (expr.name === "Toggle") {
          if (typeof value !== "boolean") reject("unsupported");
        } else {
          if (typeof value !== "number") reject("unsupported");
          const scalar = (node: Expr | undefined): number | undefined => {
            if (!node) return undefined;
            if (node.kind === "literal" && typeof node.value === "number") return node.value;
            if (node.kind === "unary" && node.op === "-" && node.value.kind === "literal" && typeof node.value.value === "number") return -node.value.value;
            return reject("unsupported");
          };
          const min = scalar(expr.args[2]), max = scalar(expr.args[3]), step = scalar(expr.args[4]);
          if ((expr.name === "Slider" && (min === undefined || max === undefined)) || (min !== undefined && value < min) || (max !== undefined && value > max) || (min !== undefined && max !== undefined && min > max) || (step !== undefined && step <= 0)) reject("unsupported");
          const existing = controlRanges.get(binding.name);
          controlRanges.set(binding.name, [Math.min(existing?.[0] ?? Infinity, min ?? -1e12), Math.max(existing?.[1] ?? -Infinity, max ?? 1e12)]);
        }
      }
      for (const child of children(expr)) inspectControls(child, depth + 1);
    };
    for (const statement of all) inspectControls(statement.expr);
    type Budget = { nodes: number; text: number; depth: number };
    const memo = new Map<string, Budget>(), visiting = new Set<string>();
    const measureStatement = (name: string): Budget => {
      if (visiting.has(name)) reject("references");
      const cached = memo.get(name); if (cached) return cached;
      const item = byName.get(name); if (!item) reject("references");
      visiting.add(name); const budget = measure(item.expr, 0); visiting.delete(name); memo.set(name, budget); return budget;
    };
    const measure = (expr: Expr, depth: number): Budget => {
      if (depth > ANSWER_LIMITS.depth || visiting.size > ANSWER_LIMITS.depth) reject("size");
      if (expr.kind === "ref" || expr.kind === "state") {
        if (expr.kind === "state" && !Object.hasOwn(defaults, expr.name)) reject("references");
        return measureStatement(expr.name);
      }
      const budget = { nodes: 1, text: expr.kind === "literal" && typeof expr.value === "string" ? expr.value.length : 0, depth: 1 };
      for (const child of children(expr)) {
        const part = measure(child, depth + 1); budget.nodes += part.nodes; budget.text += part.text; budget.depth = Math.max(budget.depth, part.depth + 1);
        if (budget.nodes > ANSWER_LIMITS.expandedNodes || budget.text > ANSWER_LIMITS.expandedText || budget.depth > ANSWER_LIMITS.depth) reject("size");
      }
      return budget;
    };
    let nodes = 0, text = 0;
    for (const statement of all) { const budget = measureStatement(statement.name); nodes += budget.nodes; text += budget.text; }
    if (nodes > ANSWER_LIMITS.expandedNodes || text > ANSWER_LIMITS.expandedText) reject("size");
    checkCalculations(all, defaults, controlRanges);
    // Structural minimum only: a dependency does not prove semantic value.
    // Follow root references after the cycle/depth/expansion checks above.
    const bound = new Set<string>(), output = new Set<string>();
    const inspectInteraction = (expr: Expr): void => {
      if (expr.kind === "state") { output.add(expr.name); return; }
      if (expr.kind === "ref") { inspectInteraction(byName.get(expr.name)!.expr); return; }
      if (expr.kind === "call" && ["Slider", "NumberInput", "Select", "Toggle"].includes(expr.name)) {
        bound.add((expr.args[0] as Extract<Expr, { kind: "ref" | "state" }>).name);
        // Binding, label, and range changes alone are not a result.
        return;
      }
      for (const child of children(expr)) inspectInteraction(child);
    };
    inspectInteraction(byName.get("root")!.expr);
    if (!bound.size || Object.keys(defaults).some(name => !bound.has(name) || !output.has(name))) reject("unsupported");
    const source = all.map(item => `${item.name} = ${serialize(item.expr)}`).join("\n");
    if (new TextEncoder().encode(source).length > ANSWER_LIMITS.bytes) reject("size");
    return { ok: true, source, defaults: { ...defaults } };
  } catch (error) {
    return { ok: false, reason: error instanceof InvalidProgram ? error.reason : "syntax" };
  }
}

/** A streaming Markdown parser also emits unclosed fences; do not run those. */
export function isClosedInteractiveFence(raw: string): boolean {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const first = /^ {0,3}(`{3,}|~{3,})ccgui-ui[ \t]*$/.exec(lines[0] ?? "");
  if (!first || lines.length < 2) return false;
  const last = lines.at(-1)?.trim() ?? "";
  return last.length >= first[1].length && [...last].every(char => char === first[1][0]);
}
