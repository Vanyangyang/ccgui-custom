import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantNoticesStatus, CompletionAudioSettings, CompletionAudioView, CompletionAudioVoice } from "./types";
import { defaultNoticeConfig } from "./config";
const mock = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), models: vi.fn(), providers: vi.fn(), isWeb: false }));
vi.mock("@/lib/transport", () => mock);
vi.mock("@/lib/platform", () => ({ isWeb: false, IS_WINDOWS: true }));
vi.mock("@/lib/ipc", () => ({ ipc: { autoTitleModels: mock.models, getCliConfig: mock.providers } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options ? `${key}:${JSON.stringify(options)}` : key, i18n: { language: "zh-CN" } }),
}));
import { useCompletionAudio } from "./use-completion-audio";
import { AssistantNoticesControl } from "./AssistantNoticesControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const status: AssistantNoticesStatus = { ...defaultNoticeConfig, available: true, observerAvailable: true, voiceAvailable: true, sourceEngines: ["codex", "cursor"], revision: 1, reason: "", model: "gemini-4-argon", effort: "medium", provider: "vertex" };
const defaults: CompletionAudioSettings = {
  mode: "chimeAndVoice", chimeVolume: 40, voiceVolume: 80, quietHours: true, quietStart: 22, quietEnd: 8,
  engines: { codex: { chime: 1, voice: "", pitch: 100 }, cursor: { chime: 8, voice: "", pitch: 80 } },
};
const autoVoices = { codex: { zh: "Kangkang", en: "David" }, cursor: { zh: "Kangkang", en: "Mark" } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

let native: { settings: CompletionAudioSettings; revision: number };
let voices: CompletionAudioVoice[];
const view = (): CompletionAudioView => ({ settings: native.settings, revision: native.revision, defaults, autoVoices, chimeCount: 13 });
const calls = (command: string) => mock.invoke.mock.calls.filter(([name]) => name === command);
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  native = { settings: structuredClone(defaults), revision: 1 };
  voices = [{ name: "Microsoft Huihui", language: "zh-CN", gender: "female" }];
  mock.models.mockReset().mockResolvedValue([]); mock.providers.mockReset().mockResolvedValue({});
  mock.listen.mockReset().mockResolvedValue(vi.fn());
  mock.invoke.mockReset().mockImplementation(async (command: string, args?: { settings: CompletionAudioSettings; expectedRevision: number }) => {
    if (command === "assistant_notices_status") return status;
    if (command === "assistant_notices_displays") return [];
    if (command === "assistant_notices_audio_settings") return view();
    if (command === "assistant_notices_audio_voices") return voices;
    if (command === "assistant_notices_audio_preview") return null;
    if (command === "assistant_notices_audio_configure") {
      if (args!.expectedRevision !== native.revision) throw new Error("config_conflict");
      native = { settings: args!.settings, revision: native.revision + 1 }; return view();
    }
    throw new Error(command);
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("completion audio settings hook", () => {
  let current: ReturnType<typeof useCompletionAudio>;
  function Harness({ enabled }: { enabled: boolean }) { current = useCompletionAudio(enabled); return null; }
  const mount = (enabled = true) => act(async () => root.render(<Harness enabled={enabled} />));

  it("waits for a usable service before reading settings and voices", async () => {
    await mount(false);
    expect(calls("assistant_notices_audio_settings")).toHaveLength(0);
    expect(current.draft).toBeNull();
    await mount(true);
    expect(current.draft).toEqual(defaults);
    expect(current.voices).toEqual(voices);
    expect(current.dirty).toBe(false);
  });

  it("keeps edits through a conflict and replays only touched fields over the newer revision", async () => {
    await mount();
    await act(async () => { current.change({ voiceVolume: 100 }); current.changeEngine("codex", { voice: "Microsoft Huihui" }); });
    native = { settings: { ...defaults, chimeVolume: 60, engines: { ...defaults.engines, cursor: { ...defaults.engines.cursor, pitch: 90 } } }, revision: 2 };
    await act(async () => { await expect(current.save()).rejects.toThrow("config_conflict"); });
    expect(current.error).toBe("assistantNotices.configConflict");
    expect(current.draft).toMatchObject({ voiceVolume: 100, chimeVolume: 40 });
    await act(async () => current.reload());
    expect(current.draft).toEqual({ ...defaults, chimeVolume: 60, voiceVolume: 100, engines: { codex: { chime: 1, voice: "Microsoft Huihui", pitch: 100 }, cursor: { chime: 8, voice: "", pitch: 90 } } });
    expect(current.dirty).toBe(true);
    await act(async () => current.save());
    expect(calls("assistant_notices_audio_configure").at(-1)![1]).toMatchObject({ expectedRevision: 2 });
    expect(native).toMatchObject({ revision: 3, settings: { chimeVolume: 60, voiceVolume: 100 } });
    expect(current.dirty).toBe(false);
    expect(current.error).toBe("");
  });

  it("stages defaults on reset without writing anything", async () => {
    native.settings = { ...defaults, mode: "voiceOnly", engines: { ...defaults.engines, codex: { chime: 12, voice: "Microsoft Huihui", pitch: 150 } } };
    await mount();
    await act(async () => current.reset());
    expect(current.draft).toEqual(defaults);
    expect(current.dirty).toBe(true);
    expect(calls("assistant_notices_audio_configure")).toHaveLength(0);
  });

  it("previews the unsaved draft for one engine and reports preview failures", async () => {
    await mount();
    await act(async () => current.change({ mode: "chimeOnly", chimeVolume: 70 }));
    await act(async () => current.preview("cursor"));
    expect(calls("assistant_notices_audio_preview")).toEqual([["assistant_notices_audio_preview", { engine: "cursor", settings: { ...defaults, mode: "chimeOnly", chimeVolume: 70 } }]]);
    expect(calls("assistant_notices_audio_configure")).toHaveLength(0);
    mock.invoke.mockRejectedValueOnce(new Error("voice_unavailable"));
    await act(async () => { await expect(current.preview("cursor")).rejects.toThrow(); });
    expect(current.previewError).toBe("assistantNotices.audioPreviewError");
    await act(async () => current.preview("codex"));
    expect(current.previewError).toBe("");
  });

  it("ignores a settings read that finishes after the hook is disabled", async () => {
    const late = deferred<CompletionAudioView>();
    const original = mock.invoke.getMockImplementation()!;
    mock.invoke.mockImplementation((command: string, args?: never) => command === "assistant_notices_audio_settings" ? late.promise : original(command, args));
    await mount(true);
    await mount(false);
    await act(async () => late.resolve(view()));
    expect(current.draft).toBeNull();
  });

  it("reports unreadable settings and voices without inventing data", async () => {
    mock.invoke.mockImplementation(async (command: string) => command === "assistant_notices_audio_settings" ? { revision: "x" } : command === "assistant_notices_audio_voices" ? Promise.reject(new Error("voice_unavailable")) : null);
    await mount();
    expect(current.error).toBe("assistantNotices.audioSettingsError");
    expect(current.voicesError).toBe(true);
    expect(current.draft).toBeNull();
    await act(async () => { await current.save(); current.change({ voiceVolume: 10 }); });
    expect(calls("assistant_notices_audio_configure")).toHaveLength(0);
  });
});

describe("completion audio settings page", () => {
  const button = (selector: string) => container.querySelector<HTMLButtonElement>(selector)!;
  const save = () => Array.from(container.querySelectorAll("button")).find(node => node.textContent === "assistantNotices.save")!;

  it("lists enabled engines with their auto voice, keeps uninstalled choices and saves only audio edits", async () => {
    native.settings = { ...defaults, engines: { ...defaults.engines, cursor: { chime: 8, voice: "Microsoft Ghost", pitch: 80 } } };
    await act(async () => root.render(<AssistantNoticesControl />));
    expect(container.textContent).toContain('assistantNotices.audioVoiceAutoNamed:{"name":"Kangkang"}');
    expect(container.textContent).toContain('assistantNotices.audioVoiceMissing:{"name":"Microsoft Ghost"}');
    expect(container.querySelectorAll('button[aria-label^="assistantNotices.audioPreviewFor"]')).toHaveLength(2);
    expect(save().disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="assistantNotices.quietHours"]')!.click());
    expect(container.querySelector('[aria-label="assistantNotices.quietStart"]')).toBeNull();
    await act(async () => save().click());
    expect(calls("assistant_notices_audio_configure")).toEqual([["assistant_notices_audio_configure", { settings: { ...native.settings }, expectedRevision: 1 }]]);
    expect(native.settings.quietHours).toBe(false);
    expect(native.settings.engines.cursor.voice).toBe("Microsoft Ghost");
    expect(calls("assistant_notices_configure")).toHaveLength(0);
  });

  it("previews one engine from its row and surfaces a failed preview", async () => {
    await act(async () => root.render(<AssistantNoticesControl />));
    await act(async () => button('button[aria-label^="assistantNotices.audioPreviewFor"][aria-label*="Codex"]').click());
    expect(calls("assistant_notices_audio_preview")).toEqual([["assistant_notices_audio_preview", { engine: "codex", settings: defaults }]]);
    mock.invoke.mockRejectedValueOnce(new Error("voice_unavailable"));
    await act(async () => button('button[aria-label^="assistantNotices.audioPreviewFor"][aria-label*="Cursor"]').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("assistantNotices.audioPreviewError");
  });

  it("skips audio IPC entirely when native speech is unavailable", async () => {
    mock.invoke.mockImplementation(async (command: string) => command === "assistant_notices_status" ? { ...status, voiceAvailable: false } : []);
    await act(async () => root.render(<AssistantNoticesControl />));
    expect(mock.invoke.mock.calls.some(([command]) => String(command).startsWith("assistant_notices_audio"))).toBe(false);
    expect(container.querySelector('[aria-label="assistantNotices.completionAudioMode"]')).not.toBeNull();
  });
});
