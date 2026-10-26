import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { CliMenu, requestCliMenuOpen } from "./cli-menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const OPTIONS = [
  { id: "claude", label: "Claude Code", available: true },
  { id: "codex", label: "Codex", available: true },
  { id: "omp", label: "OMP", available: true },
];

const MODELS = {
  claude: [{ id: "default", label: "Default" }],
  codex: [{ id: "gpt-6-astra", label: "gpt-6-astra" }],
  omp: [{ id: "openai/gpt-5", label: "gpt-5" }],
};

const CHANNELS = {
  codex: [
    { id: "c1", label: "codex-one" },
    { id: "c2", label: "codex-two" },
  ],
};

function Harness({ initialEngine = "claude" }: { initialEngine?: string }) {
  const [engine, setEngine] = useState(initialEngine);
  const [selectedChannels, setSelectedChannels] = useState({ codex: "c1" });
  return (
    <CliMenu
      options={OPTIONS}
      value={engine}
      onChange={setEngine}
      modelsByEngine={MODELS}
      models={{}}
      onModelChange={() => {}}
      efforts={{}}
      onEffortChange={() => {}}
      channelsByEngine={CHANNELS}
      selectedChannels={selectedChannels}
      onChannelChange={(engine, id) => {
        setSelectedChannels((channels) => ({ ...channels, [engine]: id }));
      }}
      ompServiceTier={null}
      onOmpServiceTierChange={async () => {}}
      codexServiceTier={null}
      onCodexServiceTierChange={async () => {}}
    />
  );
}

function VariantHarness() {
  const [engine, setEngine] = useState("codex");
  const [models, setModels] = useState<Record<string, string>>({ codex: "gpt-6-astra", agy: "claude-opus-5-5-high" });
  return <CliMenu
    options={[...OPTIONS, { id: "agy", label: "Antigravity CLI", available: true }]}
    value={engine} onChange={setEngine}
    modelsByEngine={{ ...MODELS, agy: [
      { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)" },
      { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
    ] }}
    models={models} onModelChange={(id, model) => setModels((previous) => ({ ...previous, [id]: model }))}
    efforts={{ codex: "xhigh", agy: "medium" }} onEffortChange={() => {}}
    ompServiceTier={null} onOmpServiceTierChange={async () => {}}
    codexServiceTier={null} onCodexServiceTierChange={async () => {}}
  />;
}

describe("CliMenu flyout switching", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // jsdom has no matchMedia; desktop (no match) is the branch under test.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = (initialEngine?: string) =>
    act(() => {
      root.render(<Harness initialEngine={initialEngine} />);
    });

  /** The flyout is the panel carrying the engine header. */
  const flyoutTitle = () =>
    [...document.querySelectorAll("span")]
      .map((span) => span.textContent ?? "")
      .find((text) => text.endsWith("引擎")) ?? null;

  /** Engine rows live in the popover's dialog; the composer chip is a button
   *  too and shares the engine's display name, so scope the lookup. */
  const engineRow = (label: string) => {
    const dialog = document.querySelector('[role="dialog"]');
    return (
      [...(dialog?.querySelectorAll("button") ?? [])].find((button) =>
        button.textContent?.trim().startsWith(label),
      ) ?? null
    );
  };

  const openMenu = async () => {
    const chip = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => {
      chip.click();
    });
  };

  const enter = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
  };
  const leave = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
  };
  /** Let the hover-intent timer (and then some) elapse. */
  const settleHover = async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 400);
    await act(async () => {
      await promise;
    });
  };

  const click = async (element: Element) => {
    await act(async () => {
      (element as HTMLElement).click();
    });
  };

  it("切换 Codex 渠道后保留面板并将焦点交回渠道按钮", async () => {
    render("codex");
    await openMenu();
    await click(engineRow("Codex")!);
    const trigger = document.querySelector<HTMLButtonElement>(
      "[data-engine-flyout] button[aria-expanded]",
    )!;
    await click(trigger);
    const list = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    const row = [...list.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (button) => button.textContent?.trim() === "codex-two",
    )!;

    // A real pointer/keyboard activation focuses the row before selecting it.
    // A bare .click() misses the focus loss when the dropdown unmounts it.
    await act(async () => {
      row.focus();
      row.click();
    });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("codex-two");
    expect(document.activeElement).toBe(trigger);
    expect(flyoutTitle()).toBe("Codex CLI 引擎");
    expect(engineRow("Codex")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("指针掠过引擎行不触发切换", async () => {
    render();
    await openMenu();
    await click(engineRow("Codex")!);
    expect(flyoutTitle()).toBe("Codex CLI 引擎");

    // A pointer crossing Claude's row on its way into the panel leaves
    // before the hover-intent delay, so the panel must stay put.
    await enter(engineRow("Claude")!);
    await leave(engineRow("Claude")!);
    await settleHover();
    expect(flyoutTitle()).toBe("Codex CLI 引擎");
  });

  it("悬停停留后打开对应引擎面板", async () => {
    render();
    await openMenu();
    await click(engineRow("Codex")!);
    expect(flyoutTitle()).toBe("Codex CLI 引擎");

    // Dwelling on a row past the intent delay pre-opens its flyout.
    await enter(engineRow("Claude")!);
    await settleHover();
    expect(flyoutTitle()).toBe("Claude Code 引擎");
  });

  it("面板搜索框输入期间悬停不换面板", async () => {
    render();
    await openMenu();
    await click(engineRow("Codex")!);
    expect(flyoutTitle()).toBe("Codex CLI 引擎");

    // While the user is typing in the panel's search field, a dwelling
    // hover must not yank the panel away; the click path still works.
    const search = document.querySelector<HTMLInputElement>(
      "[data-engine-flyout] input",
    )!;
    await act(async () => {
      search.focus();
    });
    await enter(engineRow("Claude")!);
    await settleHover();
    expect(flyoutTitle()).toBe("Codex CLI 引擎");
  });

  it("点击引擎行切换面板", async () => {
    render();
    await openMenu();
    await click(engineRow("Codex")!);
    expect(flyoutTitle()).toBe("Codex CLI 引擎");

    await click(engineRow("Claude")!);
    expect(flyoutTitle()).toBe("Claude Code 引擎");
  });

  it.each([false, true])("选择变体后切换正确引擎，摘要跟随模型等级（mobile=%s）", async (mobile) => {
    if (mobile) {
      vi.stubGlobal("matchMedia", (media: string) => ({
        matches: media.includes("max-width"), media,
        addEventListener() {}, removeEventListener() {},
      }));
    }
    act(() => root.render(<VariantHarness />));
    await openMenu();
    await click(engineRow("Antigravity")!);
    // Browsing another engine must leave the active Codex selection intact.
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("Codex CLI");
    const high = document.querySelector('[aria-label="Claude Opus 5.5 · 高"]')!;
    expect(high.getAttribute("aria-checked")).toBe("true");
    await click(high);
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Antigravity CLI / Claude Opus 5.5 · 高");
    await click(document.querySelector('[aria-label="Claude Opus 5.5 · 中"]')!);
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Antigravity CLI / Claude Opus 5.5 · 中");
  });
  const taskProps = () => ({
    selectionScope: "task" as const, options: OPTIONS, value: "codex",
    modelsByEngine: MODELS, models: {}, efforts: {},
    onChange: vi.fn(), onModelChange: vi.fn(), onEffortChange: vi.fn(),
    channelsByEngine: CHANNELS, selectedChannels: { codex: "c1" }, onChannelChange: vi.fn(),
  });

  it("programmatic opening targets chat only when a task picker is mounted", async () => {
    act(() => root.render(<><Harness /><CliMenu {...taskProps()} /></>));
    await act(async () => requestCliMenuOpen());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(flyoutTitle()).toBe("Claude Code 引擎");
  });

  it.each([false, true])("disabling an open task picker closes its panel and blocks selection (mobile=%s)", async (mobile) => {
    if (mobile) vi.stubGlobal("matchMedia", (media: string) => ({
      matches: media.includes("max-width"), media, addEventListener() {}, removeEventListener() {},
    }));
    const props = taskProps();
    act(() => root.render(<CliMenu {...props} />));
    await openMenu();
    if (mobile) await click(engineRow("Codex")!);
    const model = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(row => row.textContent === "gpt-6-astra")!;
    expect(model).toBeTruthy();
    act(() => root.render(<CliMenu {...props} disabled />));
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(model);
    await openMenu();
    await act(async () => requestCliMenuOpen());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(props.onModelChange).not.toHaveBeenCalled();
  });

  it.each([false, true])("managed Codex hides Fast without changing chat controls (mobile=%s)", async (mobile) => {
    if (mobile) vi.stubGlobal("matchMedia", (media: string) => ({
      matches: media.includes("max-width"), media, addEventListener() {}, removeEventListener() {},
    }));
    const onTierChange = vi.fn();
    const props = { ...taskProps(), selectionScope: "chat" as const,
      codexServiceTier: "priority" as const, onCodexServiceTierChange: onTierChange };
    act(() => root.render(<CliMenu {...props} />));
    expect(container.textContent).toContain("Fast");
    await openMenu();
    if (mobile) await click(engineRow("Codex")!);
    const fastToggle = () => document.querySelector(`[aria-label="${i18n.t("chat.ompFastToggle")}"]`);
    expect(fastToggle()?.getAttribute("aria-pressed")).toBe("true");

    act(() => root.render(<CliMenu {...props} allowCodexFast={false} />));
    expect(document.body.textContent).not.toContain("Fast");
    expect(fastToggle()).toBeNull();
    const effortButtons = [...document.querySelectorAll<HTMLButtonElement>('button')];
    await click(effortButtons.find(button => button.textContent === "高")!);
    expect(props.onEffortChange).toHaveBeenCalledWith("codex", "high");
    expect(onTierChange).not.toHaveBeenCalled();
  });

  it("task picker hides chat speed controls while retaining effort and channel callbacks", async () => {
    const props = taskProps();
    act(() => root.render(<CliMenu {...props} codexServiceTier="priority" onCodexServiceTierChange={vi.fn()} />));
    await openMenu();
    expect(document.body.textContent).not.toContain("Fast");
    const effort = document.querySelector<HTMLButtonElement>('[data-engine-flyout] [role="radio"][aria-label="高"]');
    const effortButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-engine-flyout] button')];
    await click(effort ?? effortButtons.find(button => button.textContent === "高")!);
    expect(props.onEffortChange).toHaveBeenCalledWith("codex", "high");
    await click(document.querySelector('[data-engine-flyout] button[aria-expanded]')!);
    await click([...document.querySelectorAll('[role="radio"]')].find(row => row.textContent === "codex-two")!);
    expect(props.onChannelChange).toHaveBeenCalledWith("codex", "c2");
    await click(engineRow("Claude")!);
    expect(document.querySelector('[role="switch"]')).toBeNull();
  });

  it.each([false, true])("disabled engines cannot be selected from an already open picker (mobile=%s)", async (mobile) => {
    if (mobile) vi.stubGlobal("matchMedia", (media: string) => ({
      matches: media.includes("max-width"), media, addEventListener() {}, removeEventListener() {},
    }));
    const props = taskProps();
    act(() => root.render(<CliMenu {...props} />));
    await openMenu();
    if (mobile) await click(engineRow("Codex")!);
    act(() => root.render(<CliMenu {...props} options={OPTIONS.map(option => ({ ...option, disabled: true }))} />));
    expect(document.querySelector('[role="radio"]')).toBeNull();
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onModelChange).not.toHaveBeenCalled();
  });

});
