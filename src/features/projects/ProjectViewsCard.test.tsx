// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn(), pick: vi.fn() }));
vi.mock("./api", () => ({ projectsApi: mocks }));
vi.mock("@/lib/transport", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/lib/platform", () => ({ pickDirectory: mocks.pick }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/application/settings/settings-rows", () => ({ SettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>, SettingsSectionLabel: ({ children }: { children: ReactNode }) => <h2>{children}</h2> }));
vi.mock("@/components/base/buttons/button", () => ({ Button: ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{children}</button> }));
vi.mock("@/components/base/input/input", () => ({ Input: ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) => <label>{label}<input value={value} onChange={(e) => onChange(e.target.value)} /></label> }));
vi.mock("@/components/base/select/select", () => ({ Select: ({ children, selectedKey, onSelectionChange, ...props }: { children: ReactNode; selectedKey: string; onSelectionChange: (key: string) => void; "aria-label": string }) => <select aria-label={props["aria-label"]} value={selectedKey ?? ""} onChange={(e) => onSelectionChange(e.target.value)}><option value="" />{children}</select>, SelectItem: ({ id, children }: { id: string; children: ReactNode }) => <option value={id}>{children}</option> }));
vi.mock("@/components/dialogs", () => ({ ConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>confirm</button> }));
import { ProjectViewsCard } from "./ProjectViewsCard";
import { useProjectsStore } from "./store";
const p = { id: "p", name: "P", defaultPath: "G:/game", members: [{ id: "m", path: "G:/game", label: "Game", role: "development" as const, status: "available" as const }] };
let container: HTMLDivElement, root: Root;
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); mocks.list.mockResolvedValue([p]); mocks.remove.mockResolvedValue(undefined);
  useProjectsStore.setState({ projects: [p], loaded: true, error: null });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ProjectViewsCard workspaces={[]} />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const click = async (label: string) => { const button = [...container.querySelectorAll("button")].find((el) => el.textContent === label); expect(button).toBeTruthy(); await act(async () => button!.click()); };
describe("project settings", () => {
  it("uses free display names without prescribed role selectors or badges", async () => {
    expect(container.textContent).not.toContain("projects.development");
    expect(container.textContent).not.toContain("projects.roleHint");
    await click("projects.edit");
    expect(container.querySelector('select[aria-label="projects.role"]')).toBeNull();
    expect([...container.querySelectorAll("input")].map((input) => input.value)).toEqual(["P", "Game"]);
  });
  it("keeps the editor and fields when save fails", async () => {
    mocks.save.mockRejectedValue(new Error("disk full"));
    await click("projects.edit"); await click("common.save");
    expect(container.querySelector("input")?.value).toBe("P");
    expect(container.textContent).toContain("disk full");
    expect(container.querySelector("fieldset")).not.toBeNull();
    expect(mocks.save).toHaveBeenCalledWith({ id: "p", name: "P", defaultPath: "G:/game", members: [{ id: "m", path: "G:/game", label: "Game", role: "development" }] });
  });
  it("removes only the project relation after confirmation", async () => {
    await click("projects.remove"); expect(mocks.remove).not.toHaveBeenCalled();
    await click("confirm"); expect(mocks.remove).toHaveBeenCalledWith("p");
    expect(useProjectsStore.getState().projects).toEqual([]);
  });
  it("keeps member removal in the draft until saved", async () => {
    await click("projects.edit"); await click("projects.removeMember");
    expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().projects[0].members).toHaveLength(1);
    await click("common.cancel"); expect(useProjectsStore.getState().projects[0].members).toHaveLength(1);
  });
});
