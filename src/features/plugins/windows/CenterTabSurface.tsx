import { useSyncExternalStore, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import PanelTop from "lucide-react/dist/esm/icons/panel-top";
import { Button } from "@/components/base/buttons/button";
import type { DetachedSurfaceOwner } from "./owner";

/** A registered center tab keeps its controller while its view is elsewhere. */
export function DetachedCenterTabSurface({ owner, component: Component }: {
  owner: DetachedSurfaceOwner; component: ComponentType;
}) {
  const { t } = useTranslation();
  const status = useSyncExternalStore(owner.subscribeStatus, owner.getStatus, owner.getStatus);
  const away = Boolean(status.windowId);
  const busy = status.phase === "opening" || status.phase === "returning";
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-plugin-detached-state={status.phase}>
    <div className="flex min-h-10 shrink-0 items-center justify-end gap-2 border-b border-border-primary px-3 py-1">
      {status.error && <p role="status" className="mr-auto text-xs text-text-tertiary">{t(status.returnBlocked ? "plugins.detached.returnBlocked" : "plugins.detached.actionFailed")}</p>}
      {away && status.returnBlocked && <Button size="small" variant="secondary" disabled={busy}
        onClick={() => void owner.returnToMain("return", { force: true }).catch(() => {})}>{t("plugins.detached.discardAndReturn")}</Button>}
      {away && <Button size="small" variant="secondary" leadingIcon={PanelTop} disabled={busy}
        onClick={() => void owner.returnToMain().catch(() => {})}>{t("plugins.detached.returnToMain")}</Button>}
      <Button size="small" variant="secondary" leadingIcon={ExternalLink} disabled={busy}
        onClick={() => void owner.open().catch(() => {})}>{t(away ? "plugins.detached.focusWindow" : "plugins.detached.popOut")}</Button>
    </div>
    {away
      ? <div className="flex flex-1 items-center justify-center p-6 text-sm text-text-tertiary">{t("plugins.detached.openElsewhere")}</div>
      : <Component />}
  </div>;
}
