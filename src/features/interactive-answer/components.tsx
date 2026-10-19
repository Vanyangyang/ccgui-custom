import {
  defineComponent,
  reactive,
  tagSchemaId,
  useIsStreaming,
  useStateField,
} from "@openuidev/react-lang";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { z } from "zod/v4";
import { Switch } from "@/components/base/switch/switch";
import { ChevronDownSmall } from "@/components/foundations/icons/chevrons";
import { cx } from "@/utils/cx";
import { ANSWER_LIMITS } from "./protocol";
import "./interactive-answer.css";

/* -------------------------------------------------------------------------- */
/*  Runtime defensive bounds & helpers                                        */
/* -------------------------------------------------------------------------- */

const MAX_CHILDREN = ANSWER_LIMITS.array; // 64
const MAX_OPTIONS = ANSWER_LIMITS.array; // 64
const MAX_TABLE_COLS = 16;
const MAX_TABLE_ROWS = ANSWER_LIMITS.array; // 64
const MAX_CHART_ITEMS = 32;
const MAX_TEXT_LEN = ANSWER_LIMITS.string; // 2000
const MAX_LABEL_LEN = 200;
const MAX_UNIT_LEN = 40;
const MAX_ABS_NUM = 1e12;
const CHART_COLOR_COUNT = 8;

const nodeSchema = z.any();
tagSchemaId(nodeSchema, "Node");
const childrenSchema = z.array(nodeSchema);

/** Clamp and sanitize untrusted model strings to plain text only. */
function safeText(value: unknown, maxLen: number = MAX_TEXT_LEN): string {
  if (value == null) return "";
  if (typeof value === "string") {
    return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? formatNumber(value) : "—";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return "";
}

/** Return a finite number within safe bounds, or the fallback. */
function finiteOr(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.max(-MAX_ABS_NUM, Math.min(MAX_ABS_NUM, num));
}

/** Return an optional finite number if valid, otherwise undefined. */
function optionalFinite(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(-MAX_ABS_NUM, Math.min(MAX_ABS_NUM, value));
}

function clampNumber(value: number, min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.min(hi, Math.max(lo, value));
}

function clampOptional(value: number, min?: number, max?: number): number {
  let lo = min;
  let hi = max;
  if (lo !== undefined && hi !== undefined && lo > hi) {
    [lo, hi] = [hi, lo];
  }
  let res = value;
  if (lo !== undefined) res = Math.max(lo, res);
  if (hi !== undefined) res = Math.min(hi, res);
  return res;
}

/** Format numbers cleanly for display without trailing float noise. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Object.is(value, -0)) return "0";
  return value.toLocaleString(undefined, { maximumFractionDigits: Math.abs(value) >= 100 ? 2 : 4 });
}

function boundedArray<T>(value: unknown, max: number): T[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max) as T[];
}

function useFieldKey(label: unknown, statementId?: string): string {
  const id = useId();
  const cleanLabel = safeText(label, 80);
  return statementId || cleanLabel || id;
}

/* -------------------------------------------------------------------------- */
/*  Layout & Presentation Components                                          */
/* -------------------------------------------------------------------------- */

export const Stack = defineComponent({
  name: "Stack",
  props: z.object({
    children: childrenSchema,
    gap: z.enum(["small", "normal", "large"]).optional(),
  }),
  description: "Vertical layout container; gap is small, normal, or large.",
  component: ({ props, renderNode }) => {
    const gap = props.gap === "small" || props.gap === "large" ? props.gap : "normal";
    const items = boundedArray(props.children, MAX_CHILDREN);
    return (
      <div className={cx("interactive-answer ia-stack", `ia-stack-${gap}`)}>
        {renderNode(items)}
      </div>
    );
  },
});

export const Grid = defineComponent({
  name: "Grid",
  props: z.object({
    children: childrenSchema,
    columns: z.number().int().min(1).max(3).optional(),
  }),
  description: "Responsive 1 to 3 column grid that collapses to 1 column at <=480px.",
  component: ({ props, renderNode }) => {
    const rawCols = finiteOr(props.columns, 2);
    const cols = clampNumber(Math.round(rawCols), 1, 3);
    const items = boundedArray(props.children, MAX_CHILDREN);
    return (
      <div
        className={cx("ia-grid", `ia-grid-cols-${cols}`)}
        data-columns={cols}
      >
        {renderNode(items)}
      </div>
    );
  },
});

export const Card = defineComponent({
  name: "Card",
  props: z.object({
    children: childrenSchema,
    tone: z.enum(["plain", "accent", "subtle"]).optional(),
  }),
  description: "Grouped surface container with plain, accent, or subtle tone.",
  component: ({ props, renderNode }) => {
    const tone =
      props.tone === "accent" || props.tone === "subtle" ? props.tone : "plain";
    const items = boundedArray(props.children, MAX_CHILDREN);
    return (
      <section className={cx("ia-card", `ia-card-${tone}`)} data-tone={tone}>
        {renderNode(items)}
      </section>
    );
  },
});

export const Heading = defineComponent({
  name: "Heading",
  props: z.object({
    text: z.string(),
    size: z.enum(["sm", "md", "lg"]).optional(),
  }),
  description: "Section heading in sm, md, or lg size.",
  component: ({ props }) => {
    const size = props.size === "sm" || props.size === "lg" ? props.size : "md";
    const text = safeText(props.text, MAX_LABEL_LEN);
    if (!text) return null;
    const Tag = size === "lg" ? "h3" : size === "md" ? "h4" : "h5";
    return <Tag className={cx("ia-heading", `ia-heading-${size}`)}>{text}</Tag>;
  },
});

export const Text = defineComponent({
  name: "Text",
  props: z.object({
    text: z.string(),
    tone: z.enum(["default", "muted"]).optional(),
  }),
  description: "Plain text paragraph in default or muted tone.",
  component: ({ props }) => {
    const tone = props.tone === "muted" ? "muted" : "default";
    const text = safeText(props.text, MAX_TEXT_LEN);
    if (!text) return null;
    return <p className={cx("ia-text", `ia-text-${tone}`)}>{text}</p>;
  },
});

export const Metric = defineComponent({
  name: "Metric",
  props: z.object({
    label: z.string(),
    value: z.union([z.number(), z.string()]),
    unit: z.string().optional(),
    detail: z.string().optional(),
  }),
  description: "Prominent numeric or text metric readout with label, optional unit, and optional detail.",
  component: ({ props }) => {
    const label = safeText(props.label, MAX_LABEL_LEN);
    const displayValue =
      typeof props.value === "number"
        ? Number.isFinite(props.value)
          ? formatNumber(props.value)
          : "—"
        : safeText(props.value, MAX_LABEL_LEN) || "—";
    const unit = safeText(props.unit, MAX_UNIT_LEN);
    const detail = safeText(props.detail, MAX_LABEL_LEN);
    return (
      <div className="ia-metric">
        {label && <div className="ia-metric-label">{label}</div>}
        <div className="ia-metric-value-row">
          <span className="ia-metric-value">{displayValue}</span>
          {unit && <span className="ia-metric-unit">{unit}</span>}
        </div>
        {detail && <div className="ia-metric-detail">{detail}</div>}
      </div>
    );
  },
});

export const Badge = defineComponent({
  name: "Badge",
  props: z.object({
    text: z.string(),
    tone: z.enum(["neutral", "positive", "warning"]).optional(),
  }),
  description: "Status or category badge in neutral, positive, or warning tone.",
  component: ({ props }) => {
    const tone =
      props.tone === "positive" || props.tone === "warning"
        ? props.tone
        : "neutral";
    const text = safeText(props.text, MAX_LABEL_LEN);
    if (!text) return null;
    return (
      <span className={cx("ia-badge", `ia-badge-${tone}`)} data-tone={tone}>
        {text}
      </span>
    );
  },
});

export const Divider = defineComponent({
  name: "Divider",
  props: z.object({}),
  description: "Horizontal divider line.",
  component: () => <hr className="ia-divider" />,
});

/* -------------------------------------------------------------------------- */
/*  Interactive Controls                                                      */
/* -------------------------------------------------------------------------- */

export const Slider = defineComponent({
  name: "Slider",
  props: z.object({
    value: reactive(z.number()),
    label: z.string(),
    min: z.number(),
    max: z.number(),
    step: z.number().optional(),
    unit: z.string().optional(),
  }),
  description: "Range slider input bound to a numeric $state variable.",
  component: function SliderControl({ props, statementId }) {
    const inputId = useId();
    const fieldKey = useFieldKey(props.label, statementId);
    const field = useStateField(fieldKey, props.value);
    const streaming = useIsStreaming();

    const rawMin = finiteOr(props.min, 0);
    const rawMax = finiteOr(props.max, 100);
    const safeMin = Math.min(rawMin, rawMax);
    const safeMax = Math.max(rawMin, rawMax);
    const span = safeMax - safeMin;
    const rawStep = optionalFinite(props.step);
    const safeStep =
      rawStep !== undefined && rawStep > 0 && (span === 0 || rawStep <= span)
        ? rawStep
        : span > 0 && span < 1
          ? Number((span / 100).toPrecision(4))
          : 1;

    const currentValue = clampNumber(
      finiteOr(field.value, safeMin),
      safeMin,
      safeMax,
    );
    const pct = span > 0 ? ((currentValue - safeMin) / span) * 100 : 0;
    const label = safeText(props.label, MAX_LABEL_LEN);
    const unit = safeText(props.unit, MAX_UNIT_LEN);
    const formattedValue = formatNumber(currentValue);
    const readout = unit ? `${formattedValue} ${unit}` : formattedValue;

    return (
      <div className="ia-field">
        <div className="ia-field-header">
          <label htmlFor={inputId} className="ia-field-label">
            {label}
          </label>
          <output htmlFor={inputId} className="ia-field-readout">
            {readout}
          </output>
        </div>
        <input
          id={inputId}
          type="range"
          className="ia-slider-input"
          min={safeMin}
          max={safeMax}
          step={safeStep}
          value={currentValue}
          disabled={streaming}
          aria-label={label || undefined}
          aria-valuemin={safeMin}
          aria-valuemax={safeMax}
          aria-valuenow={currentValue}
          aria-valuetext={readout}
          style={{ "--ia-slider-pct": `${pct}%` } as CSSProperties}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (!Number.isFinite(next)) return;
            field.setValue(clampNumber(next, safeMin, safeMax));
          }}
        />
        <div className="ia-slider-bounds" aria-hidden="true">
          <span>{unit ? `${formatNumber(safeMin)} ${unit}` : formatNumber(safeMin)}</span>
          <span>{unit ? `${formatNumber(safeMax)} ${unit}` : formatNumber(safeMax)}</span>
        </div>
      </div>
    );
  },
});

export const NumberInput = defineComponent({
  name: "NumberInput",
  props: z.object({
    value: reactive(z.number()),
    label: z.string(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    unit: z.string().optional(),
  }),
  description: "Number input bound to a numeric $state variable; preserves 0 and handles blank editing safely.",
  component: function NumberInputControl({ props, statementId }) {
    const inputId = useId();
    const fieldKey = useFieldKey(props.label, statementId);
    const field = useStateField(fieldKey, props.value);
    const streaming = useIsStreaming();

    let safeMin = optionalFinite(props.min);
    let safeMax = optionalFinite(props.max);
    if (safeMin !== undefined && safeMax !== undefined && safeMin > safeMax) {
      [safeMin, safeMax] = [safeMax, safeMin];
    }
    const rawStep = optionalFinite(props.step);
    const safeStep = rawStep !== undefined && rawStep > 0 ? rawStep : undefined;

    const fallback = safeMin !== undefined && safeMin > 0 ? safeMin : 0;
    const committedValue = clampOptional(
      finiteOr(field.value, fallback),
      safeMin,
      safeMax,
    );

    const [draft, setDraft] = useState<string>(() => String(committedValue));
    const lastCommittedRef = useRef<number>(committedValue);

    useEffect(() => {
      if (!Object.is(committedValue, lastCommittedRef.current)) {
        lastCommittedRef.current = committedValue;
        const parsedDraft = draft.trim() === "" ? NaN : Number(draft.trim());
        if (!Object.is(parsedDraft, committedValue)) {
          setDraft(String(committedValue));
        }
      }
    }, [committedValue, draft]);

    const label = safeText(props.label, MAX_LABEL_LEN);
    const unit = safeText(props.unit, MAX_UNIT_LEN);

    return (
      <div className="ia-field">
        {label && (
          <div className="ia-field-header">
            <label htmlFor={inputId} className="ia-field-label">
              {label}
            </label>
          </div>
        )}
        <div className="ia-input-shell" data-disabled={streaming ? "true" : undefined}>
          <input
            id={inputId}
            type="number"
            inputMode="decimal"
            className="ia-number-input"
            value={draft}
            min={safeMin}
            max={safeMax}
            step={safeStep ?? "any"}
            disabled={streaming}
            aria-label={label || undefined}
            onChange={(e) => {
              const raw = e.target.value;
              setDraft(raw);
              const trimmed = raw.trim();
              if (
                trimmed === "" ||
                trimmed === "-" ||
                trimmed === "+" ||
                trimmed === "." ||
                trimmed === "-."
              ) {
                return;
              }
              const parsed = Number(trimmed);
              if (!Number.isFinite(parsed)) return;
              const clamped = clampOptional(finiteOr(parsed, committedValue), safeMin, safeMax);
              lastCommittedRef.current = clamped;
              field.setValue(clamped);
            }}
            onBlur={() => {
              const trimmed = draft.trim();
              const parsed = trimmed === "" ? NaN : Number(trimmed);
              if (Number.isFinite(parsed)) {
                const clamped = clampOptional(finiteOr(parsed, committedValue), safeMin, safeMax);
                lastCommittedRef.current = clamped;
                field.setValue(clamped);
                setDraft(String(clamped));
              } else {
                setDraft(String(committedValue));
              }
            }}
          />
          {unit && <span className="ia-input-unit">{unit}</span>}
        </div>
      </div>
    );
  },
});

export const Select = defineComponent({
  name: "Select",
  props: z.object({
    value: reactive(z.string()),
    label: z.string(),
    options: z.array(z.string()),
  }),
  description: "Dropdown select control bound to a string $state variable.",
  component: function SelectControl({ props, statementId }) {
    const selectId = useId();
    const fieldKey = useFieldKey(props.label, statementId);
    const field = useStateField(fieldKey, props.value);
    const streaming = useIsStreaming();

    const label = safeText(props.label, MAX_LABEL_LEN);
    const rawOptions = boundedArray<unknown>(props.options, MAX_OPTIONS);
    const options: string[] = [];
    const seen = new Set<string>();
    for (const item of rawOptions) {
      const text = safeText(item, MAX_LABEL_LEN);
      if (text && !seen.has(text)) {
        seen.add(text);
        options.push(text);
      }
    }

    const currentRaw = safeText(field.value, MAX_LABEL_LEN);
    const currentValue =
      options.includes(currentRaw)
        ? currentRaw
        : options[0] ?? currentRaw;

    return (
      <div className="ia-field">
        {label && (
          <div className="ia-field-header">
            <label htmlFor={selectId} className="ia-field-label">
              {label}
            </label>
          </div>
        )}
        <div className="ia-select-shell" data-disabled={streaming ? "true" : undefined}>
          <select
            id={selectId}
            className="ia-select-native"
            value={currentValue}
            disabled={streaming || options.length === 0}
            aria-label={label || undefined}
            onChange={(e) => {
              field.setValue(e.target.value);
            }}
          >
            {options.length === 0 ? (
              <option value="">—</option>
            ) : (
              options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))
            )}
          </select>
          <ChevronDownSmall className="ia-select-chevron size-4" />
        </div>
      </div>
    );
  },
});

export const Toggle = defineComponent({
  name: "Toggle",
  props: z.object({
    value: reactive(z.boolean()),
    label: z.string(),
  }),
  description: "Boolean toggle switch bound to a boolean $state variable.",
  component: function ToggleControl({ props, statementId }) {
    const fieldKey = useFieldKey(props.label, statementId);
    const field = useStateField(fieldKey, props.value);
    const streaming = useIsStreaming();

    const checked = Boolean(field.value);
    const label = safeText(props.label, MAX_LABEL_LEN);

    return (
      <div className="ia-toggle-row">
        <Switch
          size="sm"
          isSelected={checked}
          isDisabled={streaming}
          aria-label={label || undefined}
          onChange={(next) => field.setValue(Boolean(next))}
          className="ia-toggle-switch"
        >
          {label}
        </Switch>
      </div>
    );
  },
});

/* -------------------------------------------------------------------------- */
/*  Data Display: Table & BarChart                                            */
/* -------------------------------------------------------------------------- */

export const Table = defineComponent({
  name: "Table",
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))),
  }),
  description: "Scrollable data table with string column headers and scalar rows.",
  component: ({ props }) => {
    const columns = boundedArray<unknown>(props.columns, MAX_TABLE_COLS).map((col) =>
      safeText(col, MAX_LABEL_LEN),
    );
    const rows = boundedArray<unknown>(props.rows, MAX_TABLE_ROWS).map((row) =>
      boundedArray<unknown>(row, Math.max(columns.length, MAX_TABLE_COLS)).map((cell) =>
        safeText(cell, MAX_TEXT_LEN),
      ),
    );

    if (columns.length === 0 && rows.length === 0) return null;

    const colCount = Math.max(
      columns.length,
      rows.reduce((max, r) => Math.max(max, r.length), 0),
    );

    return (
      <div className="ia-table-scroll">
        <table className="ia-table">
          {columns.length > 0 && (
            <thead>
              <tr>
                {Array.from({ length: colCount }, (_, i) => (
                  <th key={i} scope="col">
                    {columns[i] ?? ""}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((row, rIdx) => (
              <tr key={rIdx}>
                {Array.from({ length: colCount }, (_, cIdx) => (
                  <td key={cIdx}>{row[cIdx] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
});

export const BarChart = defineComponent({
  name: "BarChart",
  props: z.object({
    title: z.string(),
    items: z.array(
      z.object({
        label: z.string(),
        value: z.number(),
      }),
    ),
    unit: z.string().optional(),
  }),
  description: "Horizontal bar chart for up to 32 items with honest negative value display.",
  component: ({ props }) => {
    const title = safeText(props.title, MAX_LABEL_LEN);
    const unit = safeText(props.unit, MAX_UNIT_LEN);
    const rawItems = boundedArray<unknown>(props.items, MAX_CHART_ITEMS);

    const items: { label: string; value: number | null }[] = [];
    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const itemLabel = safeText(rec.label, MAX_LABEL_LEN);
      const itemValue = typeof rec.value === "number" && Number.isFinite(rec.value) ? rec.value : null;
      items.push({ label: itemLabel || "—", value: itemValue });
    }

    if (items.length === 0) return null;

    const scale = Math.max(1, ...items.map(item => Math.abs(item.value ?? 0)));
    const minVal = Math.min(0, ...items.map((d) => (d.value ?? 0) / scale));
    const maxVal = Math.max(0, ...items.map((d) => (d.value ?? 0) / scale));
    const hasNegative = minVal < 0;
    const totalSpan = maxVal - minVal || 1;
    const zeroPct = hasNegative ? ((0 - minVal) / totalSpan) * 100 : 0;

    return (
      <div className="ia-chart" role="group" aria-label={title || undefined}>
        {(title || unit) && (
          <div className="ia-chart-header">
            {title && <div className="ia-chart-title">{title}</div>}
            {unit && <div className="ia-chart-unit">{unit}</div>}
          </div>
        )}
        <div className="ia-chart-list" role="list">
          {items.map((item, idx) => {
            const formatted = item.value === null ? "—" : formatNumber(item.value);
            const valueWithUnit = unit ? `${formatted} ${unit}` : formatted;
            const normalized = (item.value ?? 0) / scale;
            const isNeg = normalized < 0;
            const barWidthPct = (Math.abs(normalized) / totalSpan) * 100;
            const barLeftPct = hasNegative
              ? isNeg
                ? ((normalized - minVal) / totalSpan) * 100
                : zeroPct
              : 0;
            const colorVar = `var(--color-chart-${(idx % CHART_COLOR_COUNT) + 1})`;

            return (
              <div key={`${idx}-${item.label}`} className="ia-chart-row" role="listitem">
                <div className="ia-chart-row-meta">
                  <span className="ia-chart-item-label">{item.label}</span>
                  <span className="ia-chart-item-value">{valueWithUnit}</span>
                </div>
                <div className="ia-chart-track" aria-hidden="true">
                  {hasNegative && (
                    <div
                      className="ia-chart-zero-line"
                      style={{ left: `${zeroPct}%` }}
                    />
                  )}
                  <div
                    className={cx(
                      "ia-chart-fill",
                      isNeg && "ia-chart-fill-negative",
                    )}
                    style={{
                      left: `${barLeftPct}%`,
                      width: `${barWidthPct}%`,
                      backgroundColor: colorVar,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
});

export const answerComponents = [
  Stack,
  Grid,
  Card,
  Heading,
  Text,
  Metric,
  Badge,
  Divider,
  Slider,
  NumberInput,
  Select,
  Toggle,
  Table,
  BarChart,
];
