import { describe, expect, it } from "vitest";
import {
  formatNativeTaskDisplayLabel,
  isNativeCommandKind,
  summarizeCliCommandZh,
  summarizeEnglishCommandPhraseZh,
} from "./native-command-label";

describe("native-command-label", () => {
  it("detects native command kinds case-insensitively", () => {
    expect(isNativeCommandKind("command")).toBe(true);
    expect(isNativeCommandKind("bash")).toBe(true);
    expect(isNativeCommandKind("local_bash")).toBe(true);
    expect(isNativeCommandKind("background_command")).toBe(true);
    expect(isNativeCommandKind("background-command")).toBe(true);
    expect(isNativeCommandKind("local_agent")).toBe(false);
    expect(isNativeCommandKind("monitor")).toBe(false);
    expect(isNativeCommandKind(undefined)).toBe(false);
  });

  it("preserves existing Chinese summaries verbatim", () => {
    expect(
      formatNativeTaskDisplayLabel(
        {
          label: "运行隔离测试套件与 MCP 冒烟检查",
          nativeKind: "command",
          nativeSummary: "node scripts/test.mjs",
        },
        "zh-CN",
      ),
    ).toBe("运行隔离测试套件与 MCP 冒烟检查");

    expect(
      formatNativeTaskDisplayLabel(
        {
          label: "前端构建（Vite）",
          nativeKind: "local_bash",
        },
        "zh",
      ),
    ).toBe("前端构建（Vite）");
  });

  it("summarizes screenshot English command phrases cleanly in Chinese UI", () => {
    expect(
      formatNativeTaskDisplayLabel(
        {
          label: "Run isolated test suite and MCP smoke check",
          nativeKind: "command",
        },
        "zh",
      ),
    ).toBe("运行隔离测试套件与 MCP 冒烟检查");

    expect(
      formatNativeTaskDisplayLabel(
        {
          label: "Dual-env test suite and MCP smoke",
          nativeKind: "command",
        },
        "zh-CN",
      ),
    ).toBe("双环境测试套件与 MCP 冒烟");
  });

  it("summarizes common English DevOps and background command labels", () => {
    expect(summarizeEnglishCommandPhraseZh("Production build")).toBe("生产构建");
    expect(summarizeEnglishCommandPhraseZh("Dev server startup")).toBe("启动开发服务");
    expect(summarizeEnglishCommandPhraseZh("Git status check")).toBe("检查 Git 状态");
    expect(summarizeEnglishCommandPhraseZh("Unit test execution")).toBe("单元测试");
    expect(summarizeEnglishCommandPhraseZh("Node integration tests")).toBe("Node 集成测试");
    expect(summarizeEnglishCommandPhraseZh("Background daemon")).toBe("后台守护进程");

    expect(
      formatNativeTaskDisplayLabel(
        { label: "Background command", nativeKind: "command" },
        "zh",
      ),
    ).toBe("执行后台命令");

    expect(
      formatNativeTaskDisplayLabel(
        { label: "Background command", nativeKind: "command", nativeSummary: "pnpm build" },
        "zh",
      ),
    ).toBe("执行项目构建");
  });

  it("summarizes bare CLI commands and shell-wrapped commands", () => {
    expect(
      formatNativeTaskDisplayLabel({ label: "pnpm build", nativeKind: "command" }, "zh"),
    ).toBe("执行项目构建");
    expect(
      formatNativeTaskDisplayLabel(
        { label: "cargo test --lib -- session_spawn", nativeKind: "local_bash" },
        "zh",
      ),
    ).toBe("运行 Cargo 测试");
    expect(
      formatNativeTaskDisplayLabel(
        { label: "node scripts/test.mjs", nativeKind: "command" },
        "zh",
      ),
    ).toBe("运行测试脚本 test.mjs");
    expect(
      formatNativeTaskDisplayLabel(
        { label: "find /workspace", nativeKind: "local_bash" },
        "zh",
      ),
    ).toBe("检索文件 /workspace");
    expect(
      formatNativeTaskDisplayLabel(
        { label: "npx tsc --noEmit", nativeKind: "bash" },
        "zh",
      ),
    ).toBe("TypeScript 类型检查");
    expect(
      summarizeCliCommandZh('pwsh -NoProfile -Command "cd G:\\repo && NODE_ENV=test vitest run"'),
    ).toBe("运行 Vitest 测试");
  });

  it("never emits broken half-translated Chinglish and falls back to nativeSummary CLI command when needed", () => {
    expect(summarizeEnglishCommandPhraseZh("First build")).toBeNull();
    expect(summarizeEnglishCommandPhraseZh("Native command")).toBeNull();
    expect(summarizeEnglishCommandPhraseZh("Verify custom business invariant")).toBeNull();

    expect(
      formatNativeTaskDisplayLabel(
        { label: "First build", nativeKind: "local_bash" },
        "zh",
      ),
    ).toBe("First build");

    expect(
      formatNativeTaskDisplayLabel(
        { label: "Native command", nativeKind: "local_bash" },
        "zh",
      ),
    ).toBe("Native command");

    expect(
      formatNativeTaskDisplayLabel(
        {
          label: "Verify custom business invariant",
          nativeKind: "command",
          nativeSummary: "cargo test --quiet",
        },
        "zh",
      ),
    ).toBe("运行 Cargo 测试");
  });

  it("leaves non-command task kinds and English UI completely unchanged", () => {
    expect(
      formatNativeTaskDisplayLabel(
        {
          label: "Run isolated test suite and MCP smoke check",
          nativeKind: "local_agent",
        },
        "zh",
      ),
    ).toBe("Run isolated test suite and MCP smoke check");

    expect(
      formatNativeTaskDisplayLabel(
        {
          label: "Monitor background pipeline",
          nativeKind: "monitor",
        },
        "zh",
      ),
    ).toBe("Monitor background pipeline");

    expect(
      formatNativeTaskDisplayLabel(
        {
          label: "Run isolated test suite and MCP smoke check",
          nativeKind: "command",
          nativeSummary: "pnpm test",
        },
        "en",
      ),
    ).toBe("Run isolated test suite and MCP smoke check");

    expect(
      formatNativeTaskDisplayLabel(
        {
          label: "Production build",
          nativeKind: "command",
        },
        "en-US",
      ),
    ).toBe("Production build");
  });
});
