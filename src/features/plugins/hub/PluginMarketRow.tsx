import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import { Button } from "@/components/base/buttons/button";
import type { MarketPlugin } from "@/lib/ipc";
import { githubAvatarUrl, githubLoginFor, isOfficialPlugin } from "./catalog";
import { PluginAvatar } from "./PluginAvatar";
import { usePluginsStore } from "../manager/usePlugins";
import { useMarketplaceStore } from "../marketplace/store";

const BADGE =
  "rounded-md bg-background-secondary-default px-1.5 py-0.5 text-xs text-text-secondary";
/** First-party marker: purple is reserved for "this is ours", so it never
 *  competes with the neutral tier badge or the lime installed badge. An
 *  official plugin shows only this badge in the developer column — the
 *  account behind it is implicit, and the truncated login was just noise. */
const OFFICIAL_BADGE =
  "shrink-0 rounded-md bg-status-purple-background px-1.5 py-0.5 text-xs text-status-purple-text";

/** Progress placeholder keeps the secondary shape of the button it replaces,
 *  so the row's action column does not resize mid-install. */
const INSTALLING_BUTTON =
  "flex h-8 items-center gap-1.5 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 text-body-2-medium whitespace-nowrap text-text-tertiary";

const CELL = "px-4 py-2.5";
const NUM_CELL = `${CELL} text-right text-body-2-regular text-text-secondary tabular-nums`;

/**
 * The row's action cell — one button per state: installing shows the byte
 * progress, an indexed update wins over the plain installed state, an
 * installed plugin opens its details (settings / uninstall live there), and
 * anything else installs.
 */
function MarketRowAction({
  entry,
  onOpenDetail,
}: {
  entry: MarketPlugin;
  onOpenDetail: (id: string) => void;
}) {
  const { t } = useTranslation();
  const installed = usePluginsStore((s) => s.installed.some((p) => p.id === entry.id));
  const update = useMarketplaceStore((s) => s.updates.find((u) => u.id === entry.id));
  const installing = useMarketplaceStore((s) =>
    s.installing?.id === entry.id ? s.installing : null,
  );
  const install = useMarketplaceStore((s) => s.install);

  if (installing) {
    const pct = installing.total > 0 ? Math.round((installing.done / installing.total) * 100) : null;
    return (
      <button type="button" disabled className={INSTALLING_BUTTON}>
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {pct != null ? t("plugins.installingPct", { pct }) : t("plugins.installing")}
      </button>
    );
  }

  if (installed && update) {
    return (
      <Button
        variant="primary"
        size="small"
        onClick={() => void install(entry.id)}
      >
        {t("plugins.hub.updateTo", { version: update.latestVersion })}
      </Button>
    );
  }

  // Installed and current (builtins included — they never update): the detail
  // page is where settings and uninstall live, so the button opens it.
  if (installed) {
    return (
      <Button
        variant="ghost"
        size="small"
        leadingIcon={Check}
        title={t("plugins.hub.installedHint")}
        onClick={() => onOpenDetail(entry.id)}
      >
        {t("plugins.hub.installed")}
      </Button>
    );
  }

  return (
    <Button
      variant="primary"
      size="small"
      title={t("plugins.hub.install")}
      onClick={() => void install(entry.id)}
    >
      {t("plugins.hub.install")}
    </Button>
  );
}

/**
 * One row of the market table. Identity is a button (opens details) and the
 * row click is pointer sugar over the same action — buttons inside the row
 * keep their own click, so the two never fight.
 */
export function PluginMarketRow({
  entry,
  onOpenDetail,
  showDownloads,
}: {
  entry: MarketPlugin;
  onOpenDetail: (id: string) => void;
  showDownloads: boolean;
}) {
  const { t } = useTranslation();
  const authorLogin = githubLoginFor(entry);
  const official = isOfficialPlugin(entry);

  return (
    <tr
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button")) return;
        onOpenDetail(entry.id);
      }}
      className="cursor-pointer transition-colors hover:bg-background-primary-hover [&>td]:border-b [&>td]:border-separator-border last:[&>td]:border-b-0"
    >
      <td className={CELL}>
        <div className="flex min-w-0 items-center gap-3">
          <PluginAvatar id={entry.id} name={entry.name} src={entry.icon ?? null} size={36} />
          <button
            type="button"
            onClick={() => onOpenDetail(entry.id)}
            className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 text-left"
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              <span className="truncate text-body-medium text-text-primary">{entry.name}</span>
              {entry.tier === "declarative" && (
                <span className={BADGE}>{t("plugins.hub.tierDeclarative")}</span>
              )}
            </span>
            {entry.description && (
              <span
                title={entry.description}
                className="w-full truncate text-body-2-regular text-text-secondary"
              >
                {entry.description}
              </span>
            )}
          </button>
        </div>
      </td>

      <td className={CELL}>
        {official ? (
          <span className={OFFICIAL_BADGE}>{t("plugins.hub.official")}</span>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            {entry.author && (
              <PluginAvatar
                id={entry.author}
                name={entry.author}
                src={authorLogin ? githubAvatarUrl(authorLogin, 20) : null}
                size={20}
                shape="circle"
              />
            )}
            <span title={entry.author} className="truncate text-body-2-regular text-text-secondary">
              {entry.author || "—"}
            </span>
          </div>
        )}
      </td>

      {showDownloads && (
        <td className={NUM_CELL}>
          {entry.downloads != null ? entry.downloads.toLocaleString() : "—"}
        </td>
      )}

      <td className={NUM_CELL}>v{entry.version}</td>

      <td className={CELL}>
        <div className="flex justify-end">
          <MarketRowAction entry={entry} onOpenDetail={onOpenDetail} />
        </div>
      </td>
    </tr>
  );
}
