/** Only Windows absolute paths treat backslashes as directory separators. */
export function isWindowsWorkspacePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

export function leaderWorkspacePathKey(path: string): string {
  if (!isWindowsWorkspacePath(path)) return path;
  // Fold only the drive letter and equivalent separators for absolute paths.
  // Preserve directory casing, trailing separators, dot segments and links;
  // POSIX, remote and UNC paths pass through unchanged above.
  const slash = path.replace(/[\\/]+/g, "/");
  return slash[0].toUpperCase() + slash.slice(1);
}

export function sameLeaderWorkspace(a: string, b: string): boolean {
  return leaderWorkspacePathKey(a) === leaderWorkspacePathKey(b);
}
