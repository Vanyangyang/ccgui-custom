/**
 * 受限条件表达式求值（不允许 eval）。
 *
 * 语法：`clause ( or clause )*`，clause = `key=value | key!=value`，
 * `and` 的优先级高于 `or`；关键字 `default` 表示「同组其他条件都不匹配时」，
 * 由调度器在比较整组出边时处理，不在这里求值。
 *
 * 上下文值是上游输出与运行设置的扁平视图（risk、approval、verification…），
 * 比较统一按字符串进行；键不存在时子句为 false（不臆断取值）。
 */

export const DEFAULT_CONDITION = "default";

interface ParsedClause {
  key: string;
  negate: boolean;
  value: string;
}

interface ParsedExpression {
  /** 子句组（or 连接），每组内部是 and 连接。 */
  groups: ParsedClause[][];
}

export function isDefaultCondition(condition: string | undefined): boolean {
  return condition === undefined || condition.trim() === "" || condition.trim() === DEFAULT_CONDITION;
}

function parseClause(raw: string): ParsedClause | null {
  // 值必须是单个无空白 token：避免 `risk=high or` 这类尾巴被当成值。
  const match = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*(!=|=)\s*(\S+)$/);
  if (!match) return null;
  return { key: match[1], negate: match[2] === "!=", value: match[3] };
}

export function parseCondition(condition: string): ParsedExpression | null {
  const groups: ParsedClause[][] = [];
  for (const orPart of condition.split(/\s+or\s+/i)) {
    const clauses: ParsedClause[] = [];
    for (const andPart of orPart.split(/\s+and\s+/i)) {
      const clause = parseClause(andPart);
      if (!clause) return null;
      clauses.push(clause);
    }
    groups.push(clauses);
  }
  return groups.length > 0 ? { groups } : null;
}

/** 值域取值：先查顶层键，再查 `settings.` 前缀（运行设置的显式写法）。 */
function resolveValue(context: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(context, key)) return context[key];
  if (key.startsWith("settings.")) {
    const flat = context.settings;
    if (flat && typeof flat === "object") {
      return (flat as Record<string, unknown>)[key.slice("settings.".length)];
    }
  }
  return undefined;
}

function matchesClause(clause: ParsedClause, context: Record<string, unknown>): boolean {
  const raw = resolveValue(context, clause.key);
  if (raw === undefined || raw === null) return false;
  const equals = String(raw) === clause.value;
  return clause.negate ? !equals : equals;
}

/** 非 default 条件求值；default 由调用方另行处理。表达式非法时返回 false。 */
export function evaluateCondition(
  condition: string | undefined,
  context: Record<string, unknown>,
): boolean {
  if (isDefaultCondition(condition)) return false;
  const parsed = parseCondition(condition!);
  if (!parsed) return false;
  return parsed.groups.some((group) => group.every((clause) => matchesClause(clause, context)));
}

/** 供 AI 提示与校验使用：条件语法是否合法。 */
export function isValidCondition(condition: string | undefined): boolean {
  if (isDefaultCondition(condition)) return true;
  return parseCondition(condition!) !== null;
}
