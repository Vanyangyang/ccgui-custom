/**
 * Promote a formula that owns its paragraph to display math.
 *
 * remark-math follows the micromark grammar, where `$$` only opens a display
 * (flow) formula when it ends the line — a single-line `$$\frac{a}{b}$$` is
 * text math and renders inline. Models routinely write exactly that on a line
 * of its own, and an inline render wedges a full formula into the paragraph
 * flow instead of centering it as a block: the "formula looks misplaced"
 * complaint. A paragraph whose only content is math is a display formula in
 * intent, whichever delimiter count the model picked.
 */

interface MdastNode {
  type: string;
  value?: string;
  meta?: string | null;
  children?: MdastNode[];
  data?: Record<string, unknown>;
}

/** The mdast → hast bridge for math lives in the node's own `data`
 *  (`mdast-util-math` attaches it while parsing: `<pre><code class=
 *  "language-math math-display">`). A synthesized node has to carry the same
 *  payload or the renderer drops the formula entirely. */
function displayMathNode(tex: string): MdastNode {
  return {
    type: "math",
    meta: null,
    value: tex,
    data: {
      hName: "pre",
      hChildren: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-display"] },
          children: [{ type: "text", value: tex }],
        },
      ],
    },
  };
}

function promote(parent: MdastNode): void {
  const children = parent.children;
  if (!children) return;
  parent.children = children.map((child) => {
    if (child.type !== "paragraph") {
      promote(child);
      return child;
    }
    const meaningful = (child.children ?? []).filter(
      (node) => !(node.type === "text" && (node.value ?? "").trim() === ""),
    );
    const only = meaningful.length === 1 ? meaningful[0] : null;
    if (only && only.type === "inlineMath") {
      return displayMathNode(only.value ?? "");
    }
    promote(child);
    return child;
  });
}

export function remarkDisplayMath() {
  return (tree: MdastNode) => {
    promote(tree);
  };
}
