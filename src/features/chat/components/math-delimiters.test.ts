import { describe, expect, it } from "vitest";
import {
  NESTED_DOLLAR,
  prepareMathText,
  restoreNestedMathDollars,
} from "./math-delimiters";

describe("prepareMathText", () => {
  it("turns LaTeX display delimiters into the `$$` remark-math knows", () => {
    // The shape gpt/codex actually emits for a display formula.
    const src = "原式：\n\\[\n\\sigma_{\\mathrm{总}}(t,S_t,X_t)\n\\]\n解释在后。";
    const out = prepareMathText(src);
    expect(out).toContain("$$\n\\sigma_{\\mathrm{总}}(t,S_t,X_t)\n$$");
    expect(out).not.toContain("\\[");
    expect(out).not.toContain("\\]");
  });

  it("turns LaTeX inline delimiters into `$`", () => {
    const src = "当 \\(x > 0\\) 时收敛";
    expect(prepareMathText(src)).toBe("当 $x > 0$ 时收敛");
  });

  it("leaves an escaped backslash before a bracket alone", () => {
    const src = "字面量 \\\\[1\\\\] 表示方括号";
    expect(prepareMathText(src)).toBe(src);
  });

  it("leaves LaTeX delimiters in code alone", () => {
    const fenced = "```tex\n\\[x^2\\]\n```";
    expect(prepareMathText(fenced)).toBe(fenced);
    const span = "用 `\\[x\\]` 匹配";
    expect(prepareMathText(span)).toBe(span);
  });

  it("hides boxed math-mode dollars from remark-math and restores them", () => {
    const src =
      "颜色测试：$\\nabla_\\theta \\mathcal{L} 与 \\colorbox{yellow}{$\\displaystyle \\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$}$";
    const out = prepareMathText(src);
    // Only the outer delimiter pair survives as `$`; the inner pair is hidden.
    expect(out.split("$").length).toBe(3);
    expect(out).toContain(NESTED_DOLLAR);
    expect(restoreNestedMathDollars(out)).toBe(src);
  });

  it("hides nested dollars in display math too", () => {
    const src = "$$\\hat{p} = \\mathrm{softmax}(Wh + b) \\quad \\colorbox{green}{$x^2$}$$";
    const out = prepareMathText(src);
    expect(out.split("$$").length).toBe(3);
    expect(out).toContain(NESTED_DOLLAR);
    expect(restoreNestedMathDollars(out)).toBe(src);
  });

  it("leaves plain math without nesting untouched", () => {
    const src = "能量守恒 $E = mc^2$ 收尾";
    expect(prepareMathText(src)).toBe(src);
  });

  it("leaves dollars in fenced code blocks alone", () => {
    const src = "```sh\necho $HOME\n```";
    expect(prepareMathText(src)).toBe(src);
  });

  it("leaves dollars in inline code spans alone", () => {
    const src = "run `echo $HOME` now";
    expect(prepareMathText(src)).toBe(src);
  });

  it("keeps an escaped dollar inside math", () => {
    const src = "$\\$5 + x = 6$";
    expect(prepareMathText(src)).toBe(src);
  });

  it("pairs unboxed dollars simply like remark-math", () => {
    const src = "价格 $5 和 $10 元";
    expect(prepareMathText(src)).toBe(src);
  });

  it("returns fast for text without dollars or backslashes", () => {
    expect(prepareMathText("没有美元符号")).toBe("没有美元符号");
  });
});
