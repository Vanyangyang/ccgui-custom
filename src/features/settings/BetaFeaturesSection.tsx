import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/base/switch/switch";
import {
  SettingsCard,
  SettingsRow,
} from "@/components/application/settings/settings-rows";
import { errorText } from "@/lib/errors";
import {
  BETA_FEATURES,
  hydrateBetaFeatures,
  useBetaFeaturesStore,
  type BetaFeatureId,
} from "./beta-features";

/**
 * 内测功能 page (设置 → 其他): one switch per beta entry, off by default.
 * Flipping a switch persists the flag and reveals/hides that entry right away
 * (sidebar / new-tab menu); turning one off only hides its entry — the
 * feature's own state (open tabs, panels) is kept for the next enable.
 */
export function BetaFeaturesSection() {
  const { t } = useTranslation();
  const features = useBetaFeaturesStore((s) => s.features);
  const setFeature = useBetaFeaturesStore((s) => s.setFeature);
  const [error, setError] = useState<string | null>(null);

  // Authoritative read on mount: startup hydration may have raced the shared
  // settings fetch, and a failed startup fetch leaves the store all-off.
  useEffect(() => {
    void hydrateBetaFeatures();
  }, []);

  const toggle = (id: BetaFeatureId, enabled: boolean) => {
    void setFeature(id, enabled)
      .then(() => setError(null))
      .catch((e) => setError(errorText(e)));
  };

  return (
    <div className="flex w-full flex-col gap-6">
      {error && (
        <p role="alert" className="text-body-regular text-text-error-primary">
          {t("common.error")}: {error}
        </p>
      )}
      <div className="flex w-full flex-col gap-2">
        <p className="px-3 text-body-2-regular text-text-secondary">
          {t("settings.betaFeaturesDesc")}
        </p>
        <SettingsCard className="mt-1">
          {BETA_FEATURES.map((feature) => (
            <SettingsRow
              key={feature.id}
              anchor={feature.id}
              label={t(feature.labelKey)}
              description={t(feature.descriptionKey)}
            >
              <Switch
                size="sm"
                aria-label={t(feature.labelKey)}
                isSelected={features[feature.id] === true}
                onChange={(enabled) => toggle(feature.id, enabled)}
              />
            </SettingsRow>
          ))}
        </SettingsCard>
      </div>
    </div>
  );
}
