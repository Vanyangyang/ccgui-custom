import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    // The bin-path / custom-models rows read AppSettings on mount.
    getAppSettings: vi.fn(() => Promise.resolve({ customModels: {}, customModelLabels: {} })),
    updateAppSettings: vi.fn(() => Promise.resolve()),
    officialConfigRead: vi.fn(() =>
      Promise.resolve([
        {
          path: "~/.gemini/antigravity-cli/settings.json",
          format: "json",
          content: "",
          exists: true,
        },
      ]),
    ),
    agyQuotaRead: vi.fn(() =>
      Promise.resolve({
        status: "ready",
        groups: [{ id: "gemini", windows: { fiveHour: { usedPercentage: 12 } } }],
        credits: { remaining: 500 },
      }),
    ),
    upsertProvider: vi.fn(() => Promise.resolve()),
  },
}));
// The auth section owns its own ipc state; CliConfigBody only places it.
vi.mock("./PiFamilyAuthSection", () => ({
  PiFamilyAuthSection: () => <div data-testid="pi-auth-section" />,
}));

import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import i18n from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { CliConfigBody } from "./CliConfigBody";
import type { CliConfigState } from "./useCliConfig";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function makeCli(over: Partial<CliConfigState> = {}): CliConfigState {
  return {
    t: i18n.t,
    config: null,
    engine: "pi",
    error: null,
    notice: null,
    busy: false,
    dialog: null,
    setDialog: () => {},
    pendingDelete: null,
    setPendingDelete: () => {},
    ccStatus: null,
    currentId: "",
    enabled: true,
    entries: [],
    officialActive: true,
    officialEditing: false,
    setOfficialEditing: () => {},
    saveOfficialConfig: () => Promise.resolve(null),
    mutate: vi.fn(),
    activate: () => {},
    saveProvider: () => {},
    confirmDelete: () => {},
    syncCcSwitch: vi.fn(),
    importCcSwitchFile: vi.fn(),
    dismissCcSwitch: () => {},
    ...over,
  } as CliConfigState;
}

describe("CliConfigBody disabled overlay", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container.remove();
  });

  async function render(cli: CliConfigState) {
    root = createRoot(container);
    await act(async () => root?.render(<CliConfigBody cli={cli} />));
  }

  function overlay(): HTMLElement | null {
    const text = i18n.t("settings.cliDisabledOverlay");
    const node = Array.from(container.querySelectorAll("p")).find(
      (p) => p.textContent === text,
    );
    return (node?.parentElement as HTMLElement) ?? null;
  }

  it("disabled: overlay wrapper contains official config, auth and channels — but not the enable switch", async () => {
    await render(makeCli({ enabled: false }));

    const mask = overlay();
    expect(mask).not.toBeNull();
    const wrapper = mask!.parentElement!;
    // The mask is absolutely positioned over the wrapper, not inside a card.
    expect(mask!.className).toContain("absolute");
    expect(mask!.className).toContain("inset-0");

    // Everything below the enable switch is under the mask.
    expect(wrapper.textContent).toContain(i18n.t("settings.cliOfficial"));
    expect(wrapper.querySelector("[data-testid='pi-auth-section']")).not.toBeNull();
    expect(wrapper.textContent).toContain(i18n.t("settings.cliChannels"));

    // The enable switch sits above the mask, still reachable.
    const enableTitle = i18n.t("settings.cliEnableTitle", { name: "PI CLI" });
    expect(wrapper.textContent).not.toContain(enableTitle);
    expect(container.textContent).toContain(enableTitle);
  });

  it("enabled: no overlay is rendered", async () => {
    await render(makeCli({ enabled: true }));
    expect(overlay()).toBeNull();
  });
});

describe("CliEngineSettingsCard official edit entry", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container.remove();
  });

  async function render(cli: CliConfigState) {
    root = createRoot(container);
    await act(async () => root?.render(<CliConfigBody cli={cli} />));
  }

  function editButton(): HTMLButtonElement {
    const label = i18n.t("settings.cliEdit");
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
  }

  it("file-managed engine: 编辑 stays available while a custom channel is current", async () => {
    await render(makeCli({ engine: "claude", officialActive: false, currentId: "chan-a" }));
    expect(editButton().disabled).toBe(false);
  });

  it("file-managed engine: 编辑 opens the generic editor when 官方配置 is active", async () => {
    const setOfficialEditing = vi.fn();
    await render(makeCli({ engine: "claude", officialActive: true, setOfficialEditing }));
    expect(editButton().disabled).toBe(false);
    await act(async () => editButton().click());
    expect(setOfficialEditing).toHaveBeenCalledWith(true);
  });

  it("pi/omp: 编辑 is never gated (files are not cc-gui-managed)", async () => {
    await render(makeCli({ engine: "pi", officialActive: false, currentId: "chan-a" }));
    expect(editButton().disabled).toBe(false);
  });

  it("dsh: no official config row at all (no native config file)", async () => {
    await render(makeCli({ engine: "dsh" }));
    expect(container.textContent).not.toContain(i18n.t("settings.cliOfficial"));
  });

  it("codex: one path row (config home), not a separate binary override", async () => {
    await render(makeCli({ engine: "codex" }));
    expect(container.textContent).toContain(
      i18n.t("settings.cliCustomHome", { name: CLI_DISPLAY_NAMES.codex }),
    );
    expect(container.textContent).not.toContain(i18n.t("settings.cliCustomPathUnset"));
  });

  it("claude: does not show a Codex config-home row", async () => {
    await render(makeCli({ engine: "claude" }));
    expect(container.textContent).not.toContain(
      i18n.t("settings.cliCustomHome", { name: CLI_DISPLAY_NAMES.codex }),
    );
  });

  it("agy: Vertex guardrail row opens the detail and does not show a key", async () => {
    await render(makeCli({ engine: "agy" }));
    const title = i18n.t("settings.agyVertexTitle");
    expect(container.textContent).toContain(title);
    const row = container.querySelector("[data-setting-anchor='agyVertexGuardrail']");
    expect(row).toBeTruthy();
    await act(async () => (row as HTMLElement).click());
    const page = document.body.textContent ?? "";
    expect(page).toContain("gemini-4-argon");
    expect(page).toContain("project-1141a96f-5ab2-42b3-a5d");
    expect(page).toContain("01E559-FC92E9-D4E9E7");
    expect(page).toContain("$348.01 / $383.45 (91%)");
    expect(page).toContain("$51.13 (100%)");
    expect(page).toContain(":streamGenerateContent?alt=sse");
    expect(page).toContain("curl -X POST");
    expect(page).toContain(i18n.t("settings.agyVertexSpendBody"));
    expect(page).not.toContain("AQ.");
    expect(page).not.toContain("AIza");

    const creditsBtn = document.body.querySelector(
      `button[aria-label="${i18n.t("settings.agyVertexOpenCredits")}"]`,
    ) as HTMLButtonElement | null;
    expect(creditsBtn).toBeTruthy();
    expect(creditsBtn?.title).toBe(
      "https://console.cloud.google.com/billing/01E559-FC92E9-D4E9E7/credits/all?authuser=0&organizationId=0",
    );
  });

  it("claude: hides the Vertex guardrail row", async () => {
    await render(makeCli({ engine: "claude" }));
    expect(container.textContent).not.toContain(i18n.t("settings.agyVertexTitle"));
    expect(container.querySelector("[data-testid='agy-byok-section']")).toBeNull();
  });

  it("agy: separates native quota from unavailable Vertex balance and supports model naming", async () => {
    await render(makeCli({ engine: "agy" }));
    const section = container.querySelector("[data-testid='agy-byok-section']");
    expect(section).not.toBeNull();
    const text = section?.textContent ?? "";
    expect(text).toContain("$348.01 / $383.45 (91%)");
    expect(text).toContain("$51.13 (100%)");
    expect(text).toContain(i18n.t("settings.agyVertexBillingSourceNote"));
    expect(text).toContain("01E559-FC92E9-D4E9E7");
    expect(text).toContain(".gemini/vertex-gemini-4-argon.txt");
    expect(text).toContain("500");
    expect(text).not.toContain("AQ.");
    expect(text).not.toContain("AIza");

    // Click configure naming / mount button to open inline editor
    const configBtn = Array.from(section!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === i18n.t("settings.agyByokConfigureNaming"),
    );
    expect(configBtn).toBeTruthy();
    await act(async () => configBtn!.click());

    // Save with custom alias ("Gemini 4 Argon (Vertex)")
    const saveBtn = Array.from(section!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === i18n.t("settings.agyByokSaveMount"),
    );
    expect(saveBtn).toBeTruthy();
    await act(async () => saveBtn!.click());

    expect(ipc.updateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        customModels: { agy: ["gemini-4-argon"] },
        customModelLabels: { agy: { "gemini-4-argon": "Gemini 4 Argon (Vertex)" } },
      }),
    );
  });

  it("agy: a failed native refresh clears the old quota and reports failure", async () => {
    await render(makeCli({ engine: "agy" }));
    const section = container.querySelector("[data-testid='agy-byok-section']")!;
    expect(section.textContent).toContain("500");
    vi.mocked(ipc.agyQuotaRead).mockRejectedValueOnce(new Error("offline"));
    const refresh = section.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("settings.agyByokRefresh")}"]`)!;
    await act(async () => refresh.click());
    expect(section.textContent).not.toContain("500");
    expect(section.textContent).toContain(i18n.t("settings.agyByokRefreshFailed"));
  });
});
