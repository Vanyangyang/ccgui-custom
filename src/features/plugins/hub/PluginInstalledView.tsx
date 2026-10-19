import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import FolderInput from "lucide-react/dist/esm/icons/folder-input";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import { Input } from "@/components/base/input/input";
import { CenteredSpinner } from "@/components/base/empty-state";
import { PluginInstalledRow } from "./PluginInstalledRow";
import { usePluginsStore } from "../manager/usePlugins";
import { useMarketplaceStore } from "../marketplace/store";
import { isWeb } from "@/lib/platform";

/** 已安装 tab: the manager half of the hub — search + per-plugin controls. */
export function PluginInstalledView({ onOpenDetail }: { onOpenDetail: (id: string) => void }) {
  const { t } = useTranslation();
  const { installed, loaded, error, installing, refresh, installFromDirectory } =
    usePluginsStore();
  const fetchIndex = useMarketplaceStore((s) => s.fetchIndex);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 图标与效果图只存在市场索引里（安装记录不带 repo 与素材路径），所以
  // 直接打开「已安装」也要拉一次索引，否则本地装的插件永远只有首字母瓷砖、
  // 详情页也拿不到图集。非强制：backend 侧有 1h 缓存，市场页的刷新按钮
  // 负责强制更新。
  useEffect(() => {
    void fetchIndex();
  }, [fetchIndex]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return installed;
    return installed.filter((plugin) =>
      [plugin.id, plugin.name, plugin.description, plugin.author]
        .join("\n")
        .toLowerCase()
        .includes(needle),
    );
  }, [installed, query]);

  return (
    <div className="flex w-full flex-col gap-4">
      {error && (
        <div className="rounded-xl bg-background-secondary-default px-4 py-2 text-body-medium text-text-error-primary">
          {error}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="px-1 text-body-medium text-text-primary">
          {t("plugins.hub.sectionInstalled")}
        </h3>
        <Input
          value={query}
          onChange={setQuery}
          placeholder={t("plugins.hub.searchPlaceholder")}
          className="w-60 max-w-full"
        />
      </div>
      <div className="flex flex-col divide-y divide-separator-border rounded-2xl border border-separator-border bg-background-primary-default">
        {!loaded ? (
          <CenteredSpinner className="py-16" />
        ) : filtered.length > 0 ? (
          filtered.map((plugin) => (
            <PluginInstalledRow key={plugin.id} plugin={plugin} onOpenDetail={onOpenDetail} />
          ))
        ) : installed.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-12">
            <p className="text-body-regular text-text-tertiary">
              {t("plugins.hub.emptyInstalled")}
            </p>
            <button
              type="button"
              disabled={!!installing}
              onClick={() => void installFromDirectory()}
              className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-background-secondary-default px-3 py-1.5 text-body-medium text-text-primary transition-colors hover:bg-background-secondary-hover disabled:cursor-wait disabled:opacity-70"
            >
              {installing ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <FolderInput className="size-4" aria-hidden />
              )}
              {t(isWeb ? "plugins.hub.installHost" : "plugins.hub.installLocal")}
            </button>
          </div>
        ) : (
          <p className="px-4 py-10 text-center text-body-regular text-text-tertiary">
            {t("plugins.hub.noMatch")}
          </p>
        )}
      </div>
    </div>
  );
}
