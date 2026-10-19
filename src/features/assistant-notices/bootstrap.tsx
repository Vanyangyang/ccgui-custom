import React from "react";
import ReactDOM from "react-dom/client";
import i18n from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { applyTheme, THEME_STORAGE_KEY } from "@/features/settings/theme";
import { applyFontPreferences, readCachedFontPreferences } from "@/features/settings/font";
import { installTauriUnlistenGuard } from "@/lib/tauri-unlisten-guard";
import { AssistantNoticesOverlay } from "./AssistantNoticesOverlay";
import { AppCrashBoundary } from "@/components/crash/AppCrashBoundary";
import { installGlobalCrashHandlers } from "@/lib/crash";
import { listen } from "@/lib/transport";

/** This window never initializes the chat store, update handoff or plugins. */
export function startAssistantNoticesApp() {
  installTauriUnlistenGuard();
  installGlobalCrashHandlers();
  let disposed = false;
  let readGeneration = 0;
  let unlisten: (() => void) | undefined;
  let currentTheme = "";
  const theme=window.localStorage.getItem(THEME_STORAGE_KEY);
  if(theme)applyTheme(theme);
  applyFontPreferences(readCachedFontPreferences());
  document.documentElement.style.background="transparent";
  document.body.style.background="transparent";
  const root = ReactDOM.createRoot(document.getElementById("root")!);
  // The shared boundary marks appMounted after React commits, and renders a
  // useful crash surface if the overlay fails. Never disable the watchdog
  // merely because createRoot/render was called.
  root.render(<React.StrictMode><AppCrashBoundary><AssistantNoticesOverlay /></AppCrashBoundary></React.StrictMode>);
  const refresh = () => {
    const turn = ++readGeneration;
    void ipc.refreshAppSettings().then(settings => {
      if (disposed || turn !== readGeneration) return;
      currentTheme = settings.theme;
      applyTheme(settings.theme);
      applyFontPreferences({ fontFamily: settings.fontFamily ?? "", codeFontFamily: settings.codeFontFamily ?? "", fontFile: settings.fontFile ?? "", codeFontFile: settings.codeFontFile ?? "" });
      if (settings.language && settings.language !== i18n.language) void i18n.changeLanguage(settings.language);
    }).catch(() => {});
  };
  // Read immediately, then catch up after registration to close the startup gap.
  refresh();
  void listen("settings://changed", refresh).then(stopListening => {
    if (disposed) stopListening(); else { unlisten = stopListening; refresh(); }
  }).catch(() => {});
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const systemThemeChanged = () => { if (!disposed && currentTheme === "system") applyTheme("system"); };
  media?.addEventListener("change", systemThemeChanged);
  const stop = () => {
    if (disposed) return;
    disposed = true;
    readGeneration++;
    unlisten?.();
    media?.removeEventListener("change", systemThemeChanged);
    root.unmount();
  };
  if (import.meta.hot) import.meta.hot.dispose(stop);
  return stop;
}
