import { ipc, type AppSettings } from "@/lib/ipc";

let settingsWrites = Promise.resolve();

/** Read inside the shared queue so independent preference patches cannot
 * overwrite each other's persisted settings. Reject to callers that surface errors. */
export function writeSettingsPatch(
  patch: (settings: AppSettings) => Partial<AppSettings>,
): Promise<void> {
  const result = settingsWrites.then(async () => {
    const settings = await ipc.getAppSettings();
    await ipc.updateAppSettings({ ...settings, ...patch(settings) });
  });
  settingsWrites = result.catch(() => {});
  return result;
}

/** Persist one app-settings patch; callers have already applied the in-memory
 * value, so a persist failure is non-fatal. */
export async function persistSettings(
  patch: (settings: AppSettings) => Partial<AppSettings>,
) {
  try {
    await writeSettingsPatch(patch);
  } catch {
    // Persist failure is non-fatal: the in-memory value still applies.
  }
}
