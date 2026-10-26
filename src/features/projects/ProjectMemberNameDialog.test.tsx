import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), change: undefined as undefined | ((value: string) => void) }));
vi.mock("./api", () => ({ projectsApi: { save: mocks.save } }));
vi.mock("@/lib/transport", () => ({ listen: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/dialogs", () => ({ ModalShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/base/input/input", () => ({ Input: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => {
  mocks.change = onChange; return <input value={value} onChange={(e) => onChange(e.target.value)} />;
} }));
vi.mock("@/components/base/buttons/button", () => ({ Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> }));
import { ProjectMemberNameDialog } from "./ProjectMemberNameDialog";
import { useProjectsStore } from "./store";
const original = { id: "p", name: "Project", defaultPath: "/game", members: [{ id: "m", path: "/game", label: "Old name", role: "reference" as const, status: "available" as const }] };
let root: Root, node: HTMLDivElement;
const close = vi.fn();
const submit = async () => { await act(async () => node.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); };
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.clearAllMocks();
  useProjectsStore.setState({ projects: [original], loaded: true, error: null });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(<ProjectMemberNameDialog projectId="p" memberId="m" onClose={close} />));
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });

describe("manual project member naming", () => {
  it("updates the same display-name field as AI and retains unrelated late edits", async () => {
    await act(async () => mocks.change!("我的名字 🐾"));
    const other = { ...original.members[0], id: "other", path: "/other", label: "Other" };
    useProjectsStore.setState({ projects: [{ ...original, name: "Renamed elsewhere", members: [...original.members, other] }] });
    mocks.save.mockImplementation(async (input) => ({ ...input, members: input.members.map((m: object) => ({ ...m, status: "available" })) }));
    await submit();
    expect(mocks.save).toHaveBeenCalledWith({ id: "p", name: "Renamed elsewhere", defaultPath: "/game", members: [
      { id: "m", path: "/game", label: "我的名字 🐾", role: "reference" },
      { id: "other", path: "/other", label: "Other", role: "reference" },
    ] });
    expect(close).toHaveBeenCalledOnce();
  });
  it("keeps the draft and exposes failed persistence", async () => {
    await act(async () => mocks.change!("Keep this draft")); mocks.save.mockRejectedValue(new Error("disk full"));
    await submit();
    expect(node.querySelector("input")?.value).toBe("Keep this draft");
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("disk full");
    expect(close).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().projects[0].members[0].label).toBe("Old name");
  });
  it("does not resurrect a member removed while the name prompt is open", async () => {
    useProjectsStore.setState({ projects: [] }); await submit();
    expect(mocks.save).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("projects.memberChanged");
  });
});
