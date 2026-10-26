import { isWithinDirectory } from "./repositorySelection";

export interface FileProjectRoot {
  path: string;
  label: string;
  role: "development" | "reference";
  status: "available" | "missing" | "changed";
}

/** Keep ancestor coverage once, regardless of member order. */
export function distinctProjectRoots<T extends { path: string }>(roots: readonly T[]): T[] {
  return roots.filter((root, index) => root.path.trim().length > 0 && !roots.some((other, otherIndex) =>
    otherIndex !== index && isWithinDirectory(other.path, root.path) &&
    (!isWithinDirectory(root.path, other.path) || otherIndex < index),
  ));
}
