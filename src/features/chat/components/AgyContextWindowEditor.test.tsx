import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgyContextWindowEditor } from "./AgyContextWindowEditor";
import { useAgyContextWindow } from "./use-agy-context-window";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/base/input/input", () => ({
  Input: ({
    label,
    value,
    onChange,
    isDisabled,
    placeholder,
  }: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    isDisabled: boolean;
    placeholder: string;
  }) => (
    <label>
      {label}
      <input
        value={value}
        disabled={isDisabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  ),
}));
vi.mock("@/components/base/buttons/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled: boolean;
    onClick: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("AgyContextWindowEditor and useAgyContextWindow", () => {
  let container: HTMLDivElement;
  let root: Root;
  const save = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    save.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function input(text: string) {
    const node = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, text);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  const click = (index = 0) =>
    act(async () => {
      container.querySelectorAll("button")[index].click();
    });

  it("validates range 100-2000K and saves or resets the reference window", async () => {
    await act(async () =>
      root.render(<AgyContextWindowEditor window={undefined} onSave={save} />),
    );
    const node = container.querySelector("input")!;
    expect(node.value).toBe("");
    expect(node.placeholder).toBe("chat.agyReferenceWindowDefault");

    await input("99");
    await click(0);
    expect(save).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "chat.agyReferenceWindowRangeError",
    );

    await input("2001");
    await click(0);
    expect(save).not.toHaveBeenCalled();

    await input("1000");
    await click(0);
    expect(save).toHaveBeenCalledWith(1_000_000);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "chat.agyReferenceWindowSaveDone",
    );

    await click(1);
    expect(save).toHaveBeenCalledWith(undefined);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "chat.agyReferenceWindowResetDone",
    );
  });

  it("syncs useAgyContextWindow across saves and ignores non-agy engines", async () => {
    let current: ReturnType<typeof useAgyContextWindow> | undefined;
    function Probe({ engine }: { engine: string }) {
      current = useAgyContextWindow(engine);
      return <span>{current.window ?? "unset"}</span>;
    }

    await act(async () => root.render(<Probe engine="agy" />));
    expect(container.textContent).toBe("unset");

    await act(async () => {
      await current!.save(1_000_000);
    });
    expect(container.textContent).toBe("1000000");

    await act(async () => root.render(<Probe engine="claude" />));
    expect(container.textContent).toBe("unset");
  });
});
