import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildCreatorSkillFiles,
  CREATOR_SKILL_DIR,
  repoRootFromHere,
} from "../src/features/plugins/skill/creator-skill-docs.ts";

/**
 * 重新生成内置插件开发 skill 的派生文档（SDK 参考 + 开发指南副本）。
 *
 * 用法：pnpm plugin-skill:docs
 *
 * 手写文件（SKILL.md）不在这里维护；改了 packages/plugin-sdk 或扩展点门禁后
 * 必须跑一次，否则 creator-skill-docs.test.ts 会失败。
 */
const repoRoot = repoRootFromHere();
const files = buildCreatorSkillFiles(repoRoot);
for (const file of files) {
  const target = path.join(repoRoot, CREATOR_SKILL_DIR, file.path);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, file.content);
  console.log(`wrote ${path.relative(repoRoot, target)} (${file.content.length} bytes)`);
}
