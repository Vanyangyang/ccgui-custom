import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { ConfirmDialog } from "@/components/dialogs";
import { ipc } from "@/lib/ipc";
import { listen } from "@/lib/transport";
import { ROW_ACTION } from "./WorkspaceGroupRow";

/**
 * Host directory grants, shared by desktop and remote clients. Load and
 * revoke failures use the workspace page's existing error surface. */
export function GrantedRootsCard({
  onError,
  onClearError,
}: {
  onError: (e: unknown) => void;
  onClearError: () => void;
}) {
  const { t } = useTranslation();
  const [grantedRoots, setGrantedRoots] = useState<string[] | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const loadFailed = useRef(false);

  const refresh = useCallback(async () => {
    const ticket = ++revision.current;
    try {
      const roots = await ipc.listGrantedRoots();
      if (!mounted.current || ticket !== revision.current) return;
      setGrantedRoots(roots);
      if (loadFailed.current) { loadFailed.current = false; onClearError(); }
    } catch (error) {
      if (!mounted.current || ticket !== revision.current) return;
      loadFailed.current = true;
      onError(error);
    }
  }, [onError, onClearError]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    for (const event of ["granted-roots://changed", "transport://connected"]) {
      void listen(event, () => { if (!disposed) void refresh(); })
        .then((off) => { if (disposed) off(); else unlisteners.push(off); })
        .catch((error) => { if (!disposed) onError(error); });
    }
    void refresh();
    return () => {
      disposed = true;
      mounted.current = false;
      ++revision.current;
      unlisteners.forEach((off) => off());
    };
  }, [refresh, onError]);

  return (
    <>
      {grantedRoots && grantedRoots.length > 0 && (
        <div className="flex w-full flex-col gap-2">
          <SettingsSectionLabel anchor="grantedRoots">
            {t("settings.grantedRoots")}
            <span className="ml-2 text-body-2-regular font-normal text-text-tertiary">
              {t("settings.grantedRootsDesc")}
            </span>
          </SettingsSectionLabel>
          <SettingsCard>
            {grantedRoots.map((dir) => (
              <SettingsRow key={dir} label={dir}>
                <button
                  type="button"
                  aria-label={t("settings.revokeAccess")}
                  title={t("settings.revokeAccess")}
                  onClick={() => setRevoking(dir)}
                  className={`${ROW_ACTION} hover:text-text-error-primary`}
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </SettingsRow>
            ))}
          </SettingsCard>
        </div>
      )}

      {revoking && (
        <ConfirmDialog
          danger
          message={t("settings.revokeAccessConfirm", { dir: revoking })}
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            const dir = revoking;
            setRevoking(null);
            onClearError();
            void ipc
              .revokeGrantedRoot(dir)
              .then(() => { if (mounted.current) void refresh(); })
              .catch((error) => { if (mounted.current) onError(error); });
          }}
        />
      )}
    </>
  );
}
