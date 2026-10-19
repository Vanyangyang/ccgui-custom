/**
 * Change/issue summaries arrive as append-only string lists with no ids.
 * Derive a stable key from the text itself (duplicates get an ordinal) so
 * React keeps row identity instead of falling back to the array index.
 */
export function keyedLines(
  lines: string[],
): Array<{ key: string; text: string }> {
  const seen = new Map<string, number>();
  return lines.map((text) => {
    const count = seen.get(text) ?? 0;
    seen.set(text, count + 1);
    return { key: count === 0 ? text : `${text}#${count}`, text };
  });
}
