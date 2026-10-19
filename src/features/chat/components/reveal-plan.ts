import type rehypeHighlight from "rehype-highlight";
type Transform = ReturnType<typeof rehypeHighlight>;
type Tree = Parameters<Transform>[0];
type Element = Extract<Tree["children"][number], { type: "element" }>;

/** This plan belongs to one committed Markdown snapshot. Clone highlighted
 * trees before wrapping: their children may be shared by the highlight cache.
 * Never insert spans between table rows/cells or other structural elements.
 */
export function createRevealPlan() {
  const plan = { text: "", plugin: () => transform };
  const textParents = new Set(["p", "span", "strong", "em", "del", "a", "code", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "blockquote", "div"]);
  /** Typeset math must not be touched: wrapping text inside KaTeX's own spans
   *  injects elements its layout CSS does not expect (it addresses children
   *  by position and class), and a formula is atomic — it can never be
   *  revealed character by character anyway. */
  const isOpaque = (node: Element) => {
    const classes = (node.properties?.className as unknown[]) ?? [];
    return classes.some(
      (name) => name === "katex" || name === "katex-display" || name === "katex-html",
    );
  };
  const transform: Transform = tree => {
    let offset = 0;
    const parts: string[] = [];
    function children(parent: Tree | Element): Element["children"] {
      return parent.children.map(node => {
        if (node.type === "element") {
          if (isOpaque(node)) return node;
          return { ...node, children: children(node) };
        }
        if (node.type !== "text" || parent.type !== "element" || !textParents.has(parent.tagName)) return node;
        const start = offset;
        offset += node.value.length;
        parts.push(node.value);
        return { type: "element", tagName: "span", properties: { dataStreamStart: start }, children: [node] } as Element;
      }) as Element["children"];
    }
    tree.children = children(tree);
    plan.text = parts.join("");
  };
  return plan;
}
