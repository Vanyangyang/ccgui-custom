import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PermissionMenu } from "./permission-menu";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-aria-components", async () => {
  const { forwardRef } = await import("react");
  return {
  Button: forwardRef<HTMLButtonElement, { children: ReactNode }>(({ children }, ref) => <button ref={ref}>{children}</button>),
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Popover: forwardRef<HTMLDivElement, { children: ReactNode }>(({ children }, ref) => <div ref={ref}>{children}</div>),
}; });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("uses AGY native-mode copy and cannot select manual even if incorrectly advertised", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  try {
    await act(async () => root.render(<PermissionMenu engine="agy" supported={["auto", "manual", "plan", "bypass"]} onChange={onChange} />));
    const options = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(options.map(option => option.textContent)).toEqual(["Auto", "Manual", "Plan", "Bypass"].map(mode => `chat.permissionAgy${mode}chat.permissionAgy${mode}Desc`));
    expect(options[1].getAttribute("aria-disabled")).toBe("true");
    await act(async () => options[1].click());
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => options[3].click());
    expect(onChange).toHaveBeenCalledWith("bypass");
    await act(async () => root.render(<PermissionMenu engine="claude" supportsAutoReview />));
    expect(host.textContent).toContain("chat.permissionAutoReview");
    expect(host.textContent).not.toContain("permissionAgy");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
