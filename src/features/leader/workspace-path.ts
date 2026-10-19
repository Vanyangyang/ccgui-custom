/** Only Windows absolute paths treat backslashes as directory separators. */
export function isWindowsWorkspacePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

export function leaderWorkspacePathKey(path: string): string {
  if (!isWindowsWorkspacePath(path)) return path;
  // Collapse equivalent separators only for drive-absolute Windows paths.
  // Preserve case, trailing-separator presence, dot segments and links;
  // POSIX, remote and UNC paths pass through unchanged above.
  return path.replace(/[\\/]+/g, "/");
}

export function sameLeaderWorkspace(a: string, b: string): boolean {
  return leaderWorkspacePathKey(a) === leaderWorkspacePathKey(b);
}
