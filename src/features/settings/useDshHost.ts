import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ipc, type AppSettings, type DshHostStatus } from "@/lib/ipc";
import { pickFile } from "@/lib/platform";
import { useCliUpdateFlow, type CliUpdateFlow } from "./useCliUpdateFlow";
import { useCliVersionStatus } from "./useCliVersionStatus";
import { listen } from "@/lib/transport";
import { subscribeTauriEvent } from "@/hooks/use-tauri-event";

function useDshChanges(refresh: () => void) {
  useEffect(() => {
    const offConfig = subscribeTauriEvent(() => listen<{ engine: string }>("engine-config://changed", (event) => {
      if (event.payload.engine === "dsh") refresh();
    }));
    const offSettings = subscribeTauriEvent(() => listen("settings://changed", () => refresh()));
    const offConnected = subscribeTauriEvent(() => listen("transport://connected", () => refresh()));
    return () => { offConfig(); offSettings(); offConnected(); };
  }, [refresh]);
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3080;
const PORT_MIN = 1;
const PORT_MAX = 65535;

/** Connection lifecycle, derived from the status snapshot + busy flags. */
export type HostState = "checking" | "starting" | "missing" | "connected" | "down";

export interface DshHostSectionState {
  t: TFunction;
  status: DshHostStatus | null;
  probeError: string | null;
  cliError: string | null;
  saveError: string | null;
  checking: boolean;
  starting: boolean;
  stopping: boolean;
  updating: boolean;
  actionBusy: boolean;
  connOpen: boolean | null;
  setConnOpen: Dispatch<SetStateAction<boolean | null>>;
  hostDraft: string | null;
  setHostDraft: Dispatch<SetStateAction<string | null>>;
  portDraft: string | null;
  setPortDraft: Dispatch<SetStateAction<string | null>>;
  host: string;
  port: number;
  origin: string;
  autoStart: boolean;
  dshBin: string;
  hostState: HostState;
  refreshStatus: (manual?: boolean) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  updateCli: () => Promise<void>;
  updateFlow: CliUpdateFlow;
  save: (patch: Partial<AppSettings>) => Promise<void>;
  commitHost: () => void;
  commitPort: () => void;
  chooseBin: () => Promise<void>;
}

/** View state derived from the status snapshot + settings + busy flags,
 *  kept as a plain function so the composing hook stays flat. */
function deriveDshView(
  status: DshHostStatus | null,
  settings: AppSettings | null,
  probeError: string | null,
  busy: { checking: boolean; starting: boolean; stopping: boolean; updating: boolean },
) {
  const host = status?.host ?? settings?.dshHost?.trim() ?? DEFAULT_HOST;
  const port = status?.port ?? settings?.dshPort ?? DEFAULT_PORT;
  const origin = status?.origin ?? `http://${host}:${port}`;
  const autoStart = status?.autoStart ?? (settings?.dshAutoStart !== false);
  const dshBin = settings?.dshBin?.trim() ?? "";
  const hostState: HostState = busy.starting
    ? "starting"
    : status == null && !probeError
      ? "checking"
      : !status?.installed
        ? "missing"
        : status.running
          ? "connected"
          : "down";
  const actionBusy = busy.checking || busy.starting || busy.stopping || busy.updating;
  return { host, port, origin, autoStart, dshBin, hostState, actionBusy };
}

/**
 * Local host status probe + start/stop actions. Probes run on mount and
 * explicit user actions only — the host has no push channel and polling
 * would keep the app awake for nothing.
 */
function useDshHostProbe() {
  const mounted = useRef(true);
  const sequence = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current += 1; }; }, []);
  const [status, setStatus] = useState<DshHostStatus | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  // Busy flags per action so buttons disable independently.
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  // null = not yet decided; first status snapshot picks the default
  // (open when the host is down or auto-start is off).
  const [connOpen, setConnOpen] = useState<boolean | null>(null);

  const refreshStatus = useCallback(async (manual = false) => {
    const ticket = ++sequence.current;
    const active = () => mounted.current && sequence.current === ticket;
    if (manual) setChecking(true);
    try {
      const next = await ipc.dshHostStatus();
      if (!active()) return;
      setStatus(next);
      setProbeError(null);
      setConnOpen((open) => open ?? (!next.running || next.autoStart === false));
    } catch (e) {
      if (active()) setProbeError(String(e));
    } finally {
      if (active()) setChecking(false);
    }
  }, []);

  const start = useCallback(async () => {
    const ticket = ++sequence.current;
    setStarting(true);
    try {
      const next = await ipc.dshHostStart();
      if (mounted.current && sequence.current === ticket) { setStatus(next); setProbeError(null); }
    } catch (e) {
      if (mounted.current && sequence.current === ticket) setProbeError(String(e));
    } finally {
      if (mounted.current) setStarting(false);
    }
  }, []);

  const stop = useCallback(async () => {
    const ticket = ++sequence.current;
    setStopping(true);
    try {
      await ipc.dshHostStop();
      if (!mounted.current || sequence.current !== ticket) return;
      setStatus((s) => (s ? { ...s, running: false, ownership: null, describe: null } : s));
      setProbeError(null);
      // Confirm against the real probe (stop may have missed an adopted host).
      void refreshStatus();
    } catch (e) {
      if (mounted.current && sequence.current === ticket) setProbeError(String(e));
    } finally {
      if (mounted.current) setStopping(false);
    }
  }, [refreshStatus]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);
  useDshChanges(refreshStatus);

  return {
    status,
    probeError,
    checking,
    starting,
    stopping,
    connOpen,
    setConnOpen,
    refreshStatus,
    start,
    stop,
  };
}

/**
 * App-settings snapshot + save funnel. Read-modify-write (same funnel as
 * GeneralSection): the local snapshot descends from a mount-time read, so
 * apply each patch onto a fresh read instead of persisting the whole object.
 */
function useDshSettings() {
  const mounted = useRef(true);
  const sequence = useRef(0);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current += 1; }; }, []);
  const refresh = useCallback(() => {
    const ticket = ++sequence.current;
    void ipc.getAppSettings().then((next) => {
      if (mounted.current && sequence.current === ticket) setSettings(next);
    }).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  useDshChanges(refresh);

  const save = useCallback(async (patch: Partial<AppSettings>) => {
    try {
      const latest = await ipc.getAppSettings();
      const next = { ...latest, ...patch };
      await ipc.updateAppSettings(next);
      if (!mounted.current) return;
      // A settings broadcast may race this write response: re-read instead of
      // publishing the pre-write snapshot over another client's newer config.
      refresh();
      setSaveError(null);
    } catch (e) {
      if (mounted.current) setSaveError(String(e));
    }
  }, [refresh]);

  return { settings, saveError, save };
}

/** Host/port drafts (draft on type, commit on blur/Enter) + bin picker. */
function useDshConnectionForm({
  t,
  host,
  port,
  save,
  refreshStatus,
}: {
  t: TFunction;
  host: string;
  port: number;
  save: (patch: Partial<AppSettings>) => Promise<void>;
  refreshStatus: () => Promise<void>;
}) {
  // Raw drafts while editing host/port; null = show the saved value.
  const [hostDraft, setHostDraft] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);

  const commitHost = useCallback(() => {
    const draft = hostDraft?.trim();
    setHostDraft(null);
    if (!draft || draft === host) return;
    // Origin changed → re-probe after persisting.
    void save({ dshHost: draft }).then(() => void refreshStatus());
  }, [hostDraft, host, save, refreshStatus]);

  const commitPort = useCallback(() => {
    const draft = portDraft;
    setPortDraft(null);
    if (!draft) return;
    const n = Number(draft);
    if (!Number.isInteger(n) || n < PORT_MIN || n > PORT_MAX || n === port) return;
    void save({ dshPort: n }).then(() => void refreshStatus());
  }, [portDraft, port, save, refreshStatus]);

  const chooseBin = useCallback(async () => {
    const path = await pickFile(t("settings.dshCustomPath"), []);
    if (path) void save({ dshBin: path });
  }, [t, save]);

  return { hostDraft, setHostDraft, portDraft, setPortDraft, commitHost, commitPort, chooseBin };
}

/**
 * State + action funnel for DshHostSection: CLI version/update, local host
 * status (adopt or spawn on demand), and the connection settings (custom bin
 * path, host/port, auto-start). Composes the probe, CLI, settings, and form
 * hooks above and flattens them into one stable shape for the view.
 */
export function useDshHost(): DshHostSectionState {
  const { t } = useTranslation();
  const probe = useDshHostProbe();
  const { settings, saveError, save } = useDshSettings();
  // Install CTA for the "CLI missing" host state; the version display lives
  // in the CLI 管理 page header, both backed by the same session store. The
  // CTA opens the confirm-plan dialog and streams the install log there.
  const { updating } = useCliVersionStatus("dsh");
  const [cliError, setCliError] = useState<string | null>(null);
  const updateFlow = useCliUpdateFlow("dsh", {
    onSuccess: () => {
      setCliError(null);
      void probe.refreshStatus();
    },
    onError: setCliError,
  });
  const updateCli = updateFlow.begin;
  const view = deriveDshView(probe.status, settings, probe.probeError, {
    checking: probe.checking,
    starting: probe.starting,
    stopping: probe.stopping,
    updating,
  });
  const form = useDshConnectionForm({
    t,
    host: view.host,
    port: view.port,
    save,
    refreshStatus: probe.refreshStatus,
  });

  return { t, ...probe, cliError, updating, updateCli, updateFlow, saveError, save, ...view, ...form };
}
