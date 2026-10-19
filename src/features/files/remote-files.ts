/**
 * Remote file-source hook (WSL plugin integration, ~40 lines).
 *
 * The wsl plugin registers an async reader + path classifier here at activate
 * time; the files store consults it before touching the local disk. Anything
 * the reader declines (null) — or fails on (throw) — falls through to the
 * normal local read, so a broken plugin can never take down local file
 * opens. Remote content is served read-only (readOnly: true) — remote
 * writes are a later concern.
 *
 * Exposed on window because the plugin is a separately-bundled ESM module —
 * it cannot import host internals. Same-webview global is the contract.
 */

import type { FileContent } from "@/lib/ipc";
export type RemoteFileReader = (
  path: string,
) => Promise<FileContent | null>;

export interface CcguiFilesBridge {
  /** Register (or clear with null) the remote reader. */
  registerRemoteFileReader(reader: RemoteFileReader | null): void;
  /** Open a path in the center editor (the standard file-open flow). */
  openFile(path: string): Promise<void>;
  /** True when the path was served by the remote reader — saves blocked. */
  isRemote(path: string): boolean;
}

declare global {
  interface Window {
    __ccguiFiles?: CcguiFilesBridge;
  }
}

let remoteReader: RemoteFileReader | null = null;
const remotePaths = new Set<string>();

export function installFilesBridge(
  openFile: (path: string) => Promise<void>,
): void {
  window.__ccguiFiles = {
    registerRemoteFileReader(reader) {
      remoteReader = reader;
      // 换 reader(含注销为 null)即重建归属集:旧 reader 服务过的路径对新
      // reader 无意义,留着会让 isRemote 永久误判、保存被无谓拦截。
      remotePaths.clear();
    },
    openFile,
    isRemote(path) {
      return remotePaths.has(path);
    },
  };
}

/** Read via the remote reader when it claims the path; null 或抛错都回退
 *  本地读(插件 reader 故障不得拖垮本地文件管线)。 */
export async function readRemoteAware(
  path: string,
  localRead: (p: string) => Promise<FileContent>,
): Promise<FileContent> {
  if (remoteReader) {
    let content: FileContent | null = null;
    try {
      content = await remoteReader(path);
    } catch {
      // fall through to the local read
    }
    if (content !== null) {
      remotePaths.add(path);
      return { ...content, readOnly: true };
    }
  }
  return localRead(path);
}

