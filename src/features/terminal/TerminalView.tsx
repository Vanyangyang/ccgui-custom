import { memo, useEffect, useRef, useState } from "react";
import type { IDisposable, Terminal } from "@xterm/xterm";
import { useTranslation } from "react-i18next";
import { isMacPlatform } from "@/features/shortcuts/shortcuts";
import { ipc } from "@/lib/ipc";
import { loadXterm, type XtermModules } from "./xterm-loader";
import { terminalFontFamily, terminalTheme } from "./appearance";
import { FONT_CHANGE_EVENT } from "@/features/settings/font";
import { createPathLinkProvider } from "./links";
import { TerminalContextMenu, type TerminalMenuState } from "./TerminalContextMenu";
import {
  ensureTerminalOutputListener,
  hasTerminalSession,
  markTerminalClosed,
  markTerminalOpened,
  setTerminalWriter,
  terminalBacklog,
} from "./sessions";

/**
 * One xterm instance for the active tab; remounts per tab (key = tab id).
 * The backend PTY session persists across mounts and buffered output replays
 * into the fresh instance, so collapse/tab switches lose nothing.
 * Memoized: the dock re-renders per animation frame during height drags, and
 * an xterm re-render per frame would jank the drag.
 */
export const TerminalView = memo(function TerminalView({ id, cwd }: { id: string; cwd: string }) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [xterm, setXterm] = useState<XtermModules | null>(null);
  const [menu, setMenu] = useState<TerminalMenuState | null>(null);
  // The live xterm instance, for the contextmenu handler outside the
  // setup effect's closure.
  const liveTermRef = useRef<Terminal | null>(null);

  // xterm loads lazily on mount; the module-level promise caches the load,
  // so this resolves immediately for every tab after the first.
  useEffect(() => {
    let cancelled = false;
    ensureTerminalOutputListener();
    void loadXterm()
      .then((modules) => {
        if (!cancelled) setXterm(modules);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !xterm) return;
    let resizeTimer: number | undefined;
    let termRef: Terminal | null = null;
    let inputDisposable: IDisposable | null = null;
    let linkDisposable: IDisposable | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    let fontListener: (() => void) | null = null;
    let disposed = false;
    try {
      const { Terminal, FitAddon, WebglAddon } = xterm;
      const term = new Terminal({
        fontFamily: terminalFontFamily(),
        fontSize: 12,
        cursorBlink: true,
        scrollback: 5000,
        theme: terminalTheme(),
        // Option-as-meta so word jumps (⌥←/⌥→) reach readline on macOS.
        macOptionIsMeta: true,
        // Option+click is the reveal gesture on macOS (links.ts); xterm's
        // default alt-click-moves-cursor would fire for the same click and
        // move the shell cursor to the clicked cell. Keep the feature where
        // it cannot collide (Windows/Linux reveal with Ctrl+click).
        altClickMovesCursor: !isMacPlatform(),
      });
      termRef = term;
      liveTermRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      try {
        // GPU renderer; falls back to canvas when WebGL is unavailable.
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // Canvas renderer remains active.
      }

      const backlog = terminalBacklog(id);
      if (backlog) term.write(backlog);
      setTerminalWriter(id, (data) => term.write(data));

      const openSession = () =>
        ipc
          .terminalOpen({ id, cwd, cols: term.cols, rows: term.rows })
          .then(() => {
            // Unmounted before the open resolved: leave the PTY alone (it
            // outlives the view by design — a remount reopens/reuses it),
            // but don't mark or touch state for a dead view.
            if (disposed) return;
            markTerminalOpened(id);
            setError(null);
          })
          .catch((e: unknown) => {
            if (!disposed) setError(String(e));
          });

      const safeFit = () => {
        try {
          fit.fit();
        } catch {
          // Zero-size host mid-layout; the next ResizeObserver tick refits.
        }
      };
      safeFit();
      void openSession();

      // Absolute paths in output become modifier-click-to-reveal links
      // (see links.ts).
      linkDisposable = term.registerLinkProvider(
        createPathLinkProvider({
          term,
          cwd,
          onActivate: (path) => {
            void ipc.revealInFileManager(path).catch(() => {});
          },
        }),
      );

      inputDisposable = term.onData((data) => {
        const write = () =>
          ipc.terminalWrite(id, data).catch((e: unknown) => {
            // Shell exited (exit/Ctrl-D): respawn, then deliver the input.
            if (String(e).includes("Terminal session not found")) {
              markTerminalClosed(id);
              void openSession().then(() =>
                ipc.terminalWrite(id, data).catch(() => {}),
              );
            }
          });
        if (hasTerminalSession(id)) void write();
        else void openSession().then(write);
      });

      resizeObserver = new ResizeObserver(() => {
        safeFit();
        // Fit every frame so the canvas tracks the drag; the PTY resize
        // itself waits for the drag to settle (one IPC per frame stalled
        // the backend and made resizing feel sticky).
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          resizeTimer = undefined;
          if (hasTerminalSession(id)) {
            void ipc.terminalResize(id, term.cols, term.rows).catch(() => {});
          }
        }, 150);
      });
      resizeObserver.observe(host);

      // Follow app theme flips (the dark class on <html>).
      themeObserver = new MutationObserver(() => {
        term.options.theme = terminalTheme();
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      // Follow 设置 → 通用 → 外观 → 代码字体 changes live.
      const onFontChange = () => {
        term.options.fontFamily = terminalFontFamily();
        safeFit();
      };
      window.addEventListener(FONT_CHANGE_EVENT, onFontChange);
      fontListener = onFontChange;
    } catch (e: unknown) {
      setError(String(e));
    }

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      inputDisposable?.dispose();
      linkDisposable?.dispose();
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      if (fontListener) window.removeEventListener(FONT_CHANGE_EVENT, fontListener);
      if (termRef) {
        setTerminalWriter(id, null);
        termRef.dispose();
        liveTermRef.current = null;
      }
    };
  }, [xterm, id, cwd]);

  return (
    <div
      className="relative min-h-0 flex-1 bg-background-full"
      onContextMenu={(e) => {
        // Only a non-empty selection earns a menu (copy / reveal in file
        // manager); otherwise the webview default is a no-op anyway.
        const selection = liveTermRef.current?.getSelection();
        if (!selection) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, text: selection });
      }}
    >
      <div ref={hostRef} className="terminal-host absolute inset-0" />
      {menu && (
        <TerminalContextMenu menu={menu} cwd={cwd} onClose={() => setMenu(null)} />
      )}
      {error && (
        <div className="absolute inset-x-0 top-0 z-10 border-b border-separator-border bg-background-quaternary-error px-3 py-1.5 text-caption-1-medium text-text-error-primary">
          {t("terminal.failed", { message: error })}
        </div>
      )}
    </div>
  );
});
