import type { ModelOption } from "./cli-menu";
import type { EffortLevel } from "./effort-levels";

/** AGY encodes these levels in model IDs and suppresses the separate --effort
 * argument (engine/agy.rs::model_encodes_effort). Other engines keep their IDs. */
export function encodedModelEffort(engine: string, modelId: string): EffortLevel | undefined {
  if (engine !== "agy") return undefined;
  return /-(low|medium|high)$/i.exec(modelId)?.[1].toLowerCase() as EffortLevel | undefined;
}

export function modelBaseLabel(engine: string, model: ModelOption): string {
  const effort = encodedModelEffort(engine, model.id);
  if (!effort) return model.label;
  const suffix = new RegExp(`\\s*\\(${effort}\\)$`, "i");
  return model.label.replace(suffix, "");
}

export interface ModelChoiceRow {
  key: string;
  model: ModelOption;
  variants?: { model: ModelOption; effort: EffortLevel }[];
}

/** Presentation only: selection always sends the original catalog model ID.
 * Called within each provider group and after search, so providers and exact
 * ID matches remain isolated. Never manufactures a level absent from the list. */
export function modelChoiceRows(engine: string, models: ModelOption[]): ModelChoiceRow[] {
  const rows: ModelChoiceRow[] = [];
  const grouped = new Map<string, ModelChoiceRow>();
  const order = ["low", "medium", "high"];
  for (const model of models) {
    const effort = encodedModelEffort(engine, model.id);
    if (!effort) {
      rows.push({ key: model.id, model });
      continue;
    }
    const label = modelBaseLabel(engine, model);
    const key = JSON.stringify([model.provider, model.id.replace(/-(low|medium|high)$/i, ""), label]);
    let row = grouped.get(key);
    if (!row) {
      row = { key, model: { ...model, label }, variants: [] };
      grouped.set(key, row);
      rows.push(row);
    }
    row.variants!.push({ model, effort });
  }
  for (const row of rows) row.variants?.sort((a, b) => order.indexOf(a.effort) - order.indexOf(b.effort));
  return rows;
}
