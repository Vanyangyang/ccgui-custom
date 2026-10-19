/**
 * Text preparation for remark-math.
 *
 * remark-math follows the micromark grammar, which knows two delimiters: `$`
 * and `$$`. Two things models write have to be rewritten before the markdown
 * parse — and both have to leave code spans and fenced blocks alone, because
 * their backslashes and dollars are content:
 *
 * 1. LaTeX delimiters. Display math arrives as `\[ ... \]` and inline math as
 *    `\( ... \)`. remark-math never sees them, so the whole formula rendered
 *    as raw TeX in prose.
 * 2. Nested math-mode dollars. Real LaTeX lets a box command take math mode as
 *    its argument: `\colorbox{yellow}{$\displaystyle \int x\,dx$}` — the inner
 *    `$...$` is valid and KaTeX needs to see it. remark-math cannot: it ends
 *    the outer `$...$` at the first inner `$`, splitting one formula into a
 *    KaTeX error, a raw-TeX text leak, and a stray `}` span. Inside math a `$`
 *    is never a delimiter — it is a nested math-mode marker or an escaped
 *    literal — so the walker hides the nested ones behind a private
 *    placeholder and restores them right before KaTeX reads the TeX.
 */

export const NESTED_DOLLAR = "\uE000";

/** The delimiter that ends the math span the walker is inside. */
type Closer = "$" | "$$" | "\\)" | "\\]";

/** Rewrite the delimiters remark-math does not know, and hide the nested
 *  dollars it would otherwise end a formula on. */
export function prepareMathText(text: string): string {
  if (!text.includes("$") && !text.includes("\\")) return text;
  const out: string[] = [];
  let mode: "none" | "inline" | "display" = "none";
  let closer: Closer = "$";
  let depth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (mode !== "none") {
      if (ch === "\\") {
        // `\)` / `\]` end the span LaTeX opened with `\(` / `\[`; every other
        // backslash pair is TeX the engine needs verbatim (`\frac`, `\,`, …).
        if (closer.length === 2 && text[i + 1] === closer[1]) {
          mode = "none";
          out.push(closer === "\\)" ? "$" : "$$");
        } else {
          out.push(ch);
          if (i + 1 < n) out.push(text[i + 1]);
        }
        i += 2;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        out.push(ch);
        i += 1;
        continue;
      }
      if (ch === "}") {
        depth = Math.max(0, depth - 1);
        out.push(ch);
        i += 1;
        continue;
      }
      if (ch === "$") {
        if (closer === "$$" && text[i + 1] === "$" && depth === 0) {
          mode = "none";
          out.push("$$");
          i += 2;
        } else if (closer === "$" && depth === 0) {
          mode = "none";
          out.push("$");
          i += 1;
        } else {
          // Inside a command argument (or a lone dollar in display math)
          // this is a nested math-mode marker — keep it for KaTeX, hide it
          // from remark-math.
          out.push(NESTED_DOLLAR);
          i += 1;
        }
        continue;
      }
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === "`") {
      let run = 0;
      while (i + run < n && text[i + run] === "`") run += 1;
      const backticks = "`".repeat(run);
      i += run;
      if (run >= 3) {
        // Fenced block: copy verbatim through the closing fence line.
        const rest = text.slice(i);
        const close = rest.search(/\n`{3,}[ \t]*(?=\n|$)/);
        if (close === -1) {
          out.push(backticks + rest);
          i = n;
        } else {
          out.push(backticks + rest.slice(0, close));
          i += close;
        }
      } else {
        // Code span: copy verbatim through a run of the same length.
        const rest = text.slice(i);
        const close = rest.indexOf("`".repeat(run));
        if (close === -1) {
          out.push(backticks + rest);
          i = n;
        } else {
          out.push(backticks + rest.slice(0, close + run));
          i += close + run;
        }
      }
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "(") {
        mode = "inline";
        closer = "\\)";
        depth = 0;
        out.push("$");
        i += 2;
        continue;
      }
      if (next === "[") {
        mode = "display";
        closer = "\\]";
        depth = 0;
        out.push("$$");
        i += 2;
        continue;
      }
      out.push(ch);
      if (i + 1 < n) out.push(next);
      i += 2;
      continue;
    }
    if (ch === "$") {
      if (text[i + 1] === "$") {
        mode = "display";
        closer = "$$";
        out.push("$$");
        i += 2;
      } else {
        mode = "inline";
        closer = "$";
        out.push("$");
        i += 1;
      }
      depth = 0;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

/** Replace the placeholder back to a literal `$` (used on the hast tree,
 *  right before KaTeX renders the TeX). */
export function restoreNestedMathDollars(text: string): string {
  return text.includes(NESTED_DOLLAR)
    ? text.split(NESTED_DOLLAR).join("$")
    : text;
}

/** A hast node shape small enough for the restore walk: text leaves carry
 *  the TeX, elements carry children. */
export interface HastMathNode {
  type: string;
  value?: string;
  children?: HastMathNode[];
}

function restoreTextDollars(node: HastMathNode): void {
  if (node.type === "text" && typeof node.value === "string") {
    node.value = restoreNestedMathDollars(node.value);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child && typeof child === "object") restoreTextDollars(child);
    }
  }
}

/** rehype plugin registered before rehype-katex: every placeholder that
 *  survived the markdown parse into a math node is a nested dollar the TeX
 *  needs. Plain text never contains the placeholder, so a global replace is
 *  safe. */
export function restoreMathDollars() {
  return (tree: HastMathNode) => {
    restoreTextDollars(tree);
  };
}
