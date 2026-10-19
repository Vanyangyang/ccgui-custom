/** API Key group — search / featured-vs-all / three-state rows / inline key
 *  editor / delete with confirmation (extracted from PiFamilyAuthSection).
 *  Keys never round-trip to the frontend — rows carry only a masked display
 *  string. All state stays with the parent; this file is presentational. */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import Eye from "lucide-react/dist/esm/icons/eye";
import EyeOff from "lucide-react/dist/esm/icons/eye-off";
import Search from "lucide-react/dist/esm/icons/search";
import {
  SettingsCard,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import {
  type PiFamilyAuthProviderSnapshot,
  type PiFamilyAuthState,
} from "@/lib/ipc";
import { cx } from "@/utils/cx";
import type { PiFamilyAuthUiProvider } from "./piFamilyAuthCatalog";
import { BrandIcon, ROW, StatusDot, TEXT_BTN } from "./PiFamilyAuthShared";

function KeyStateBadge({ state }: { state: PiFamilyAuthState }) {
  const { t } = useTranslation();
  if (state === "configured") {
    return (
      <span className="flex items-center gap-1.5 text-body-2-regular text-text-secondary">
        <StatusDot on />
        {t("settings.piAuthConfigured")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-body-2-regular text-text-tertiary">
      <StatusDot on={false} />
      {t("settings.piAuthNotConfigured")}
    </span>
  );
}

interface ApiKeyEditorProps {
  provider: PiFamilyAuthUiProvider;
  snap: PiFamilyAuthProviderSnapshot | undefined;
  storePath: string;
  draftKey: string;
  onDraftKeyChange: (value: string) => void;
  draftVisible: boolean;
  onToggleDraftVisible: () => void;
  saving: boolean;
  error: string | null;
  onSave: (provider: PiFamilyAuthUiProvider) => void;
  onClose: () => void;
}

/** Inline key editor under an expanded row. Focus moves into the key field
 *  when the editor opens (an explicit user action) via a mount-time ref —
 *  the no-autofocus-safe way to place initial focus. */
function ApiKeyEditor({
  provider,
  snap,
  storePath,
  draftKey,
  onDraftKeyChange,
  draftVisible,
  onToggleDraftVisible,
  saving,
  error,
  onSave,
  onClose,
}: ApiKeyEditorProps) {
  const { t } = useTranslation();
  // Stable identity: focus runs once on mount, not on every re-render.
  const focusInput = useCallback((el: HTMLInputElement | null) => {
    el?.focus();
  }, []);
  return (
    <div className="border-b border-separator-border px-2 py-3 last:border-b-0">
      <label
        className="mb-1.5 block text-body-2-medium text-text-secondary"
        htmlFor={`pi-family-auth-key-${provider.id}`}
      >
        API Key · {provider.name}
      </label>
      <div className="flex items-center gap-1 rounded-lg bg-background-tertiary px-2.5">
        <input
          ref={focusInput}
          id={`pi-family-auth-key-${provider.id}`}
          type={draftVisible ? "text" : "password"}
          value={draftKey}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onDraftKeyChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onSave(provider);
            } else if (event.key === "Escape") {
              onClose();
            }
          }}
          placeholder={
            snap?.state === "configured"
              ? t("settings.piAuthKeyPlaceholderKeep", { mask: snap.maskedKey ?? "" })
              : t("settings.piAuthKeyPlaceholderNew", { env: snap?.envVar ?? "API Key" })
          }
          className="h-9 min-w-0 flex-1 bg-transparent text-body-regular text-text-primary outline-none placeholder:text-text-tertiary"
        />
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-icon-secondary hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
          onClick={onToggleDraftVisible}
          title={t("settings.piAuthEdit")}
        >
          {draftVisible ? (
            <EyeOff className="size-3.5" aria-hidden />
          ) : (
            <Eye className="size-3.5" aria-hidden />
          )}
        </button>
      </div>
      <p className="mt-1.5 text-body-2-regular text-text-tertiary">
        {t("settings.piAuthAdvancedTip")}
      </p>
      {error ? (
        <p className="mt-1.5 text-body-2-regular text-text-error-primary" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave(provider)}
          className="rounded-lg bg-accent-500 px-3 py-1 text-body-2-medium text-white disabled:opacity-50"
        >
          {saving ? t("settings.piAuthSaving") : t("settings.piAuthSave")}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border-button-default px-3 py-1 text-body-2-medium text-text-primary"
        >
          {t("common.cancel")}
        </button>
        <span className="min-w-0 truncate text-body-2-regular text-text-tertiary">
          {t("settings.piAuthSaveHint", { path: storePath })}
        </span>
      </div>
    </div>
  );
}

interface PiFamilyApiKeySectionProps {
  loadError: string | null;
  storePath: string;
  query: string;
  onQueryChange: (value: string) => void;
  showAll: boolean;
  onToggleShowAll: () => void;
  totalCount: number;
  providers: PiFamilyAuthUiProvider[];
  byId: ReadonlyMap<string, PiFamilyAuthProviderSnapshot>;
  editingId: string | null;
  onOpenEditor: (id: string) => void;
  onDelete: (provider: PiFamilyAuthUiProvider) => void;
  draftKey: string;
  onDraftKeyChange: (value: string) => void;
  draftVisible: boolean;
  onToggleDraftVisible: () => void;
  saving: boolean;
  actionError: string | null;
  onSave: (provider: PiFamilyAuthUiProvider) => void;
  onCloseEditor: () => void;
}

export function PiFamilyApiKeySection({
  loadError,
  storePath,
  query,
  onQueryChange,
  showAll,
  onToggleShowAll,
  totalCount,
  providers,
  byId,
  editingId,
  onOpenEditor,
  onDelete,
  draftKey,
  onDraftKeyChange,
  draftVisible,
  onToggleDraftVisible,
  saving,
  actionError,
  onSave,
  onCloseEditor,
}: PiFamilyApiKeySectionProps) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <SettingsSectionLabel anchor="piAuthApiKey">
          {t("settings.piAuthApiKeyTitle")}
          <span className="ml-2 text-body-2-regular font-normal text-text-tertiary">
            {t("settings.piAuthApiKeyHint", { path: storePath })}
          </span>
        </SettingsSectionLabel>
        <div className="flex shrink-0 items-center gap-1.5 rounded-lg bg-background-tertiary px-2.5">
          <Search className="size-3.5 text-foreground-icon-secondary" aria-hidden />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("settings.piAuthSearchPlaceholder")}
            className="h-8 w-44 bg-transparent text-body-2-regular text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
      </div>
      <SettingsCard>
        {loadError ? (
          <div className={cx(ROW, "text-body-regular text-text-error-primary")} role="alert">
            {t("settings.piAuthLoadFailed")}: {loadError}
          </div>
        ) : null}
        {providers.map((provider) => {
          const snap = byId.get(provider.id);
          const state = snap?.state ?? "none";
          const expanded = editingId === provider.id;
          return (
            <div key={provider.id}>
              <div className={cx(ROW, expanded && "border-b-0")}>
                <BrandIcon iconSrc={provider.iconSrc} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <p className="truncate text-body-regular text-text-primary">{provider.name}</p>
                  <code className="w-fit truncate rounded border border-dashed border-border-button-default px-1 py-px text-[11px] text-text-tertiary">
                    {snap?.envVar ?? "—"}
                  </code>
                </div>
                <KeyStateBadge state={state} />
                {state === "configured" && snap?.maskedKey ? (
                  <code className="shrink-0 rounded bg-background-tertiary px-1.5 py-0.5 text-[11px] text-text-secondary">
                    {snap.maskedKey}
                  </code>
                ) : null}
                {state === "configured" ? (
                  <>
                    <button
                      type="button"
                      className={TEXT_BTN}
                      onClick={() => onOpenEditor(provider.id)}
                    >
                      {expanded ? t("settings.piAuthCollapse") : t("settings.piAuthEdit")}
                    </button>
                    <button
                      type="button"
                      className={cx(TEXT_BTN, "hover:text-text-error-primary")}
                      onClick={() => onDelete(provider)}
                    >
                      {t("settings.piAuthDelete")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="shrink-0 rounded-lg border border-border-button-default px-2.5 py-1 text-body-2-medium text-text-primary hover:bg-background-secondary-hover"
                    onClick={() => onOpenEditor(provider.id)}
                  >
                    {expanded ? t("settings.piAuthCollapse") : t("settings.piAuthSetKey")}
                  </button>
                )}
              </div>
              {expanded ? (
                <ApiKeyEditor
                  provider={provider}
                  snap={snap}
                  storePath={storePath}
                  draftKey={draftKey}
                  onDraftKeyChange={onDraftKeyChange}
                  draftVisible={draftVisible}
                  onToggleDraftVisible={onToggleDraftVisible}
                  saving={saving}
                  error={editingId === provider.id ? actionError : null}
                  onSave={onSave}
                  onClose={onCloseEditor}
                />
              ) : null}
            </div>
          );
        })}
        {!loadError && providers.length === 0 ? (
          <div className={cx(ROW, "text-body-regular text-text-tertiary")}>
            {t("settings.piAuthEmptySearch", { query })}
          </div>
        ) : null}
        {!query.trim() ? (
          <button
            type="button"
            className={cx(ROW, "justify-center text-body-2-medium text-text-secondary hover:text-text-primary")}
            onClick={onToggleShowAll}
          >
            {showAll
              ? t("settings.piAuthShowLess")
              : t("settings.piAuthShowAll", { count: totalCount })}
          </button>
        ) : null}
        <div className="flex items-center gap-2 py-2 pr-2.5 text-[11px] text-text-tertiary">
          <code className="min-w-0 truncate">{storePath}</code>
          <span className="shrink-0 rounded bg-background-tertiary px-1 py-px">0600</span>
          <span className="shrink-0">·</span>
          <span className="min-w-0 truncate">{t("settings.piAuthResolutionOrder")}</span>
        </div>
      </SettingsCard>
    </div>
  );
}
