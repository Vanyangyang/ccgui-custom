/** Comparison only: retain the original path for display, launch and ownership.
 * Windows drive paths tolerate separator, drive-letter and trailing-slash aliases.
 * Do not fold directory casing or resolve dot segments/symlinks lexically.
 */
export function workspaceCatalogPathKey(path: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(path)) return path;
  const slash = path.replace(/[\\/]+/g, "/");
  const normalized = slash[0].toUpperCase() + slash.slice(1);
  return normalized.length > 3 ? normalized.replace(/\/+$/, "") : normalized;
}
