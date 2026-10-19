import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONDITION,
  evaluateCondition,
  isDefaultCondition,
  isValidCondition,
  parseCondition,
} from "../src/features/mission/engine/conditions.ts";

/**
 * 任务工作台条件表达式（连线分流）：受限语法，不允许 eval。
 * conditions.ts 没有运行时依赖，因此可以按项目约定直接用
 * `node --experimental-strip-types --test tests/*.test.ts` 运行。
 */

test("key=value matches only exact string values", () => {
  assert.equal(evaluateCondition("risk=high", { risk: "high" }), true);
  assert.equal(evaluateCondition("risk=high", { risk: "low" }), false);
  assert.equal(evaluateCondition("risk=high", {}), false);
  assert.equal(evaluateCondition("risk=high", { risk: null }), false);
  assert.equal(evaluateCondition("count=3", { count: 3 }), true);
});

test("inequality requires the key to be present", () => {
  assert.equal(evaluateCondition("risk!=high", { risk: "low" }), true);
  assert.equal(evaluateCondition("risk!=high", { risk: "high" }), false);
  assert.equal(evaluateCondition("risk!=high", {}), false);
});

test("and binds tighter than or", () => {
  assert.equal(evaluateCondition("a=1 and b=2", { a: 1, b: 2 }), true);
  assert.equal(evaluateCondition("a=1 and b=2", { a: 1, b: 3 }), false);
  assert.equal(evaluateCondition("a=1 or b=2", { a: 9, b: 2 }), true);
  assert.equal(evaluateCondition("a=1 or b=2", { a: 9, b: 9 }), false);
  // (a=1 and b=2) or c=3 — first group fails, second succeeds.
  assert.equal(evaluateCondition("a=1 and b=2 or c=3", { a: 1, b: 9, c: 3 }), true);
});

test("settings can be referenced directly or through settings.*", () => {
  assert.equal(evaluateCondition("verification=true", { verification: true }), true);
  assert.equal(evaluateCondition("settings.verification=true", { settings: { verification: true } }), true);
  assert.equal(evaluateCondition("settings.approval=all", { settings: { approval: "all" } }), true);
});

test("default is handled by the scheduler, never evaluated here", () => {
  assert.equal(isDefaultCondition(undefined), true);
  assert.equal(isDefaultCondition(""), true);
  assert.equal(isDefaultCondition(DEFAULT_CONDITION), true);
  assert.equal(isDefaultCondition("risk=high"), false);
  assert.equal(evaluateCondition("default", { risk: "high" }), false);
});

test("malformed expressions are rejected and never match", () => {
  assert.equal(isValidCondition("risk=high"), true);
  assert.equal(isValidCondition("risk"), false);
  assert.equal(isValidCondition("=high"), false);
  assert.equal(isValidCondition("risk="), false);
  assert.equal(isValidCondition("risk=high or"), false);
  const parsed = parseCondition("risk=high");
  assert.ok(parsed && parsed.groups.length === 1);
  assert.equal(evaluateCondition("risk=high or", { risk: "high" }), false);
  // 不执行任何宿主环境代码：值里带函数/模板也不会被求值。
  assert.equal(isValidCondition("process.exit()"), false);
  assert.equal(evaluateCondition("process=exit()", {}), false);
});
