/** Cursor 把同一模型的上下文、推理和 Fast 收成参数，不把每个组合拆成独立模型。 */

export interface CursorParameterOption {
  value: string;
  name: string;
}

export interface CursorParameter {
  id: string;
  name: string;
  current?: string;
  options: CursorParameterOption[];
}

export interface CursorModel {
  id: string;
  name: string;
  parameters: CursorParameter[];
}

export type CursorParamValues = Record<string, string>;

const PINS_KEY = "ccgui.cursor.visible-models";
const PARAMS_KEY = "ccgui.cursor.model-parameters";
export const CURSOR_PREFS_EVENT = "ccgui-cursor-model-prefs";
/** 只出现在发往 CLI 的模型参数里，不会写进会话记忆。 */
export const CURSOR_LAUNCH_SEPARATOR = "\u001e";

const EFFORT_IDS = ["reasoning_effort", "effort", "reasoning"];
const SUFFIXES = ["-extra-high", "-xhigh", "-thinking", "-minimal", "-medium", "-high", "-fast", "-low", "-max", "-none"];

let published: CursorModel[] = [];

export function publishCursorCatalog(models: CursorModel[]): void {
  published = models;
}

export function publishedCursorCatalog(): CursorModel[] {
  return published;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function notify(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CURSOR_PREFS_EVENT));
}

export function readCursorPins(): string[] {
  try {
    const parsed = JSON.parse(storage()?.getItem(PINS_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

export function writeCursorPins(pins: string[]): void {
  const unique = [...new Set(pins.filter(Boolean))];
  storage()?.setItem(PINS_KEY, JSON.stringify(unique));
  notify();
}

export function readCursorParams(): Record<string, CursorParamValues> {
  try {
    const parsed = JSON.parse(storage()?.getItem(PARAMS_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, CursorParamValues> = {};
    for (const [id, values] of Object.entries(parsed)) {
      if (!values || typeof values !== "object" || Array.isArray(values)) continue;
      const params: CursorParamValues = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === "string" && value) params[key] = value;
      }
      out[id] = params;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeCursorModelParams(modelId: string, values: CursorParamValues): void {
  const all = readCursorParams();
  all[modelId] = values;
  storage()?.setItem(PARAMS_KEY, JSON.stringify(all));
  notify();
}

export function parameterById(model: CursorModel | undefined, id: string): CursorParameter | undefined {
  return model?.parameters.find((parameter) => parameter.id === id);
}

export function effortParameter(model: CursorModel | undefined): CursorParameter | undefined {
  return model?.parameters.find((parameter) => EFFORT_IDS.includes(parameter.id) && parameter.options.length >= 2);
}

/** 勾选的模型排在前面，同组保持目录顺序。 */
export function orderCursorModels(models: CursorModel[], pins: readonly string[], query: string): CursorModel[] {
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? models.filter((model) => model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle))
    : models;
  const pinned = new Set(pins);
  return filtered
    .map((model, index) => ({ model, index, pin: pinned.has(model.id) }))
    .sort((a, b) => Number(b.pin) - Number(a.pin) || a.index - b.index)
    .map((entry) => entry.model);
}

export function matchCursorBase(id: string, models: readonly CursorModel[]): CursorModel | undefined {
  const direct = models.find((model) => model.id === id || (model.id === "default" && (id === "auto" || id === "default")));
  if (direct) return direct;
  const bases = [...models].filter((model) => model.id !== "default").sort((a, b) => b.id.length - a.id.length);
  const slug = bases.find((model) => id.startsWith(`${model.id}-`));
  if (slug) return slug;
  const labels = models.filter((model) => paramsFromReportedLabel(id, model) !== null);
  return labels.length === 1 ? labels[0] : undefined;
}

/** Older runs saved the CLI's display label. Resolve only catalog-backed names
 * and complete known option labels; never guess an executable id from prose. */
function paramsFromReportedLabel(label: string, model: CursorModel): CursorParamValues | null {
  const normalized = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const name = normalized(model.name);
  let rest = normalized(label);
  if (rest === name) return {};
  if (!rest.startsWith(`${name} `)) return null;
  rest = rest.slice(name.length).trim();
  const values: CursorParamValues = {};
  const choices = model.parameters.flatMap((parameter) => parameter.options.flatMap((option) =>
    [option.name, option.value].map((token) => ({ id: parameter.id, value: option.value, token: normalized(token) })),
  )).filter((choice) => choice.token).sort((a, b) => b.token.length - a.token.length);
  while (rest) {
    const choice = choices.find(({ id, token }) => !Object.hasOwn(values, id) && (rest === token || rest.startsWith(`${token} `)));
    if (!choice) return null;
    values[choice.id] = choice.value;
    rest = rest.slice(choice.token.length).trim();
  }
  for (const id of ["fast", "thinking"]) {
    if (!Object.hasOwn(values, id) && parameterById(model, id)?.options.some((option) => option.value === "false")) values[id] = "false";
  }
  return values;
}

function stripSuffixes(rest: string): string[] {
  const tokens: string[] = [];
  let current = rest;
  while (current.startsWith("-")) {
    const suffix = SUFFIXES.find((item) => current.endsWith(item));
    if (!suffix) break;
    tokens.unshift(suffix.slice(1));
    current = current.slice(0, -suffix.length);
  }
  return current.length === 0 ? tokens : [];
}

function effortValue(parameter: CursorParameter, token: string): string | undefined {
  const aliases: Record<string, string[]> = {
    xhigh: ["xhigh", "extra-high"],
    "extra-high": ["extra-high", "xhigh"],
  };
  const candidates = aliases[token] ?? [token];
  return candidates.find((value) => parameter.options.some((option) => option.value === value));
}

/** 旧目录把 high/fast 写进模型 id。只在还没有保存过参数时，用来还原这一次选择。 */
export function inferParamsFromSlug(slug: string, model: CursorModel): CursorParamValues {
  if (slug === model.id || slug === "auto") return {};
  const reported = paramsFromReportedLabel(slug, model);
  if (reported) return reported;
  const tokens = stripSuffixes(slug.slice(model.id.length));
  if (tokens.length === 0) return {};
  const values: CursorParamValues = {};
  const fast = parameterById(model, "fast");
  const thinking = parameterById(model, "thinking");
  const effort = effortParameter(model);
  if (fast && fast.options.length >= 2) values.fast = tokens.includes("fast") ? "true" : "false";
  if (thinking && thinking.options.length >= 2) values.thinking = tokens.includes("thinking") ? "true" : "false";
  if (effort) {
    const token = tokens.find((item) => item !== "fast" && item !== "thinking");
    const value = token ? effortValue(effort, token) : undefined;
    if (value) values[effort.id] = value;
  }
  return values;
}

export function seedCursorParamsFromSlug(slug: string, model: CursorModel): void {
  const saved = readCursorParams()[model.id];
  if (saved && Object.keys(saved).length > 0) return;
  const inferred = inferParamsFromSlug(slug, model);
  if (Object.keys(inferred).length > 0) writeCursorModelParams(model.id, inferred);
}

export function effectiveCursorParams(model: CursorModel, saved: CursorParamValues | undefined): CursorParamValues {
  const values: CursorParamValues = {};
  for (const parameter of model.parameters) {
    if (parameter.options.length < 2) continue;
    // Text and ACP catalogs use different ids for the same effort control.
    const chosen = saved?.[parameter.id] ?? (EFFORT_IDS.includes(parameter.id)
      ? EFFORT_IDS.map((id) => saved?.[id]).find((value) => value !== undefined) : undefined);
    const current = parameter.current;
    const value = [chosen, current, parameter.options[0]?.value].find(
      (item) => item && parameter.options.some((option) => option.value === item),
    );
    if (value) values[parameter.id] = value;
  }
  return values;
}

export function cursorContextTokens(model: CursorModel | undefined, saved: CursorParamValues | undefined): number | undefined {
  if (!model) return undefined;
  const value = effectiveCursorParams(model, saved).context;
  const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value ?? "");
  if (!match) return undefined;
  const tokens = Math.round(Number(match[1]) * (match[2].toLowerCase() === "m" ? 1_000_000 : 1_000));
  return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined;
}

export function cursorModelSummary(model: CursorModel, saved: CursorParamValues | undefined): string {
  const values = effectiveCursorParams(model, saved);
  const effort = effortParameter(model);
  const effortName = effort?.options.find((option) => option.value === values[effort.id])?.name;
  const fast = values.fast === "true";
  return [model.name, effortName, fast ? "Fast" : ""].filter(Boolean).join(" ");
}

export function encodeCursorLaunchModel(modelId: string, params: CursorParamValues): string {
  const entries = Object.entries(params).filter(([, value]) => value);
  // 【cursor模型】没有参数也要带上分隔符，否则 CLI 会继续用上一个模型的上下文和 Fast。
  return `${modelId}${CURSOR_LAUNCH_SEPARATOR}${JSON.stringify(Object.fromEntries(entries))}`;
}

export function cursorLaunchModel(stored: string | null | undefined): string | null {
  if (!stored) return stored ?? null;
  const model = matchCursorBase(stored, published);
  if (!model) return stored;
  // Remember legacy label options before canonical model memory replaces the
  // label, so the second turn cannot fall back to the catalog defaults.
  seedCursorParamsFromSlug(stored, model);
  const saved = readCursorParams()[model.id] ?? inferParamsFromSlug(stored, model);
  return encodeCursorLaunchModel(model.id, effectiveCursorParams(model, saved));
}

export function cursorRememberedModel(stored: string | null | undefined): string | null {
  if (!stored) return stored ?? null;
  return matchCursorBase(stored, published)?.id ?? stored;
}

function baseLabel(label: string): string {
  // 【cursor模型】标签末尾的努力档和 Fast 不属于模型名。
  return label
    .replace(/(?:\s+(?:Extra High|No Thinking|Minimal|Medium|Thinking|High|Fast|None|Max|Low))+$/i, "")
    .replace(/\s+1M$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parameter(id: string, name: string, options: CursorParameterOption[]): CursorParameter {
  return { id, name, options };
}

/** ACP 目录还没到时，先把 `models` 文本行收成基础模型，避免按努力档铺开。 */
export function collapseCursorModels(rows: { id: string; label: string }[]): CursorModel[] {
  const groups = new Map<string, { name: string; tokens: Set<string> }>();
  const order: string[] = [];
  for (const row of rows) {
    let rest = row.id;
    const tokens = new Set<string>();
    let stripped = true;
    while (stripped) {
      stripped = false;
      const suffix = SUFFIXES.find((item) => rest.endsWith(item) && rest.length > item.length);
      if (!suffix) break;
      tokens.add(suffix.slice(1));
      rest = rest.slice(0, -suffix.length);
      stripped = true;
    }
    const id = rest || row.id;
    const existing = groups.get(id);
    const name = baseLabel(row.label) || id;
    if (!existing) {
      groups.set(id, { name, tokens });
      order.push(id);
    } else {
      for (const token of tokens) existing.tokens.add(token);
      if (name.length < existing.name.length) existing.name = name;
    }
  }
  return order.map((id) => {
    const group = groups.get(id)!;
    const parameters: CursorParameter[] = [];
    const effortTokens = ["low", "medium", "high", "xhigh", "extra-high", "max", "none", "minimal"].filter((token) => group.tokens.has(token));
    if (effortTokens.length >= 2) {
      parameters.push(parameter("effort", "Effort", effortTokens.map((token) => ({
        value: token,
        name: token === "xhigh" || token === "extra-high" ? "Extra High" : token[0].toUpperCase() + token.slice(1),
      }))));
    }
    if (group.tokens.has("thinking")) {
      parameters.push(parameter("thinking", "Thinking", [{ value: "false", name: "Off" }, { value: "true", name: "Thinking" }]));
    }
    if (group.tokens.has("fast")) {
      parameters.push(parameter("fast", "Fast", [{ value: "false", name: "Off" }, { value: "true", name: "Fast" }]));
    }
    return { id, name: group.name, parameters };
  });
}
