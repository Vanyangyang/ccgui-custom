import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Key } from "react";

import { Select, SelectItem } from "@/components/base/select/select";
import { Button } from "@/components/base/buttons/button";
import { Switch } from "@/components/base/switch/switch";
import {
  SettingsCard,
  SettingsRow,
} from "@/components/application/settings/settings-rows";
import { ConfirmDialog } from "@/components/dialogs";
import { ipc, type AppSettings, type PetSummary } from "@/lib/ipc";
import { pickDirectory } from "@/lib/platform";
import { petErrorMessage } from "@/features/pet/pet-errors";
import { PET_SCALE_OPTIONS, normalizePetScale } from "@/features/pet/pet-scale";

/** Compact select trigger (h 32, radius/lg) per the Figma settings rows. */
const SELECT_TRIGGER = "h-8 w-auto gap-1 rounded-lg px-2 py-1.5";

/** App-settings + pet-package state for the 桌面宠物 page. Kept JSX-free so
 *  the component below only composes the card. */
function usePetState() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pets, setPets] = useState<PetSummary[]>([]);
  const [petBusy, setPetBusy] = useState(false);
  // Pet pending destructive confirmation; null = no dialog open.
  const [removingPet, setRemovingPet] = useState<PetSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipc
      .getAppSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    void ipc
      .listPets()
      .then((list) => {
        if (!cancelled) setPets(list);
      })
      .catch((e) => console.warn("[settings] pet list failed", e));
    return () => {
      cancelled = true;
    };
  }, []);

  // Read-modify-write: the local `settings` descends from a mount-time
  // snapshot; persisting it whole would clobber concurrent edits (CLI config
  // page, chat-side model pinning). Apply each patch onto a fresh read.
  const save = useCallback(async (patch: Partial<AppSettings>): Promise<boolean> => {
    try {
      const latest = await ipc.getAppSettings();
      const next = { ...latest, ...patch };
      await ipc.updateAppSettings(next);
      setSettings(next);
      setError(null);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }, []);

  const onPetEnabledChange = (enabled: boolean) => {
    if (!settings) return;
    if (enabled && !pets.some((pet) => pet.id === settings.petId)) {
      setError(t("settings.petImportRequired"));
      return;
    }
    setSettings({ ...settings, petEnabled: enabled });
    void save({ petEnabled: enabled }).then((ok) => {
      if (ok) void ipc.setPetVisible(enabled).catch((e) => setError(petErrorMessage(e, t)));
    });
  };
  const onPetScaleChange = async (key: Key | null) => {
    if (!settings || key == null) return;
    const next = normalizePetScale(Number(key));
    const previous = normalizePetScale(settings.petScale);
    if (next === previous) return;
    setSettings({ ...settings, petScale: next });
    try {
      const applied = await ipc.setPetScale(next);
      setSettings((current) => (current ? { ...current, petScale: normalizePetScale(applied) } : current));
      setError(null);
    } catch (e) {
      setSettings((current) => (current ? { ...current, petScale: previous } : current));
      setError(petErrorMessage(e, t));
    }
  };
  const onPetChange = async (key: Key | null) => {
    if (!settings || key == null) return;
    const petId = String(key);
    setSettings({ ...settings, petId });
    const saved = await save({ petId });
    if (!saved) return;
    // Recreate the overlay so the selected package is loaded immediately.
    try {
      await ipc.setPetVisible(false);
      await ipc.setPetVisible(settings.petEnabled ?? false);
    } catch (e) {
      setError(petErrorMessage(e, t));
    }
  };
  const importPet = async () => {
    const path = await pickDirectory(t("settings.petImportHint"));
    if (!path) return;
    setPetBusy(true);
    try {
      const imported = await ipc.importPet(path);
      setPets((current) => [...current.filter((pet) => pet.id !== imported.id), imported]);
      setSettings((current) => (current ? { ...current, petId: imported.id } : current));
      const saved = await save({ petId: imported.id });
      if (saved && settings?.petEnabled) {
        await ipc.setPetVisible(false);
        await ipc.setPetVisible(true);
      }
    } catch (e) {
      setError(`${t("settings.petImportFailed")}: ${petErrorMessage(e, t)}`);
    } finally {
      setPetBusy(false);
    }
  };
  const removePet = async (pet: PetSummary) => {
    try {
      await ipc.removePet(pet.id);
      setPets((current) => current.filter((item) => item.id !== pet.id));
      if (settings?.petId === pet.id) {
        if (settings.petEnabled) await ipc.setPetVisible(false).catch(() => {});
        await save({ petId: "", petEnabled: false });
      }
    } catch (e) {
      setError(petErrorMessage(e, t));
    }
  };
  const selectedPetId = settings?.petId?.trim() ?? "";
  const selectedPet = pets.find((pet) => pet.id === selectedPetId);

  return {
    settings,
    error,
    pets,
    petBusy,
    removingPet,
    setRemovingPet,
    removePet,
    selectedPetId,
    selectedPet,
    onPetEnabledChange,
    onPetScaleChange,
    onPetChange,
    importPet,
  };
}

/** Pet card: overlay toggle, package select/import/remove, and scale. */
function PetCard({
  settings,
  pets,
  petBusy,
  selectedPetId,
  selectedPet,
  onPetEnabledChange,
  onPetScaleChange,
  onPetChange,
  onImportPet,
  onRemovePet,
}: {
  settings: AppSettings;
  pets: PetSummary[];
  petBusy: boolean;
  selectedPetId: string;
  selectedPet: PetSummary | undefined;
  onPetEnabledChange: (enabled: boolean) => void;
  onPetScaleChange: (key: Key | null) => void;
  onPetChange: (key: Key | null) => void;
  onImportPet: () => Promise<void>;
  onRemovePet: (pet: PetSummary) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsCard>
        <SettingsRow
          anchor="petEnabled"
          label={t("settings.petEnabled")}
          description={t("settings.petEnabledDesc")}
        >
          <Switch
            size="sm"
            aria-label={t("settings.petEnabled")}
            isSelected={settings.petEnabled ?? false}
            isDisabled={!selectedPet || petBusy}
            onChange={onPetEnabledChange}
          />
        </SettingsRow>
        {!selectedPet && (
          <p className="px-3 pb-2 text-body-2-regular text-text-tertiary">
            {t("settings.petImportRequired")}
          </p>
        )}
        <SettingsRow anchor="petCharacter" label={t("settings.petCharacter")}>
          <div className="flex items-center gap-2">
            <Select
              aria-label={t("settings.petCharacter")}
              selectedKey={selectedPetId || null}
              isDisabled={pets.length === 0 || petBusy}
              onSelectionChange={onPetChange}
              triggerClassName={SELECT_TRIGGER}
            >
              {pets.map((pet) => (
                <SelectItem key={pet.id} id={pet.id} textValue={pet.displayName}>
                  {pet.displayName}
                </SelectItem>
              ))}
            </Select>
            <Button size="small" variant="secondary" onClick={() => void onImportPet()} disabled={petBusy}>
              {t("settings.petImport")}
            </Button>
            {selectedPet && (
              <Button
                size="small"
                variant="ghost"
                onClick={() => void onRemovePet(selectedPet)}
              >
                {t("settings.petRemove")}
              </Button>
            )}
          </div>
        </SettingsRow>
        <SettingsRow
          anchor="petScale"
          label={t("settings.petScale")}
        >
          <Select
            aria-label={t("settings.petScale")}
            selectedKey={String(normalizePetScale(settings.petScale))}
            onSelectionChange={onPetScaleChange}
            triggerClassName={SELECT_TRIGGER}
          >
            {PET_SCALE_OPTIONS.map((value) => (
              <SelectItem key={value} id={String(value)} textValue={`${value * 100}%`}>
                {t("settings.petScaleValue", { percent: value * 100 })}
              </SelectItem>
            ))}
          </Select>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}

/** 桌面宠物 page: overlay toggle, character import/select/remove and size.
 *  The page title already names the page, so the card carries no heading. */
export function PetSection() {
  const { t } = useTranslation();
  const {
    settings,
    error,
    pets,
    petBusy,
    removingPet,
    setRemovingPet,
    removePet,
    selectedPetId,
    selectedPet,
    onPetEnabledChange,
    onPetScaleChange,
    onPetChange,
    importPet,
  } = usePetState();

  return (
    <div className="flex w-full flex-col gap-6">
      {error && (
        <p role="alert" className="text-body-regular text-text-error-primary">
          {t("common.error")}: {error}
        </p>
      )}
      {!settings && !error && (
        <p className="text-body-regular text-text-tertiary">{t("common.loading")}</p>
      )}
      {settings && (
        <PetCard
          settings={settings}
          pets={pets}
          petBusy={petBusy}
          selectedPetId={selectedPetId}
          selectedPet={selectedPet}
          onPetEnabledChange={onPetEnabledChange}
          onPetScaleChange={onPetScaleChange}
          onPetChange={onPetChange}
          onImportPet={importPet}
          onRemovePet={removePet}
        />
      )}
      {removingPet && (
        <ConfirmDialog
          danger
          message={t("settings.petRemoveConfirm", { name: removingPet.displayName })}
          onCancel={() => setRemovingPet(null)}
          onConfirm={() => {
            const pet = removingPet;
            setRemovingPet(null);
            void removePet(pet);
          }}
        />
      )}
    </div>
  );
}
