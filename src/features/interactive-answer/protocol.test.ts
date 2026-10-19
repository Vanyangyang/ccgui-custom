import { describe, expect, it } from "vitest";
import { checkInteractiveProgram, isClosedInteractiveFence } from "./protocol";
import { LEGACY_REQUEST_INSTRUCTIONS, stripInteractiveAnswerPrompt, supportsInteractiveAnswer } from "./prompt";
import { cleanAnswerState, clearAnswerState, readAnswerState, writeAnswerState } from "./state";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("interactive answer boundary", () => {
  it("accepts a local calculator and preserves finite zero", () => {
    const result = checkInteractiveProgram('root = Stack([Slider($n, "人数", 0, 50), Metric("合计", @Round(total, 2), "元")])\n$n = 0\ntotal = $n * 120');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.defaults).toEqual({ $n: 0 });
  });
  it.each([
    'root = Text("ok") trailing',
    'root = Text("ok"); fetch("https://example.test")',
    'root = Text("ok")\nignored bad line',
    'root = Text("ok")\nroot = Text("different")',
    'root = Text("abc".constructor)',
    'root = Text($s[0])\n$s = "abc"',
    'root = Text(@Each([1,2], "x", x))',
    'root = Text(@Range(0, 1000000000))',
    'root = Query("tool", {})',
    'root = Text(@OpenUrl("https://example.test"))',
    'root = Text($n = $n + 1)\n$n = 0',
    'root = Text({k: "Num", v: 2})',
    'root = Text({"__proto__": {label: "bad"}})',
    'root = Text({label: "first", label: "second"})',
    'root = Text(missing)',
    'root = Text(a)\na = b\nb = a',
    'root = Text($n)\n$n = total\ntotal = 2',
    'root = Text($n)\n$n = [1, 2]',
    'root = Text($missing)',
  ])("rejects unsupported or malformed programs before runtime: %s", source => {
    expect(checkInteractiveProgram(source).ok).toBe(false);
  });
  it("rejects acyclic exponential expansion and long flat expressions", () => {
    const refs = ['root = Stack(a16)', 'a0 = [Text("x")]'];
    for (let i = 1; i <= 16; i++) refs.push(`a${i} = [a${i - 1}, a${i - 1}]`);
    expect(checkInteractiveProgram(refs.join("\n"))).toEqual({ ok: false, reason: "size" });
    expect(checkInteractiveProgram(`root = Text(${Array(150).fill("1").join(" + ")})`).ok).toBe(false);
  });
  it("rejects oversized data and incomplete strings", () => {
    expect(checkInteractiveProgram(`root = Text("${"x".repeat(33_000)}")`).ok).toBe(false);
    expect(checkInteractiveProgram('root = Text("unfinished)').ok).toBe(false);
    expect(checkInteractiveProgram('root = Text(1e999)').ok).toBe(false);
  });
  it("requires a real matching closing fence", () => {
    expect(isClosedInteractiveFence('```ccgui-ui\nroot = Text("x")\n```')).toBe(true);
    expect(isClosedInteractiveFence('~~~~ccgui-ui\nroot = Text("x")\n~~~~')).toBe(true);
    expect(isClosedInteractiveFence('```ccgui-ui\nroot = Text("x")')).toBe(false);
    expect(isClosedInteractiveFence('````ccgui-ui\nroot = Text("x")\n```')).toBe(false);
  });
  it("accepts the actual GPT budget answer", () => {
    const reply = readFileSync(path.resolve("tests/fixtures/interactive-answer/gpt-budget.md"), "utf8");
    expect(checkInteractiveProgram(reply.split("```ccgui-ui\n")[1].split("\n```")[0]).ok).toBe(true);
  });
  it("accepts the example advertised to ordinary Codex chats", () => {
    const instructions = readFileSync(path.resolve("src/features/interactive-answer/capability-instructions.txt"), "utf8");
    const source = instructions.split("```ccgui-ui\n")[1].split("\n```")[0];
    const result = checkInteractiveProgram(source);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.defaults).toEqual({ $n: 12 });
  });
  it.each(["100 / $n", "100 % $n", "@Min(5, 10)", "@Sum(5)", "@Avg([])", '@Round("oops", 2)'])("rejects expressions the upstream runtime would silently coerce: %s", expression => {
    expect(checkInteractiveProgram(`root = Stack([NumberInput($n, "数量", 0, 10), Metric("结果", ${expression})])\n$n = 1`).ok).toBe(false);
  });
  it("requires a denominator proof covering all controls and the correct branch", () => {
    expect(checkInteractiveProgram('root = Stack([Slider($n, "数量", 1, 10), Metric("结果", 100 / $n)])\n$n = 1').ok).toBe(true);
    expect(checkInteractiveProgram('root = Stack([Slider($n, "数量", 1, 10), NumberInput($n, "数量2", 0, 10), Metric("结果", 100 / $n)])\n$n = 1').ok).toBe(false);
    expect(checkInteractiveProgram('root = Stack([NumberInput($n, "数量", 0, 10), Metric("结果", $n > 0 ? 100 / $n : "—")])\n$n = 1').ok).toBe(true);
    expect(checkInteractiveProgram('root = Stack([NumberInput($n, "数量", 0, 10), Metric("结果", ($n > 0 || true) ? 100 / $n : "—")])\n$n = 1').ok).toBe(false);
    expect(checkInteractiveProgram('root = Stack([NumberInput($n, "数量", 0, 10), Metric("结果", 100 / @Max([1, $n]))])\n$n = 1').ok).toBe(true);
  });
});

describe("interactive answer state and request scope", () => {
  it("renders only for engines that receive the capability instructions", () => {
    expect(["codex", "claude"].every(supportsInteractiveAnswer)).toBe(true);
    expect(["agy", "cursor", "gemini", undefined].some(supportsInteractiveAnswer)).toBe(false);
  });
  it("keeps legacy /ui requests visible while hiding only their own complete instructions", () => {
    const prompt = `/ui 给我一个预算计算器

<ccgui-interactive-answer-v1>
${LEGACY_REQUEST_INSTRUCTIONS}
</ccgui-interactive-answer-v1>`;
    expect(stripInteractiveAnswerPrompt(prompt)).toBe("/ui 给我一个预算计算器");
    expect(stripInteractiveAnswerPrompt('/ui 用户原文\n\n<ccgui-interactive-answer-v1>\n不是宿主说明\n</ccgui-interactive-answer-v1>')).toContain("不是宿主说明");
  });
  it("isolates message/session/program state and filters nonprimitive updates", () => {
    const defaults = { $n: 3, $choice: "a", $on: false };
    writeAnswerState("session-a:1", "program-a", { $n: 0, $choice: "b", $on: true, unknown: "ignored" }, defaults);
    expect(readAnswerState("session-a:1", "program-a", defaults)).toEqual({ $n: 0, $choice: "b", $on: true });
    expect(readAnswerState("session-b:1", "program-a", defaults)).toEqual(defaults);
    expect(readAnswerState("session-a:1", "program-b", defaults)).toEqual(defaults);
    expect(cleanAnswerState({ $n: Infinity, $choice: { value: "unsafe" } }, defaults)).toEqual(defaults);
    clearAnswerState("session-a:1");
    expect(readAnswerState("session-a:1", "program-a", defaults)).toEqual(defaults);
  });
});
