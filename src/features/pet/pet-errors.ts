/** Stable error codes returned by src-tauri/src/pets.rs and pet_overlay.rs
 * for user-actionable failures; everything else passes through unchanged. */
const PET_ERROR_KEYS: Record<string, string> = {
  "pet.err.select_dir_or_manifest": "settings.petErrSelectDirOrManifest",
  "pet.err.manifest_no_parent": "settings.petErrManifestNoParent",
  "pet.err.path_not_found": "settings.petErrPathNotFound",
  "pet.err.duplicate_id": "settings.petErrDuplicateId",
  "pet.err.need_import": "settings.petErrNeedImport",
};

/** Map a backend pet error to localized text when it is a known stable
 * code; technical errors (fs/parse/decode) are shown as-is. */
export function petErrorMessage(error: unknown, t: (key: string) => string): string {
  const raw = String(error);
  const key = PET_ERROR_KEYS[raw.trim()];
  return key ? t(key) : raw;
}
