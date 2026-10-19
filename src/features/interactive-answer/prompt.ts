const START = "\n\n<ccgui-interactive-answer-v1>\n";
const END = "\n</ccgui-interactive-answer-v1>";

/** Engines whose ordinary chats receive the capability instructions and render
 *  `ccgui-ui` fences; keep aligned with `PRESENTATION_ENGINES` in
 *  `src-tauri/src/engine/host_instructions.rs`. */
export function supportsInteractiveAnswer(engine: string | undefined): boolean {
  return engine === "codex" || engine === "claude";
}

/** Instructions the retired `/ui` command appended to a request. Kept verbatim
 *  only so history from that period still hides them; nothing sends them now. */
export const LEGACY_REQUEST_INSTRUCTIONS = `For this response, provide an interactive answer inside the current chat. Do not create files, open a browser, run commands, install packages, or call another model to build it.
Use the user's language for all visible labels and explanations (Chinese for a Chinese request). Answer the actual question with a brief useful explanation, one fenced code block labelled ccgui-ui, and a short plain-text summary of assumptions/results so the response remains useful without the UI. This request changes only this answer's presentation.
The code block uses the following closed subset of OpenUI Lang, NOT JavaScript, HTML, JSX, JSON or DIL. One assignment per line; double-quoted strings; no comments or semicolons. Put root = Stack([...]) first; forward references are supported. Define every referenced name once. Keep the whole program small (at most 80 declarations / 16 controls / 32 KB). Only literal number, string or boolean defaults are allowed for $state variables. No recursive definitions.
The available components, with POSITIONAL arguments in this exact order, are:
Stack(children, gap?) — gap is "small", "normal" or "large".
Grid(children, columns?) — 1 to 3 responsive columns.
Card(children, tone?) — "plain", "accent" or "subtle".
Heading(text, size?) — "sm", "md" or "lg".
Text(text, tone?) — "default" or "muted"; plain text.
Metric(label, value, unit?, detail?) — value is a number or string.
Badge(text, tone?) — "neutral", "positive" or "warning".
Divider()
Slider($value, label, min, max, step?, unit?) — a directly bound numeric variable.
NumberInput($value, label, min?, max?, step?, unit?) — directly bound numeric variable.
Select($value, label, options) — directly bound string variable; options is an array of strings.
Toggle($value, label) — directly bound boolean variable.
Table(columns, rows) — strings for column names; each row an array of string/number/boolean values.
BarChart(title, items, unit?) — items are objects with ONLY label (string) and value (number).
Optional arguments can be omitted at the end; do not invent props, components or functions. Arrays contain at most 64 entries. Nested cards are usually unnecessary.
Expressions allow + - * / %, == != > < >= <=, && || !, parentheses and condition ? yes : no. Keep numeric values finite. A divisor must be a known nonzero constant, a numeric control whose entire range excludes zero, or explicitly guarded in the same expression: $n > 0 ? total / $n : "—". Use literal numeric control bounds, and defaults inside those bounds. Allowed functions ONLY: @Round(number, decimals), @Abs(number), @Floor(number), @Ceil(number), @Count(array), @Sum(numbers), @Avg(numbers), @Min(numbers), @Max(numbers). Min/Max/Avg take ONE nonempty numeric array; Sum takes one numeric array; Count takes one array. Round decimals must be a literal integer from 0 to 6. There is no Pow, Format, Each, Range, custom function, member access, indexing, assignment expression, URL, image, raw markup, Query, Mutation, action or model-call button.
Choose a small meaningful set of controls. Every control must change a displayed result locally. Keep derived results in named expressions and reuse them in metrics, tables and charts. Preserve zero as a valid input. Use two-column Grid only where it helps; the host handles mobile layout and light/dark themes. Do not claim example prices or estimates are live facts. Do not claim to have installed anything or connected an official ChatGPT feature.
Example program:
root = Stack([Heading("活动预算", "lg"), Text("调整人数和单价，结果会即时更新。", "muted"), Grid([controls, results], 2)], "normal")
$people = 12
$meal = 120
$venue = 800
food = $people * $meal
total = food + $venue
average = $people > 0 ? total / $people : 0
controls = Card([Heading("预算参数", "sm"), Slider($people, "人数", 1, 50, 1, "人"), NumberInput($meal, "人均餐费", 0, 2000, 10, "元"), NumberInput($venue, "场地费用", 0, 20000, 100, "元")], "subtle")
results = Card([Metric("预算总额", @Round(total, 0), "元"), Metric("人均预算", @Round(average, 2), "元"), BarChart("费用构成", [{label: "餐饮", value: food}, {label: "场地", value: $venue}], "元")], "accent")`;

export function stripInteractiveAnswerPrompt(text: string): string {
  if (!text.startsWith("/ui ") || !text.endsWith(END)) return text;
  const start = text.lastIndexOf(START);
  return start >= 0 && text.slice(start + START.length, -END.length) === LEGACY_REQUEST_INSTRUCTIONS ? text.slice(0, start) : text;
}
