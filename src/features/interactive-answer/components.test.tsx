import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Renderer } from "@openuidev/react-lang";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerComponents } from "./components";
import { answerLibrary } from "./library";
import { ANSWER_COMPONENTS } from "./protocol";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("interactive-answer components", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  });

  async function renderProgram(
    response: string,
    options: {
      isStreaming?: boolean;
      onStateUpdate?: (state: Record<string, unknown>) => void;
    } = {},
  ) {
    if (!root) {
      root = createRoot(container);
    }
    await act(async () => {
      root?.render(
        <Renderer
          library={answerLibrary}
          response={response}
          isStreaming={options.isStreaming}
          onStateUpdate={options.onStateUpdate}
          publishObservability={false}
        />,
      );
    });
  }

  it("exports the exact 14 components and positional signatures matching protocol", () => {
    expect(answerComponents.map((c) => c.name)).toEqual([...ANSWER_COMPONENTS]);
    const spec = answerLibrary.toSpec();
    expect(spec.components.Stack.signature).toBe("Stack(children: Node[], gap?: \"small\" | \"normal\" | \"large\")");
    expect(spec.components.Grid.signature).toBe("Grid(children: Node[], columns?: number)");
    expect(spec.components.Card.signature).toBe("Card(children: Node[], tone?: \"plain\" | \"accent\" | \"subtle\")");
    expect(spec.components.Heading.signature).toBe("Heading(text: string, size?: \"sm\" | \"md\" | \"lg\")");
    expect(spec.components.Text.signature).toBe("Text(text: string, tone?: \"default\" | \"muted\")");
    expect(spec.components.Metric.signature).toBe("Metric(label: string, value: number | string, unit?: string, detail?: string)");
    expect(spec.components.Badge.signature).toBe("Badge(text: string, tone?: \"neutral\" | \"positive\" | \"warning\")");
    expect(spec.components.Divider.signature).toBe("Divider()");
    expect(spec.components.Slider.signature).toContain("Slider(");
    expect(spec.components.NumberInput.signature).toContain("NumberInput(");
    expect(spec.components.Select.signature).toContain("Select(");
    expect(spec.components.Toggle.signature).toContain("Toggle(");
    expect(spec.components.Table.signature).toContain("Table(");
    expect(spec.components.BarChart.signature).toContain("BarChart(");
  });

  it("renders the calculator demo program and updates derived metrics via Slider and NumberInput", async () => {
    const onStateUpdate = vi.fn();
    const program = [
      'root = Stack([Heading("活动预算", "lg"), Text("调整人数和单价，结果会即时更新。", "muted"), Grid([controls, results], 2)], "normal")',
      "$people = 12",
      "$meal = 120",
      "$venue = 800",
      "food = $people * $meal",
      "total = food + $venue",
      "average = $people > 0 ? total / $people : 0",
      'controls = Card([Heading("预算参数", "sm"), Slider($people, "人数", 1, 50, 1, "人"), NumberInput($meal, "人均餐费", 0, 2000, 10, "元"), NumberInput($venue, "场地费用", 0, 20000, 100, "元")], "subtle")',
      'results = Card([Metric("预算总额", @Round(total, 0), "元", "含餐饮与场地"), Metric("人均预算", @Round(average, 2), "元"), BarChart("费用构成", [{label: "餐饮", value: food}, {label: "场地", value: $venue}], "元")], "accent")',
    ].join("\n");

    await renderProgram(program, { onStateUpdate });

    expect(container.querySelector(".interactive-answer")).not.toBeNull();
    expect(container.textContent).toContain("活动预算");
    expect(container.textContent).toContain("2,240");

    // Update slider ($people -> 20): food = 2400, total = 3200, average = 160
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).not.toBeNull();
    await act(async () => {
      setInputValue(slider, "20");
    });

    expect(container.textContent).toContain("3,200");
    expect(container.textContent).toContain("160");
    expect(onStateUpdate).toHaveBeenCalled();

    // Update NumberInput ($meal): test blank editing without NaN, then valid 0
    const numberInputs = Array.from(
      container.querySelectorAll('input[type="number"]'),
    ) as HTMLInputElement[];
    expect(numberInputs).toHaveLength(2);
    const mealInput = numberInputs[0];

    await act(async () => {
      setInputValue(mealInput, "");
    });
    expect(mealInput.value).toBe("");
    expect(container.textContent).not.toContain("NaN");
    expect(container.textContent).toContain("3,200");

    // Setting meal to 0 must be respected as valid 0 (total = 0 + 800 = 800)
    await act(async () => {
      setInputValue(mealInput, "0");
    });
    expect(mealInput.value).toBe("0");
    expect(container.textContent).toContain("800");

    // Blank followed by blur restores committed value ("0")
    await act(async () => {
      mealInput.focus();
      setInputValue(mealInput, "");
    });
    expect(mealInput.value).toBe("");
    await act(async () => {
      mealInput.blur();
    });
    expect(mealInput.value).toBe("0");
  });

  it("supports reactive Select, Toggle, Badge, Divider, Table, and BarChart negative/bounded items", async () => {
    const manyItems = Array.from({ length: 40 }, (_, i) => `{label: "项${i + 1}", value: ${i === 0 ? -25 : i + 1}}`).join(", ");
    const program = [
      'root = Stack([Select($tier, "套餐档位", ["基础版", "专业版"]), Toggle($annual, "年付优惠"), Badge($annual ? "已享8折" : "标准月付", $annual ? "positive" : "neutral"), Divider(), Metric("最终报价", price, "元/月"), Table(["档位", "年付"], [[$tier, $annual]]), BarChart("损益分布", [' + manyItems + '], "元")], "small")',
      '$tier = "基础版"',
      "$annual = false",
      'base = $tier == "专业版" ? 200 : 100',
      "price = $annual ? base * 0.8 : base",
    ].join("\n");

    await renderProgram(program);

    expect(container.textContent).toContain("标准月付");
    expect(container.textContent).toContain("100");

    // Change Select to "专业版" -> price = 200
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    await act(async () => {
      setSelectValue(select, "专业版");
    });
    expect(container.textContent).toContain("200");

    // Click Toggle -> $annual = true -> price = 160, badge = "已享8折"
    const toggleInput = container.querySelector('input[role="switch"]') as HTMLInputElement;
    expect(toggleInput).not.toBeNull();
    await act(async () => {
      toggleInput.click();
    });
    expect(container.textContent).toContain("已享8折");
    expect(container.textContent).toContain("160");

    // Table scrollable wrapper & cells
    expect(container.querySelector(".ia-table-scroll")).not.toBeNull();
    expect(container.querySelector("hr.ia-divider")).not.toBeNull();

    // BarChart capped at 32 items and renders negative bar + zero line honestly
    const chartRows = container.querySelectorAll(".ia-chart-row");
    expect(chartRows.length).toBe(32);
    expect(container.querySelector(".ia-chart-zero-line")).not.toBeNull();
    expect(container.querySelector(".ia-chart-fill-negative")).not.toBeNull();
    expect(container.textContent).toContain("-25 元");
  });

  it("disables all interactive controls while streaming and guards untrusted values", async () => {
    const program = [
      'root = Stack([Grid([Slider($n, "滑杆", 100, 10, -5), NumberInput($n, "数值", 100, 10), Select($s, "下拉", ["A", "B"]), Toggle($b, "开关"), Text("<script>alert(1)</script>")], 9)])',
      "$n = 50",
      '$s = "A"',
      "$b = true",
    ].join("\n");

    await renderProgram(program, { isStreaming: true });

    // Grid columns clamped to 3
    const grid = container.querySelector(".ia-grid");
    expect(grid?.getAttribute("data-columns")).toBe("3");

    // Controls disabled during streaming
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    const numInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    const select = container.querySelector("select") as HTMLSelectElement;
    const toggle = container.querySelector('input[role="switch"]') as HTMLInputElement;

    expect(slider.disabled).toBe(true);
    expect(numInput.disabled).toBe(true);
    expect(select.disabled).toBe(true);
    expect(toggle.disabled).toBe(true);

    // Inverted min/max (100, 10) normalized to min=10, max=100
    expect(slider.min).toBe("10");
    expect(slider.max).toBe("100");

    // Script string rendered as inert text, never as DOM element
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});
