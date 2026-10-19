import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { Composer, type ComposerProps } from "./ai-chat-composer";
import { extractText, getCaretOffset } from "./file-tags";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const PREFILL = "/ccgui-plugin-creator ";

/**
 * 草稿恢复（外部 value 变化）会重建 editable 的 DOM；重建时浏览器手里的插入
 * 点一并消失，随后 focus()（creator flow 的 focusComposerWhenVisible）把光标
 * 放回内容开头。这里钉住修复后的落点：文本末尾，用户可以直接接着敲需求；
 * 文本本身按原文渲染（斜杠指令不再有特殊展示逻辑）。
 */
describe("Composer 草稿恢复", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("zh");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  /** 用受控 value 渲染（等价于 store 的 draft），返回 editable。 */
  async function render(value: string, props: Partial<ComposerProps> = {}): Promise<HTMLElement> {
    await act(async () => {
      root.render(
        <HashRouter>
          <Composer value={value} onValueChange={() => {}} {...props} />
        </HashRouter>,
      );
    });
    const el = container.querySelector<HTMLElement>(".composer-editable");
    expect(el).not.toBeNull();
    return el!;
  }

  it("挂载即带草稿时光标落在文本末尾", async () => {
    const el = await render(PREFILL);
    expect(extractText(el)).toBe(PREFILL);
    expect(getCaretOffset(el)).toBe(PREFILL.length);
  });

  it("挂载后才收到草稿（插件中心「创建插件」）同样落在末尾", async () => {
    await render("");
    const el = await render(PREFILL);
    expect(extractText(el)).toBe(PREFILL);
    expect(getCaretOffset(el)).toBe(PREFILL.length);
  });

  it("运行中的引导、排队和停止分别调用对应入口，Enter 仍引导当前任务", async () => {
    const onSubmit = vi.fn(), onQueue = vi.fn(), onStop = vi.fn();
    const el = await render("修改当前方向🙂", { streaming: true, onSubmit, onQueue, onStop });
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === label || b.getAttribute("aria-label") === label)!;
    expect(button("引导").title).toContain("不停止");
    expect(button("排队").title).toContain("任务结束");
    await act(async () => { button("引导").click(); button("排队").click(); button("停止").click(); });
    expect(onSubmit).toHaveBeenCalledWith("修改当前方向🙂");
    expect(onQueue).toHaveBeenCalledWith("修改当前方向🙂");
    expect(onStop).toHaveBeenCalledTimes(1);
    await act(async () => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onQueue).toHaveBeenCalledTimes(1);
  });

  it("禁用发送时同时禁用引导与排队，图片单独提交仍可用", async () => {
    const onSubmit = vi.fn(), onQueue = vi.fn();
    await render("", { streaming: true, disabled: true, onSubmit, onQueue });
    const actions = () => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .filter((b) => b.textContent === "引导" || b.textContent === "排队");
    expect(actions().map((b) => b.disabled)).toEqual([true, true]);
    await act(async () => actions().forEach((b) => b.click()));
    expect(onSubmit).not.toHaveBeenCalled(); expect(onQueue).not.toHaveBeenCalled();
    // Footer owns attachment-aware disabled state; image-only input supplies false.
    await render("", { streaming: true, disabled: false, onSubmit, onQueue });
    expect(actions().every((b) => !b.disabled)).toBe(true);
    await act(async () => actions().forEach((b) => b.click()));
    expect(onSubmit).toHaveBeenCalledWith(""); expect(onQueue).toHaveBeenCalledWith("");
  });

  it("空闲时保留发送按钮，未提供排队能力的运行中输入区仅显示停止", async () => {
    await render("hello", { onQueue: vi.fn() });
    expect(container.querySelector("button[aria-label='发送']")).not.toBeNull();
    expect(container.textContent).not.toContain("排队");
    await render("hello", { streaming: true });
    expect(container.querySelector("button[aria-label='停止']")).not.toBeNull();
    expect(container.querySelector("button[aria-label='发送']")).toBeNull();
    expect(container.textContent).not.toContain("引导");
  });
});
