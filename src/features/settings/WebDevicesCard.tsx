import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import {
  SettingsCard,
  SettingsRow,
} from "@/components/application/settings/settings-rows";
import { ipc, type WebDevice } from "@/lib/ipc";
import { listenWebDevices } from "@/lib/events";
import { listen } from "@/lib/transport";
import { errorText } from "@/lib/errors";

/** "iPhone · Safari": the raw UA is unreadable in a list row. */
function summarizeUa(ua: string): string {
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "";
  return [os, browser].filter(Boolean).join(" · ");
}

/** 设备授权: a paired browser waits here until 授权 lets it in. */
export function WebDevicesCard() {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<WebDevice[]>([]);
  /** Id of the row being renamed, and the value in its field. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const actionPending = useRef(false);

  const refreshDevices = useCallback(async () => {
    const ticket = ++revision.current;
    try {
      const next = await ipc.webDevices();
      if (!mounted.current || ticket !== revision.current) return;
      setDevices(next);
      setError(null);
    } catch (error) {
      if (mounted.current && ticket === revision.current) setError(errorText(error));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const refresh = () => { if (!disposed) void refreshDevices(); };
    for (const subscription of [listenWebDevices(refresh), listen("transport://connected", refresh)]) {
      void subscription.then((off) => { if (disposed) off(); else unlisteners.push(off); })
        .catch((error) => { if (!disposed) setError(errorText(error)); });
    }
    void refreshDevices();
    return () => { disposed = true; mounted.current = false; ++revision.current; unlisteners.forEach((off) => off()); };
  }, [refreshDevices]);

  const runAction = useCallback(async (id: string, action: () => Promise<boolean>, renamed = false) => {
    if (actionPending.current) return;
    actionPending.current = true;
    ++revision.current;
    setBusyId(id); setError(null);
    try {
      if (!await action()) throw new Error(t("settings.webDeviceActionFailed"));
      if (!mounted.current) return;
      if (renamed) setRenaming(null);
      await refreshDevices();
    } catch (error) {
      if (mounted.current) { ++revision.current; setError(errorText(error)); }
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusyId(null);
    }
  }, [refreshDevices, t]);

  const revoke = useCallback(
    (id: string) => {
      void runAction(id, () => ipc.webDeviceRevoke(id));
    },
    [runAction],
  );

  // Approving is what actually lets a paired browser in — the key alone only
  // files the request.
  const approveDevice = useCallback(
    (id: string) => {
      void runAction(id, () => ipc.webDeviceApprove(id));
    },
    [runAction],
  );

  const saveRename = useCallback(
    (id: string) => {
      void runAction(id, () => ipc.webDeviceRename(id, renameValue.trim()), true);
    },
    [renameValue, runAction],
  );

  return (
    <SettingsCard>
      <SettingsRow anchor="webDevices" label={t("settings.webDevices")} />
      {error && <div role="alert" className="flex items-center gap-2 pt-2 text-body-2-regular text-text-error-primary">
        <span>{error}</span><Button size="small" variant="secondary" disabled={busyId !== null} onClick={() => void refreshDevices()}>{t("common.refresh")}</Button>
      </div>}
      {devices.length === 0 ? (
        <p className="pt-3 pr-3 pb-3 text-body-2-regular text-text-secondary">
          {t("settings.webDevicesEmpty")}
        </p>
      ) : (
        <div className="flex w-full flex-col">
          {devices.map((device) => {
            const approved = device.approvedAt !== null;
            return (
              <div
                key={device.id}
                className="flex w-full items-center gap-3 border-t border-separator-border py-2.5 pr-3"
              >
                <Smartphone
                  className="size-4 shrink-0 text-foreground-icon-tertiary"
                  aria-hidden
                />
                {renaming === device.id ? (
                  <Input
                    isDisabled={busyId !== null}
                    autoFocus
                    size="small"
                    aria-label={t("settings.webDeviceRename")}
                    placeholder={summarizeUa(device.userAgent)}
                    value={renameValue}
                    onChange={setRenameValue}
                    className="min-w-0 flex-1"
                    onKeyDown={(event) => {
                      // Enter confirms an IME candidate mid-composition; only a
                      // post-composition Enter may commit the rename.
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "Enter") saveRename(device.id);
                      if (event.key === "Escape") setRenaming(null);
                    }}
                    onBlur={() => {
                      // Enter already saved and cleared `renaming`; a second
                      // call would just repeat the same write.
                      if (renaming === device.id) saveRename(device.id);
                    }}
                  />
                ) : (
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body-regular text-text-primary">
                      {device.name ||
                        summarizeUa(device.userAgent) ||
                        t("settings.webDeviceAnonymous")}
                    </span>
                    <span className="truncate text-body-2-regular text-text-secondary">
                      {/* Matches the code the phone shows while it waits for approval. */}
                      {device.id.slice(0, 8).toUpperCase()} ·{" "}
                      {approved
                        ? t("settings.webDeviceApproved")
                        : t("settings.webDevicePending")}
                    </span>
                  </div>
                )}
                {approved ? (
                  <>
                    <button
                      disabled={busyId !== null}
                      type="button"
                      aria-label={t("settings.webDeviceRename")}
                      title={t("settings.webDeviceRename")}
                      onClick={() => {
                        setRenameValue(device.name ?? "");
                        setRenaming(device.id);
                      }}
                      className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
                    >
                      <Pencil className="size-4" aria-hidden />
                    </button>
                    <Button size="small" variant="secondary" disabled={busyId !== null} onClick={() => revoke(device.id)}>
                      {t("settings.webDeviceRevoke")}
                    </Button>
                  </>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button size="small" variant="secondary" disabled={busyId !== null} onClick={() => revoke(device.id)}>
                      {t("settings.webDeviceCancel")}
                    </Button>
                    <Button size="small" variant="primary" disabled={busyId !== null} onClick={() => approveDevice(device.id)}>
                      {t("settings.webDeviceApprove")}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SettingsCard>
  );
}
