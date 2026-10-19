import { describe, expect, it } from "vitest";
import { createRevealPlan } from "./reveal-plan";

/** Minimal hast builders — the plugin only reads `type`/`tagName`/`value`/
 *  `properties.className`, so a full syntax tree would add noise. */
const el = (tagName: string, children: unknown[], className?: string[]) => ({
  type: "element",
  tagName,
  properties: className ? { className } : {},
  children,
});
const text = (value: string) => ({ type: "text", value });

function root(children: unknown[]) {
  return { type: "root", children } as never;
}

/** The unified transformer signature also takes a VFile; this transform only
 *  reads the tree, so a stub keeps the call sites honest about that. */
const stubFile = {} as never;
const runPlan = (plan: ReturnType<typeof createRevealPlan>, tree: unknown) =>
  plan.plugin()(tree as never, stubFile);

describe("reveal plan and typeset math", () => {
  it("wraps plain text runs with stream offsets", () => {
    const plan = createRevealPlan();
    const tree = root([el("p", [text("前"), text("后")])]);
    runPlan(plan, tree);

    const paragraph = (tree as { children: { children: unknown[] }[] }).children[0];
    const [first, second] = paragraph.children as {
      tagName: string;
      properties: { dataStreamStart?: number };
    }[];
    expect(first.tagName).toBe("span");
    expect(first.properties.dataStreamStart).toBe(0);
    expect(second.properties.dataStreamStart).toBe(1);
    expect(plan.text).toBe("前后");
  });

  it("leaves a typeset formula untouched", () => {
    // Streaming reveal must not inject spans into KaTeX's markup: its layout
    // CSS addresses children by class/position, and the reveal spans would
    // also render the formula as a moving prefix instead of a whole formula.
    const plan = createRevealPlan();
    const katex = el("span", [text("x^2")], ["katex"]);
    const tree = root([el("p", [text("前"), katex, text("后")])]);
    runPlan(plan, tree);

    const paragraph = (tree as { children: { children: unknown[] }[] }).children[0];
    const [, middle] = paragraph.children as { tagName: string; properties: Record<string, unknown> }[];
    // Untouched node: still the katex span, its text not re-parented.
    expect(middle.tagName).toBe("span");
    expect(middle.properties.dataStreamStart).toBeUndefined();
    expect((middle as unknown as { children: { type: string }[] }).children[0].type).toBe("text");
    // The formula's characters stay out of the reveal pacing.
    expect(plan.text).toBe("前后");
  });
});
