import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ApiProps { draftKey: string; onDraftKeyChange: (value: string) => void; onOpenEditor: (id: string) => void }
interface CustomProps {
  draft: string; editorOpen: boolean; modelsConfig: { text: string } | null;
  onDraftChange: (value: string) => void; onToggleEditor: () => void;
}
const mocks = vi.hoisted(() => ({
  dshHostStatus: vi.fn(), dshHostStart: vi.fn(), dshHostStop: vi.fn(),
  getAppSettings: vi.fn(), updateAppSettings: vi.fn(),
  piFamilyAuthList: vi.fn(), piFamilyModelsConfigRead: vi.fn(),
  listen: vi.fn(), notify: vi.fn(), apiProps: null as ApiProps | null, customProps: null as CustomProps | null,
}));
vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
vi.mock("@/lib/transport", () => ({ listen: mocks.listen }));
vi.mock("@/lib/platform", () => ({ pickFile: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/dialogs", () => ({ ConfirmDialog: () => null }));
vi.mock("./useCliVersionStatus", () => ({ useCliVersionStatus: () => ({ updating: false }) }));
vi.mock("./useCliUpdateFlow", () => ({ useCliUpdateFlow: () => ({ state: { status: "idle" }, begin: vi.fn() }) }));
vi.mock("./providers", () => ({ notifyCliConfigChanged: mocks.notify }));
vi.mock("./PiFamilyOauthSection", () => ({ PiFamilyOauthSection: () => null }));
vi.mock("./PiFamilyApiKeySection", () => ({ PiFamilyApiKeySection: (props: ApiProps) => { mocks.apiProps = props; return null; } }));
vi.mock("./PiFamilyCustomSection", () => ({ PiFamilyCustomSection: (props: CustomProps) => { mocks.customProps = props; return null; } }));
vi.mock("./piFamilyLogin", () => ({ launchPiFamilyLogin: vi.fn() }));

import { useDshHost, type DshHostSectionState } from "./useDshHost";
import { PiFamilyAuthSection } from "./PiFamilyAuthSection";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
type EventCallback = (event: { payload: { engine?: string } }) => void;

describe("host engine configuration sync", () => {
  let root: Root | null;
  let container: HTMLDivElement;
  let latest: DshHostSectionState;
  const subscriptions = new Map<string, Set<EventCallback>>();
  const dshStatus = (running = false) => ({ installed: true, version: "1.0", host: "127.0.0.1", port: 3080,
    origin: "http://127.0.0.1:3080", autoStart: true, running, ownership: null, describe: null, webUrl: null, error: null });
  const models = (text: string) => ({ text, template: "{}", file: { format: "json", path: "/models.json" }, providers: [], parseError: null });
  function DshProbe() { const value = useDshHost(); useEffect(() => { latest = value; }); return null; }
  const emit = (name: string, engine?: string) => { for (const cb of subscriptions.get(name) ?? []) cb({ payload: { engine } }); };

  beforeEach(() => {
    for (const value of Object.values(mocks)) if (typeof value === "function" && "mockReset" in value) value.mockReset();
    subscriptions.clear();
    mocks.apiProps = null; mocks.customProps = null;
    mocks.listen.mockImplementation((name: string, cb: EventCallback) => {
      const callbacks = subscriptions.get(name) ?? new Set<EventCallback>();
      callbacks.add(cb); subscriptions.set(name, callbacks);
      return Promise.resolve(() => callbacks.delete(cb));
    });
    mocks.getAppSettings.mockResolvedValue({ dshHost: "127.0.0.1", dshPort: 3080 });
    mocks.dshHostStatus.mockResolvedValue(dshStatus());
    mocks.piFamilyAuthList.mockResolvedValue({ providers: [], oauthProviders: [], store: { path: "/auth.json" } });
    mocks.piFamilyModelsConfigRead.mockResolvedValue(models("old config"));
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { if (root) await act(async () => root!.unmount()); container.remove(); });

  it("refreshes DSH on host changes and reconnect without clearing connection drafts", async () => {
    await act(async () => root!.render(<DshProbe />));
    await act(async () => { latest.setHostDraft("unfinished host"); latest.setPortDraft("4555"); });
    mocks.dshHostStatus.mockResolvedValue(dshStatus(true));
    await act(async () => emit("engine-config://changed", "dsh"));
    expect(latest.status?.running).toBe(true);
    expect(latest.hostDraft).toBe("unfinished host"); expect(latest.portDraft).toBe("4555");
    const before = mocks.dshHostStatus.mock.calls.length;
    await act(async () => emit("engine-config://changed", "pi"));
    expect(mocks.dshHostStatus).toHaveBeenCalledTimes(before);
    await act(async () => emit("transport://connected"));
    expect(mocks.dshHostStatus.mock.calls.length).toBeGreaterThan(before);
    expect(latest.hostDraft).toBe("unfinished host");
    await act(async () => root!.unmount()); root = null;
    expect([...subscriptions.values()].every((callbacks) => callbacks.size === 0)).toBe(true);
  });

  it("keeps the newest DSH status when probes resolve out of order", async () => {
    await act(async () => root!.render(<DshProbe />));
    const old = Promise.withResolvers<ReturnType<typeof dshStatus>>();
    mocks.dshHostStatus.mockReturnValueOnce(old.promise).mockResolvedValue(dshStatus(true));
    await act(async () => emit("engine-config://changed", "dsh"));
    await act(async () => emit("transport://connected"));
    await act(async () => old.resolve(dshStatus(false)));
    expect(latest.status?.running).toBe(true);
  });

  it("refreshes Pi facts while preserving unsaved key and models drafts", async () => {
    await act(async () => root!.render(<PiFamilyAuthSection engine="pi" />));
    await act(async () => { mocks.apiProps!.onOpenEditor("openai"); mocks.customProps!.onToggleEditor(); });
    await act(async () => { mocks.apiProps!.onDraftKeyChange("unsaved key"); mocks.customProps!.onDraftChange("unsaved models"); });
    mocks.piFamilyModelsConfigRead.mockResolvedValue(models("new host config"));
    await act(async () => emit("engine-config://changed", "pi"));
    expect(mocks.customProps!.modelsConfig?.text).toBe("new host config");
    expect(mocks.apiProps!.draftKey).toBe("unsaved key");
    expect(mocks.customProps!.draft).toBe("unsaved models");
    expect(mocks.customProps!.editorOpen).toBe(true);
    await act(async () => emit("transport://connected"));
    expect(mocks.customProps!.draft).toBe("unsaved models");
  });
});
