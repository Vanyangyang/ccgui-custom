/**
 * Token arithmetic shared by the usage page. The ledger stores four
 * non-overlapping parts (see `parseUsage`), so their sum is the turn's true
 * total — `UsageRow` and the page's own folds both fit this helper.
 */

export interface TokenParts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Everything the turn spent: fresh input, output, and cache traffic. */
export const tokensOf = (e: TokenParts) => e.input + e.output + e.cacheRead + e.cacheWrite;
