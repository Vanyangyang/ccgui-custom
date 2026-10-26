import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SYNTHETIC_ACCOUNT = "ABCDEF-123456-789ABC";
const SYNTHETIC_PROJECT = "project-example";
// Shapes, not real values: tests must not republish any real account or project.
const BILLING_ACCOUNT_RE = /\b[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}\b/i;
const GENERATED_PROJECT_RE = /\bproject-[0-9a-f]{8}-[0-9a-f]{4}/i;
const CURRENCY_AMOUNT_RE = /\$\d[\d,]*\.\d{2}/;

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
    agyVertexCreditsRead: vi.fn(() =>
      Promise.resolve({
        billingAccountId: null,
        freeTrialCredit: null,
        freeTrialOriginalCredit: null,
        freeTrialRemainingPercent: null,
        gdpMonthlyCredit: null,
        gdpMonthlyRemainingPercent: null,
        errorCode: "not_connected",
      }),
    ),
    agyVertexConfigRead: vi.fn(() =>
      Promise.resolve({
        configured: false,
        projectId: null,
        location: "global",
        model: "gemini-4-argon",
        keyFileHint: ".gemini/vertex-gemini-4-argon.txt",
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
import {
  applyConfigSnapshot,
  applyCreditsSnapshot,
  DEFAULT_CONFIG_SNAPSHOT,
  DEFAULT_CREDITS_SNAPSHOT,
} from "./agy-vertex-guardrail";
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
    mutate: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
    expect(mask!.className).toContain("absolute");
    expect(mask!.className).toContain("inset-0");

    expect(wrapper.textContent).toContain(i18n.t("settings.cliOfficial"));
    expect(wrapper.querySelector("[data-testid='pi-auth-section']")).not.toBeNull();
    expect(wrapper.textContent).toContain(i18n.t("settings.cliChannels"));

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
    applyCreditsSnapshot(DEFAULT_CREDITS_SNAPSHOT);
    applyConfigSnapshot(DEFAULT_CONFIG_SNAPSHOT);
    vi.mocked(ipc.agyVertexCreditsRead).mockResolvedValue(DEFAULT_CREDITS_SNAPSHOT);
    vi.mocked(ipc.agyVertexConfigRead).mockResolvedValue(DEFAULT_CONFIG_SNAPSHOT);
    vi.clearAllMocks();

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

  it("agy: Vertex guardrail row opens detail with unconfigured notice, generic links, and no key", async () => {
    await render(makeCli({ engine: "agy" }));
    const title = i18n.t("settings.agyVertexTitle");
    expect(container.textContent).toContain(title);
    const row = container.querySelector("[data-setting-anchor='agyVertexGuardrail']");
    expect(row).toBeTruthy();
    await act(async () => (row as HTMLElement).click());
    const page = document.body.textContent ?? "";
    expect(page).toContain("gemini-4-argon");
    // 不包含任何硬编码个人项目、账号或固定余额
    expect(page).not.toMatch(BILLING_ACCOUNT_RE);
    expect(page).not.toMatch(GENERATED_PROJECT_RE);
    expect(page).not.toMatch(CURRENCY_AMOUNT_RE);
    // 未配置项目说明与未连接状态
    expect(page).toContain(i18n.t("settings.agyVertexProjectUnconfigured"));
    expect(page).toContain(i18n.t("settings.agyVertexNotConnected"));
    expect(page).toContain(i18n.t("settings.agyVertexStepsGuide"));
    expect(page).not.toContain("AQ.");
    expect(page).not.toContain("AIza");

    const creditsBtn = document.body.querySelector(
      `button[aria-label="${i18n.t("settings.agyVertexOpenCredits")}"]`,
    ) as HTMLButtonElement | null;
    expect(creditsBtn).toBeTruthy();
    expect(creditsBtn?.title).toBe("https://console.cloud.google.com/billing");

    // Users without Google Cloud learn the Antigravity quota still works and how to start.
    const noCloud = document.body.querySelector("[data-testid='agy-vertex-no-cloud']");
    expect(noCloud?.textContent).toContain(i18n.t("settings.agyVertexNoCloudTitle"));
    const freeTrialBtn = document.body.querySelector(
      `button[aria-label="${i18n.t("settings.agyVertexOpenFreeTrial")}"]`,
    ) as HTMLButtonElement | null;
    expect(freeTrialBtn?.title).toBe("https://console.cloud.google.com/freetrial");
    // The key file is key=value lines, not a bare key.
    expect(page).toContain("api_key=");
    expect(page).toContain("project=");
  });

  it("agy: reflects local metadata and synced credits when configured", async () => {
    const configData = {
      configured: true,
      projectId: SYNTHETIC_PROJECT,
      location: "global",
      model: "gemini-4-argon",
      keyFileHint: ".gemini/vertex-gemini-4-argon.txt",
    };
    const creditsData = {
      billingAccountId: SYNTHETIC_ACCOUNT,
      freeTrialCredit: "$120.00",
      freeTrialOriginalCredit: "$300.00",
      freeTrialRemainingPercent: 40,
      gdpMonthlyCredit: "$50.00",
      gdpMonthlyRemainingPercent: 100,
    };
    vi.mocked(ipc.agyVertexConfigRead).mockResolvedValue(configData);
    vi.mocked(ipc.agyVertexCreditsRead).mockResolvedValue(creditsData);
    applyConfigSnapshot(configData);
    applyCreditsSnapshot(creditsData);

    await render(makeCli({ engine: "agy" }));
    const row = container.querySelector("[data-setting-anchor='agyVertexGuardrail']");
    expect(row).toBeTruthy();
    await act(async () => (row as HTMLElement).click());
    const page = document.body.textContent ?? "";

    expect(page).toContain(SYNTHETIC_PROJECT);
    expect(page).toContain(SYNTHETIC_ACCOUNT);
    expect(page).toContain("$120.00 / $300.00 (40%)");
    expect(page).toContain("$50.00 (100%)");
    expect(page).toContain(`projects/${SYNTHETIC_PROJECT}`);
    expect(document.body.querySelector("[data-testid='agy-vertex-no-cloud']")).toBeNull();

    const creditsBtn = document.body.querySelector(
      `button[aria-label="${i18n.t("settings.agyVertexOpenCredits")}"]`,
    ) as HTMLButtonElement | null;
    expect(creditsBtn?.title).toBe(
      `https://console.cloud.google.com/billing/${SYNTHETIC_ACCOUNT}/credits/all`,
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
    expect(text).toContain(i18n.t("settings.agyVertexBillingSourceNote"));
    expect(text).toContain(".gemini/vertex-gemini-4-argon.txt");
    expect(text).toContain("500");
    // 初始未连接状态不展示旧维护者金额
    expect(text).not.toMatch(CURRENCY_AMOUNT_RE);
    expect(text).not.toMatch(BILLING_ACCOUNT_RE);

    // Click configure naming / mount button to open inline editor
    const configBtn = Array.from(section!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === i18n.t("settings.agyByokConfigureNaming"),
    );
    expect(configBtn).toBeTruthy();
    await act(async () => configBtn!.click());

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

  it("agy: prevents channel sync when metadata is missing", async () => {
    await render(makeCli({ engine: "agy" }));
    const section = container.querySelector("[data-testid='agy-byok-section']")!;
    const configBtn = Array.from(section.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === i18n.t("settings.agyByokConfigureNaming"),
    )!;
    await act(async () => configBtn.click());

    const checkbox = section.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    expect(checkbox.disabled).toBe(true);

    const saveBtn = Array.from(section.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === i18n.t("settings.agyByokSaveMount"),
    )!;
    await act(async () => saveBtn.click());

    // 仅保存模型，不调用 upsertProvider
    expect(ipc.updateAppSettings).toHaveBeenCalled();
    expect(ipc.upsertProvider).not.toHaveBeenCalled();
  });

  it("agy: channel sync validates model matching and generates correct provider entry", async () => {
    const configData = {
      configured: true,
      projectId: SYNTHETIC_PROJECT,
      location: "global",
      model: "gemini-4-argon",
      keyFileHint: ".gemini/vertex-gemini-4-argon.txt",
    };
    vi.mocked(ipc.agyVertexConfigRead).mockResolvedValue(configData);
    applyConfigSnapshot(configData);

    await render(makeCli({ engine: "agy" }));
    const section = container.querySelector("[data-testid='agy-byok-section']")!;
    const configBtn = Array.from(section.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === i18n.t("settings.agyByokConfigureNaming"),
    )!;
    await act(async () => configBtn.click());

    // 输入不匹配的模型 ID 进行测试
    const modelInput = section.querySelector<HTMLInputElement>("#agy-byok-model-id")!;
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(modelInput, "mismatched-model");
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
      modelInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const saveBtn = Array.from(section.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === i18n.t("settings.agyByokSaveMount"),
    )!;
    await act(async () => saveBtn.click());

    // 匹配失败报错，不调用 upsertProvider
    expect(section.textContent).toContain(i18n.t("settings.agyByokErrorModelMismatch"));
    expect(ipc.upsertProvider).not.toHaveBeenCalled();

    // 换回匹配的模型 ID
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(modelInput, "gemini-4-argon");
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
      modelInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => saveBtn.click());

    // 成功同步渠道，带有真实 metadata
    expect(ipc.upsertProvider).toHaveBeenCalledWith(
      "agy",
      "agy-vertex-byok",
      expect.objectContaining({
        baseUrl: expect.stringContaining(`projects/${SYNTHETIC_PROJECT}`),
        remark: expect.stringContaining(SYNTHETIC_PROJECT),
        model: "gemini-4-argon",
      }),
    );
  });

  it("agy: a failed native refresh clears the old quota and reports failure", async () => {
    await render(makeCli({ engine: "agy" }));
    const section = container.querySelector("[data-testid='agy-byok-section']")!;
    expect(section.textContent).toContain("500");
    vi.mocked(ipc.agyQuotaRead).mockRejectedValueOnce(new Error("offline"));
    const refresh = section.querySelector<HTMLButtonElement>(
      `button[aria-label="${i18n.t("chat.agyQuotaManualRefresh")}"]`,
    )!;
    await act(async () => refresh.click());
    expect(section.textContent).not.toContain("500");
    expect(section.textContent).toContain(i18n.t("chat.agyQuotaQueryFailed"));
  });
  it("agy: syncing Vertex credits never starts a native quota probe", async () => {
    await render(makeCli({ engine: "agy" }));
    const section = container.querySelector("[data-testid='agy-byok-section']")!;
    vi.mocked(ipc.agyQuotaRead).mockClear();
    const refresh = section.querySelector<HTMLButtonElement>(
      `button[aria-label="${i18n.t("settings.agyByokRefresh")}"]`,
    )!;
    await act(async () => refresh.click());
    expect(ipc.agyQuotaRead).toHaveBeenCalledWith({ force: false, cacheOnly: true });
    expect(vi.mocked(ipc.agyQuotaRead).mock.calls.every(([options]) => options?.force !== true)).toBe(true);
    expect(section.textContent).toContain(i18n.t("chat.agyQuotaManualWarning"));
  });
  it.each(["auth_expired", "auth_changed"])("agy: explains native credential failure %s", async errorCode => {
    await render(makeCli({ engine: "agy" }));
    const section = container.querySelector("[data-testid='agy-byok-section']")!;
    vi.mocked(ipc.agyQuotaRead).mockResolvedValueOnce({ status: "unavailable", groups: [], errorCode });
    const refresh = section.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("chat.agyQuotaManualRefresh")}"]`)!;
    await act(async () => refresh.click());
    expect(section.textContent).toContain(i18n.t(errorCode === "auth_expired" ? "chat.agyQuotaAuthExpired" : "chat.agyQuotaAuthChanged"));
    expect(section.textContent).not.toContain("500");
    expect(ipc.agyQuotaRead).toHaveBeenLastCalledWith({ force: true, cacheOnly: false });
  });
  it("agy: a hung native refresh times out and cannot publish a late balance", async () => {
    await render(makeCli({ engine: "agy" }));
    const section = container.querySelector("[data-testid='agy-byok-section']")!;
    let resolve!: (value: Awaited<ReturnType<typeof ipc.agyQuotaRead>>) => void;
    vi.mocked(ipc.agyQuotaRead).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    vi.useFakeTimers();
    try {
      const refresh = section.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t("chat.agyQuotaManualRefresh")}"]`)!;
      await act(async () => refresh.click());
      expect(refresh.disabled).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(40_000));
      expect(section.textContent).toContain(i18n.t("chat.agyQuotaTimeout"));
      // The shared feedback component finishes its current 600ms spin lap.
      await act(async () => vi.advanceTimersByTimeAsync(600));
      expect(refresh.disabled).toBe(false);
      await act(async () => resolve({ status: "ready", groups: [], credits: { remaining: 98765 } }));
      expect(section.textContent).not.toContain("98765");
    } finally { vi.useRealTimers(); }
  });
});
