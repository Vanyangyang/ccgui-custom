/**
 * How the usage page names a model. The ledger stores whatever the session
 * ran, and a relay setup records the provider-qualified slug the picker
 * launched with ("agentrouter qunyou/deepseek-v4-flash") next to the plain id
 * the engine reports for the same model. The page shows — and sums — the
 * model's own name, so one model is one row and no relay vendor leaks into
 * the totals.
 */

export function modelDisplayName(model: string): string {
  const name = (model ?? "").trim();
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1).trim() : name;
}
