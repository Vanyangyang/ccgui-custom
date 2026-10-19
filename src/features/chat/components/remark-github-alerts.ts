/**
 * GitHub-style blockquote alerts (`> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` /
 * `[!WARNING]` / `[!CAUTION]`), rendered as callout cards.
 *
 * The marker line is removed at the MDAST layer on purpose: reveal-plan
 * aggregates `plan.text` from the HAST text nodes it can see, so deleting the
 * marker here keeps the reveal offsets aligned with the DOM without touching
 * StreamReveal/RevealText. `blockquote` is already in reveal-plan's
 * textParents, so the alert body still reveals character by character.
 *
 * CommonMark merges adjacent `>` quotes that only have a quoted blank
 * line between them, so five `> [!NOTE]` … `> [!TIP]` blocks become one
 * blockquote. Subsequent marker paragraphs (and leftover `> [!TYPE]`
 * text mashed into the previous body) are split back into their own cards.
 *
 * While a row is streaming, a marker may arrive split across frames
 * (`> [!NO` … `> [!NOTE]`). A partial-prefix marker that is still the whole
 * first line (no following body yet) gets its text blanked the same way, so
 * the raw marker never flashes on screen as plain text; the next re-parse
 * upgrades it to the full marker and the card appears.
 *
 * A partial marker that already has a following line is left alone: streaming
 * only appends, so `]` cannot appear before an existing newline, and eating
 * that line would drop characters from a finished quote like
 * `> [!WARNING\n> body`.
 */

export type AlertType = "note" | "tip" | "important" | "warning" | "caution";

const ALERT_TYPES: readonly AlertType[] = [
  "note",
  "tip",
  "important",
  "warning",
  "caution",
];

const ALERT_RE = /^\[!(note|tip|important|warning|caution)\]\s*$/i;

/** Reads the className this plugin stamped onto the blockquote (hast
 *  `properties.className`, or the space-separated React `className` string)
 *  back into the alert type, for the component override in Markdown.tsx. */
export function isAlertClassName(className: unknown): AlertType | null {
  const names = Array.isArray(className)
    ? className.flatMap((item) => String(item).split(/\s+/))
    : typeof className === "string"
      ? className.split(/\s+/)
      : [];
  for (const name of names) {
    if (!name) continue;
    const match = /^md-alert-(note|tip|important|warning|caution)$/.exec(name);
    if (match) return match[1] as AlertType;
  }
  return null;
}

const LEFTOVER_LINE_RE =
  /^\s*>\s*\[!(note|tip|important|warning|caution)\]\s*(.*)$/i;
const LEFTOVER_INLINE_RE =
  /(>\s*)\[!(note|tip|important|warning|caution)\](?:\s+|$)/i;

function matchAlert(line: string): AlertType | null {
  const match = ALERT_RE.exec(line.trim());
  return match ? (match[1].toLowerCase() as AlertType) : null;
}

/** A strict prefix of some `[!TYPE]` marker (a bare `"[!"` counts): what a
 *  streaming row looks like before the marker has fully arrived. */
function isPartialAlert(line: string): boolean {
  const trimmed = line.trim().toLowerCase();
  if (!trimmed.startsWith("[!") || trimmed.endsWith("]")) return false;
  return ALERT_TYPES.some((type) => `[!${type}]`.startsWith(trimmed));
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: Record<string, unknown>;
}

function markAsAlert(quote: MdastNode, type: AlertType): void {
  quote.data = {
    ...quote.data,
    hProperties: {
      ...((quote.data?.hProperties as Record<string, unknown>) ?? {}),
      className: ["md-alert", `md-alert-${type}`],
    },
  };
}

function startsNewLine(node: MdastNode | undefined): boolean {
  if (!node) return false;
  if (node.type === "break") return true;
  return node.type === "text" && (node.value ?? "").startsWith("\n");
}

function dropLeadingLineBreak(nodes: MdastNode[]): MdastNode[] {
  const first = nodes[0];
  if (!first) return nodes;
  if (first.type === "break") return nodes.slice(1);
  if (first.type === "text" && (first.value ?? "").startsWith("\n")) {
    const rest = (first.value ?? "").slice(1);
    if (rest === "") return nodes.slice(1);
    return [{ ...first, value: rest }, ...nodes.slice(1)];
  }
  return nodes;
}

function isEmptyInline(nodes: MdastNode[]): boolean {
  if (nodes.length === 0) return true;
  return nodes.every(
    (node) => node.type === "text" && !(node.value ?? "").trim(),
  );
}

function paragraphToLines(paragraph: MdastNode): MdastNode[][] {
  const lines: MdastNode[][] = [[]];
  const push = (node: MdastNode) => {
    lines[lines.length - 1].push(node);
  };
  for (const node of paragraph.children ?? []) {
    if (node.type === "break") {
      lines.push([]);
      continue;
    }
    const value = node.type === "text" ? (node.value ?? "") : "";
    if (node.type === "text" && value.includes("\n")) {
      const parts = value.split("\n");
      for (let i = 0; i < parts.length; i += 1) {
        if (i > 0) lines.push([]);
        if (parts[i] !== "") push({ type: "text", value: parts[i] });
      }
      continue;
    }
    push(node);
  }
  return lines;
}

function linePlainText(nodes: MdastNode[]): string | null {
  if (nodes.some((node) => node.type !== "text")) return null;
  return nodes.map((node) => node.value ?? "").join("");
}

function extractMarkerLine(
  nodes: MdastNode[],
): { type: AlertType; rest: MdastNode[] } | null {
  const first = nodes[0];
  if (!first || first.type !== "text") return null;
  const value = first.value ?? "";

  const leftover = LEFTOVER_LINE_RE.exec(value);
  if (leftover) {
    const rest: MdastNode[] = [];
    if ((leftover[2] ?? "").trim()) {
      rest.push({ type: "text", value: leftover[2] });
    }
    rest.push(...dropLeadingLineBreak(nodes.slice(1)));
    return { type: leftover[1].toLowerCase() as AlertType, rest };
  }

  const type = matchAlert(value);
  if (!type) return null;
  if (nodes.length > 1 && !startsNewLine(nodes[1])) return null;
  return { type, rest: dropLeadingLineBreak(nodes.slice(1)) };
}

function splitLeftoverMarker(
  nodes: MdastNode[],
): { before: MdastNode[]; type: AlertType; after: MdastNode[] } | null {
  if (nodes.length !== 1 || nodes[0].type !== "text") return null;
  const value = nodes[0].value ?? "";
  const match = LEFTOVER_INLINE_RE.exec(value);
  if (!match || match.index === 0) return null;
  const before = value.slice(0, match.index).trimEnd();
  const after = value.slice(match.index + match[0].length).trimStart();
  return {
    before: before ? [{ type: "text", value: before }] : [],
    type: match[2].toLowerCase() as AlertType,
    after: after ? [{ type: "text", value: after }] : [],
  };
}

function splitBlockquote(quote: MdastNode): MdastNode[] {
  const children = quote.children ?? [];
  const segments: { type: AlertType | null; children: MdastNode[] }[] = [
    { type: null, children: [] },
  ];

  const current = () => segments[segments.length - 1];
  const startAlert = (type: AlertType) => {
    const last = current();
    if (last.type === null && last.children.length === 0) {
      last.type = type;
      return;
    }
    segments.push({ type, children: [] });
  };
  const pushParagraph = (nodes: MdastNode[]) => {
    if (isEmptyInline(nodes)) return;
    current().children.push({ type: "paragraph", children: nodes });
  };
  const appendLine = (nodes: MdastNode[]) => {
    if (isEmptyInline(nodes)) return;
    const kids = current().children;
    const prev = kids[kids.length - 1];
    if (prev?.type === "paragraph") {
      const prevKids = prev.children ?? [];
      prev.children = prevKids.length
        ? [...prevKids, { type: "text", value: "\n" }, ...nodes]
        : nodes;
      return;
    }
    pushParagraph(nodes);
  };

  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const child = children[childIndex];
    if (child.type !== "paragraph") {
      current().children.push(child);
      continue;
    }
    const lines = paragraphToLines(child);
    const lastParagraph = childIndex === children.length - 1;
    // A new MDAST paragraph must stay a new <p>. Only lines split out of
    // the same original paragraph (softbreaks) are joined with appendLine.
    let startedParagraph = false;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const lastLine = lastParagraph && lineIndex === lines.length - 1;
      const plain = linePlainText(line);
      if (plain !== null && lastLine) {
        const partialSource = plain.replace(/^\s*>\s*/, "");
        if (isPartialAlert(partialSource) && matchAlert(partialSource) === null) {
          continue;
        }
      }
      const marker = extractMarkerLine(line);
      if (marker) {
        startAlert(marker.type);
        pushParagraph(marker.rest);
        startedParagraph = !isEmptyInline(marker.rest);
        continue;
      }
      const leftover = splitLeftoverMarker(line);
      if (leftover) {
        if (startedParagraph) appendLine(leftover.before);
        else pushParagraph(leftover.before);
        startAlert(leftover.type);
        pushParagraph(leftover.after);
        startedParagraph = !isEmptyInline(leftover.after);
        continue;
      }
      if (startedParagraph) appendLine(line);
      else {
        pushParagraph(line);
        startedParagraph = true;
      }
    }
  }

  const cleaned = segments.filter(
    (segment) => segment.type !== null || segment.children.length > 0,
  );
  if (cleaned.length === 0) return [{ type: "blockquote", children: [] }];

  return cleaned.map((segment) => {
    const next: MdastNode = { type: "blockquote", children: segment.children };
    if (segment.type) markAsAlert(next, segment.type);
    return next;
  });
}

function walk(node: MdastNode): void {
  const children = node.children;
  if (!children) return;
  const next: MdastNode[] = [];
  for (const child of children) {
    if (child.type === "blockquote") {
      for (const piece of splitBlockquote(child)) {
        walk(piece);
        next.push(piece);
      }
    } else {
      walk(child);
      next.push(child);
    }
  }
  node.children = next;
}

export function remarkGithubAlerts() {
  return (tree: MdastNode) => {
    walk(tree);
  };
}
