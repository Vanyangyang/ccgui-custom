import type { ModelOption } from "./cli-menu";
import type { EffortLevel } from "./effort-levels";

export const AGY_ENCODED_EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh"];
const AGY_EFFORT_SUFFIX = new RegExp(`-(${AGY_ENCODED_EFFORT_LEVELS.join("|")})$`, "i");

/** AGY encodes these levels in model IDs and suppresses the separate --effort
 * argument (engine/agy.rs::model_encodes_effort). Other engines keep their IDs. */
export function encodedModelEffort(engine: string, modelId: string): EffortLevel | undefined {
  if (engine !== "agy") return undefined;
  return AGY_EFFORT_SUFFIX.exec(modelId)?.[1].toLowerCase() as EffortLevel | undefined;
}

/** Native AGY models with no user-selectable effort tier. */
export function modelHasNoEffort(engine: string, modelId: string): boolean {
  if (engine !== "agy") return false;
  const normalized = modelId.trim().toLowerCase();
  return normalized === "gemini-pro-orchestrator" || normalized === "gemini-pro-orchestrator-argon";
}

export function supportsIndependentModelEffort(engine: string, modelId: string): boolean {
  return !modelHasNoEffort(engine, modelId) && !encodedModelEffort(engine, modelId);
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
  for (const model of models) {
    const effort = encodedModelEffort(engine, model.id);
    if (!effort) {
      rows.push({ key: model.id, model });
      continue;
    }
    const label = modelBaseLabel(engine, model);
    const key = JSON.stringify([model.provider, model.id.replace(AGY_EFFORT_SUFFIX, ""), label]);
    let row = grouped.get(key);
    if (!row) {
      row = { key, model: { ...model, label }, variants: [] };
      grouped.set(key, row);
      rows.push(row);
    }
    row.variants!.push({ model, effort });
  }
  for (const row of rows) row.variants?.sort((a, b) => AGY_ENCODED_EFFORT_LEVELS.indexOf(a.effort) - AGY_ENCODED_EFFORT_LEVELS.indexOf(b.effort));
  return rows;
}
