import { getAppVersion, isWeb } from "@/lib/platform";
import { writeStored } from "@/lib/storage";
import { changelogEntryFor } from "@/version/changelog";
import { useReleaseNotesTabStore } from "./notes-tab";

/**
 * 升级后首启的版本说明宣布：自动升级（或手动装新包）重启进来时，把这次更新的
 * 说明开成中心页签并标记「新版本」——用户第一眼就能看到更新带来了什么，
 * 不用自己去状态栏版本号里找。每个版本只宣布一次。
 */

/** 上一次运行记下的应用版本；它就是「这次是不是刚升级」的凭据。 */
export const LAST_SEEN_VERSION_KEY = "ccgui-next.lastSeenAppVersion:v1";

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** 读不到（首次安装、存储被禁用）时返回 null，调用方按首次安装处理。 */
function readLastSeenVersion(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_VERSION_KEY);
  } catch {
    return null;
  }
}

/**
 * 版本号比较：`a` 比 `b` 新返回正数、旧返回负数、相同返回 0。段位按数字比、
 * 缺位补 0；段位不是纯数字（预发布后缀之类）一律按「认不出」处理成相等——
 * 宁可少宣布一次，也不把降级或认不出的版本号说成「新版本」。
 */
export function compareVersions(a: string, b: string): number {
  const segments = (version: string) =>
    normalizeVersion(version)
      .split("+")[0]
      .split(".")
      .map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  const left = segments(a);
  const right = segments(b);
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return 0;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 升级后首启：版本真的前进了、且本地版本记录里有这个版本的说明，就把说明开成
 * 中心页签并标记未读（页签圆点 + 页头「新版本」，关掉页签即视为已读）。
 *
 * 不做的事：首次安装只记基线（没有可对比的旧版本，谈不上「更新」）；版本没变、
 * 降级、版本号认不出只更新基线；本地没有这个版本的条目就不打开空页签（发布时
 * 补上 CHANGELOG_DATA 条目即生效）；远程 Web 端没有本地壳版本，同更新检查跳过。
 */
export async function announceReleaseAfterUpgrade(): Promise<void> {
  if (isWeb) return;

  const current = normalizeVersion((await getAppVersion()) ?? "");
  if (!current) return;

  const lastSeen = readLastSeenVersion();
  // 基线先写：宣布失败（比如没有说明条目）也不该在下次启动重来一遍。
  writeStored(LAST_SEEN_VERSION_KEY, current);

  if (!lastSeen) return;
  if (compareVersions(current, lastSeen) <= 0) return;
  if (!changelogEntryFor(current)) return;

  useReleaseNotesTabStore.getState().announceNewVersion(current);
}
