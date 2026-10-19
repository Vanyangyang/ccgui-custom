import type { Disposer, ExternalSessionRow } from "@ccgui/plugin-sdk";
import type { SessionMeta } from "@/lib/ipc";

/**
 * ctx.sessions.registerSource 的宿主实现:插件登记一个异步会话源,宿主把
 * 它的行合并进侧栏会话目录(本机扫描结果优先)。远程/容器内来源(如 WSL
 * 发行版)的会话宿主扫不到,由此缝注入;宿主只认通用字段,不感知来源形状。
 *
 * 独立成模块:chat store 依赖链重,让 store 可以只 import 本模块的纯注册
 * 表(本模块不 import store,无环)。
 */

/** 插件上报行类型以 SDK 契约为准(单一事实源);宿主只消费这些字段。 */
export type { ExternalSessionRow };
type SourceList = () => Promise<ExternalSessionRow[]>;

/** 单源单次返回的行数上限;超限截断,防失控插件把侧栏刷爆。 */
const MAX_ROWS_PER_SOURCE = 500;

/** pluginId/sourceId → list。同 id 重复登记覆盖(插件热重载语义)。 */
const sources = new Map<string, SourceList>();

let onSourcesChanged: (() => void) | null = null;

/** store 在 init 时挂:任一插件登记/注销源后触发一次会话刷新。 */
export function setSessionSourcesChangedCallback(cb: (() => void) | null): void {
  onSourcesChanged = cb;
}

export function registerSessionSource(
  pluginId: string,
  sourceId: string,
  list: SourceList,
): Disposer {
  const key = `${pluginId}/${sourceId}`;
  sources.set(key, list);
  try {
    onSourcesChanged?.();
  } catch {
    /* 刷新失败不阻断登记 */
  }
  // 只删自己装的条目:同 id 被后来者覆盖(热重载)后,先登记者的旧
  // disposer 迟于新登记执行时不得把新源一并删掉。
  return () => {
    if (sources.get(key) === list) {
      sources.delete(key);
      try {
        onSourcesChanged?.();
      } catch {
        /* 同上 */
      }
    }
  };
}

/** 外部行补全成 SessionMeta 的缺省字段;remote = 无本地转录本,历史回放
 *  跳过而不是报错(发送走引擎端 resume)。 */
const EMPTY_META = {
  filePath: "",
  fileSize: 0,
  preview: "",
  createdAt: null,
  messageCount: 0,
  pinned: false,
  customTitle: null,
  remote: true,
} as const;

/** 收集所有源的行并补全成 SessionMeta。任一源抛错只丢该源,不上抛。 */
export async function listExternalSessionMetas(): Promise<SessionMeta[]> {
  if (sources.size === 0) return [];
  // Promise.resolve().then 把同步抛错也变成 rejection,allSettled 才能
  // 兑现『任一源抛错只丢该源』——否则一个同步抛错的源会让整轮刷新失败。
  const settled = await Promise.allSettled(
    [...sources.values()].map((list) => Promise.resolve().then(list)),
  );
  const out: SessionMeta[] = [];
  const seen = new Set<string>();
  for (const r of settled) {
    if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
    const rows =
      r.value.length > MAX_ROWS_PER_SOURCE
        ? (console.error(
            `[plugins] session source returned ${r.value.length} rows; truncated to ${MAX_ROWS_PER_SOURCE}`,
          ),
          r.value.slice(0, MAX_ROWS_PER_SOURCE))
        : r.value;
    for (const row of rows) {
      if (!row?.engine || !row?.sessionId || !row?.workspacePath) continue;
      const key = `${row.engine}/${row.sessionId}/${row.workspacePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 插件输入的字段类型防御:不合规字段回落缺省,不透传进 SessionMeta。
      const updatedAt = typeof row.updatedAt === "number" ? row.updatedAt : null;
      const title = typeof row.title === "string" && row.title ? row.title : row.sessionId.slice(0, 8);
      const remotePath =
        typeof row.remotePath === "string" && row.remotePath ? row.remotePath : undefined;
      out.push({
        engine: row.engine,
        sessionId: row.sessionId,
        workspacePath: row.workspacePath,
        ...EMPTY_META,
        fileMtimeMs: updatedAt ?? 0,
        title,
        updatedAt,
        remotePath,
      });
    }
  }
  return out;
}
