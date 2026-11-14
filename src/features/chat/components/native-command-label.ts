import type { AgentTaskStep } from "./agent-task-steps";

const NATIVE_COMMAND_KINDS = new Set([
  "bash",
  "command",
  "local_bash",
  "background_command",
]);

const CJK_CHAR_RE = /[\u3400-\u9fff]/u;
const LEADING_CJK_RE = /^[\u3400-\u9fff]/u;
const TRAILING_CJK_RE = /[\u3400-\u9fff]$/u;
const LEADING_LATIN_RE = /^[A-Za-z0-9]/;
const TRAILING_LATIN_RE = /[A-Za-z0-9]$/;

const SHELL_WRAPPERS = new Set(["pwsh", "powershell", "cmd", "bash", "sh", "zsh"]);

const EXACT_PHRASE_MAP: Record<string, string> = {
  "git status": "检查 Git 状态",
  "git status check": "检查 Git 状态",
  "check git status": "检查 Git 状态",
  "git diff": "检查 Git 差异",
  "git diff check": "检查 Git 差异",
  "check git diff": "检查 Git 差异",
  "git log": "查看 Git 提交记录",
  "unit test execution": "单元测试",
  "unit tests": "单元测试",
  "unit test": "单元测试",
  "integration tests": "集成测试",
  "integration test": "集成测试",
  "package build": "构建软件包",
  "production build": "生产构建",
  "prod build": "生产构建",
  "dev build": "开发构建",
  "development build": "开发构建",
  "dev server startup": "启动开发服务",
  "start dev server": "启动开发服务",
  "dev server": "开发服务",
  "development server": "开发服务",
  "background daemon": "后台守护进程",
  "type check": "类型检查",
  "typecheck": "类型检查",
  "type checking": "类型检查",
  "health check": "健康检查",
  "smoke check": "冒烟检查",
  "smoke test": "冒烟测试",
  "smoke tests": "冒烟测试",
};

const TWO_WORD_COMPOUNDS: Record<string, { text: string; kind: "mod" | "noun" }> = {
  "dual env": { text: "dual-env", kind: "mod" },
  "multi env": { text: "multi-env", kind: "mod" },
  "cross platform": { text: "cross-platform", kind: "mod" },
  "test suite": { text: "测试套件", kind: "noun" },
  "test suites": { text: "测试套件", kind: "noun" },
  "test execution": { text: "测试", kind: "noun" },
  "test run": { text: "测试", kind: "noun" },
  "smoke check": { text: "冒烟检查", kind: "noun" },
  "smoke checks": { text: "冒烟检查", kind: "noun" },
  "smoke test": { text: "冒烟测试", kind: "noun" },
  "smoke tests": { text: "冒烟测试", kind: "noun" },
  "health check": { text: "健康检查", kind: "noun" },
  "health checks": { text: "健康检查", kind: "noun" },
  "status check": { text: "状态检查", kind: "noun" },
  "diff check": { text: "差异检查", kind: "noun" },
  "type check": { text: "类型检查", kind: "noun" },
  "type checks": { text: "类型检查", kind: "noun" },
  "type checking": { text: "类型检查", kind: "noun" },
  "package build": { text: "包构建", kind: "noun" },
  "dev server": { text: "开发服务", kind: "noun" },
  "development server": { text: "开发服务", kind: "noun" },
  "server startup": { text: "服务启动", kind: "noun" },
  "code review": { text: "代码审查", kind: "noun" },
  "file watcher": { text: "文件监听", kind: "noun" },
};

const LEADING_VERBS: Record<string, string> = {
  run: "运行",
  running: "运行",
  execute: "执行",
  executing: "执行",
  start: "启动",
  starting: "启动",
  launch: "启动",
  launching: "启动",
  stop: "停止",
  stopping: "停止",
  kill: "停止",
  killing: "停止",
  restart: "重启",
  restarting: "重启",
  reload: "重启",
  reloading: "重启",
  check: "检查",
  checking: "检查",
  verify: "检查",
  verifying: "检查",
  validate: "检查",
  validating: "检查",
  build: "构建",
  building: "构建",
  compile: "构建",
  compiling: "构建",
  install: "安装",
  installing: "安装",
  clean: "清理",
  cleaning: "清理",
  watch: "监听",
  watching: "监听",
  monitor: "监听",
  monitoring: "监听",
  lint: "代码检查",
  linting: "代码检查",
  format: "格式化",
  formatting: "格式化",
  deploy: "部署",
  deploying: "部署",
  fetch: "拉取",
  fetching: "拉取",
  download: "拉取",
  downloading: "拉取",
  pull: "拉取",
  search: "检索",
  searching: "检索",
  scan: "检索",
  scanning: "检索",
  generate: "生成",
  generating: "生成",
};

const MODIFIERS: Record<string, string> = {
  isolated: "隔离",
  clean: "洁净",
  "dual-env": "双环境",
  "multi-env": "多环境",
  "cross-platform": "跨平台",
  production: "生产",
  prod: "生产",
  development: "开发",
  dev: "开发",
  staging: "预发",
  local: "本地",
  remote: "远程",
  full: "全量",
  all: "全量",
  unit: "单元",
  integration: "集成",
  e2e: "端到端",
  "end-to-end": "端到端",
  regression: "回归",
  background: "后台",
  foreground: "前台",
  parallel: "并行",
  concurrent: "并行",
  quick: "快速",
  fast: "快速",
  long: "长时",
  "long-running": "长时",
  frontend: "前端",
  client: "前端",
  backend: "后端",
  live: "实时",
  completed: "已完成",
};

const NOUNS: Record<string, string> = {
  smoke: "冒烟",
  test: "测试",
  tests: "测试",
  testing: "测试",
  suite: "套件",
  suites: "套件",
  build: "构建",
  builds: "构建",
  bundle: "打包",
  bundling: "打包",
  compile: "编译",
  compilation: "编译",
  typecheck: "类型检查",
  "type-check": "类型检查",
  lint: "代码检查",
  linter: "代码检查",
  linting: "代码检查",
  check: "检查",
  checks: "检查",
  verification: "验证",
  validation: "验证",
  status: "状态",
  diff: "差异",
  server: "服务",
  service: "服务",
  startup: "启动",
  daemon: "守护进程",
  watcher: "监听进程",
  worker: "工作进程",
  dependencies: "依赖",
  dependency: "依赖",
  deps: "依赖",
  package: "包",
  packages: "包",
  script: "脚本",
  scripts: "脚本",
  benchmark: "基准测试",
  benchmarks: "基准测试",
  bench: "基准测试",
  migration: "迁移",
  migrations: "迁移",
  coverage: "覆盖率",
  log: "日志",
  logs: "日志",
  cache: "缓存",
  database: "数据库",
  db: "数据库",
};

const TECH_TERMS: Record<string, string> = {
  mcp: "MCP",
  acp: "ACP",
  cce: "CCE",
  cli: "CLI",
  api: "API",
  rest: "REST",
  graphql: "GraphQL",
  rpc: "RPC",
  grpc: "gRPC",
  ipc: "IPC",
  gui: "GUI",
  ui: "UI",
  ux: "UX",
  dom: "DOM",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  sql: "SQL",
  sqlite: "SQLite",
  postgres: "Postgres",
  redis: "Redis",
  rust: "Rust",
  cargo: "Cargo",
  clippy: "Clippy",
  node: "Node",
  "node.js": "Node.js",
  nodejs: "Node.js",
  npm: "npm",
  pnpm: "pnpm",
  yarn: "Yarn",
  bun: "Bun",
  deno: "Deno",
  vite: "Vite",
  vitest: "Vitest",
  jest: "Jest",
  mocha: "Mocha",
  playwright: "Playwright",
  cypress: "Cypress",
  pytest: "Pytest",
  python: "Python",
  go: "Go",
  java: "Java",
  typescript: "TypeScript",
  ts: "TS",
  javascript: "JavaScript",
  js: "JS",
  tsc: "tsc",
  eslint: "ESLint",
  biome: "Biome",
  prettier: "Prettier",
  tauri: "Tauri",
  react: "React",
  vue: "Vue",
  next: "Next",
  git: "Git",
  github: "GitHub",
  docker: "Docker",
  wsl: "WSL",
  windows: "Windows",
  linux: "Linux",
  macos: "macOS",
  web: "Web",
  http: "HTTP",
  sse: "SSE",
  websocket: "WebSocket",
  ci: "CI",
};

const STOPWORDS = new Set(["the", "a", "an", "for", "of"]);

const KNOWN_CLI_BINARIES = new Set([
  "cargo",
  "rustc",
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "bun",
  "bunx",
  "vitest",
  "jest",
  "pytest",
  "playwright",
  "tsc",
  "vite",
  "eslint",
  "biome",
  "prettier",
  "node",
  "tsx",
  "ts-node",
  "deno",
  "python",
  "python3",
  "py",
  "uv",
  "go",
  "dotnet",
  "git",
  "find",
  "rg",
  "grep",
  "pwsh",
  "powershell",
  "cmd",
  "bash",
  "sh",
  "zsh",
  "make",
  "cmake",
  "docker",
  "docker-compose",
]);

function normalizeCommandKind(kind?: string): string {
  return (kind ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function isNativeCommandKind(kind?: string): boolean {
  return NATIVE_COMMAND_KINDS.has(normalizeCommandKind(kind));
}

function joinZhSegments(parts: string[]): string {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    const needSpace =
      (TRAILING_CJK_RE.test(out) && LEADING_LATIN_RE.test(part)) ||
      (TRAILING_LATIN_RE.test(out) && LEADING_CJK_RE.test(part)) ||
      (TRAILING_LATIN_RE.test(out) && LEADING_LATIN_RE.test(part));
    out += needSpace ? ` ${part}` : part;
  }
  return out;
}

function translateCommandClauseZh(rawClause: string): string | null {
  const cleaned = rawClause
    .trim()
    .replace(/\bend\s+to\s+end\b/gi, "end-to-end")
    .replace(/\s+/g, " ");
  if (!cleaned) return null;

  const exact = EXACT_PHRASE_MAP[cleaned.toLowerCase()];
  if (exact) return exact;

  const rawTokens = cleaned.split(" ").filter(Boolean);
  if (rawTokens.length === 0) return null;

  const pieces: string[] = [];
  let index = 0;

  while (index < rawTokens.length) {
    const raw = rawTokens[index].replace(/^[`"']+|[`"'.:;!?]+$/g, "");
    if (!raw) {
      index += 1;
      continue;
    }
    const lower = raw.toLowerCase();

    if (STOPWORDS.has(lower)) {
      index += 1;
      continue;
    }

    if (index + 1 < rawTokens.length) {
      const nextClean = rawTokens[index + 1]
        .replace(/^[`"']+|[`"'.:;!?]+$/g, "")
        .toLowerCase();
      const twoWord = TWO_WORD_COMPOUNDS[`${lower} ${nextClean}`];
      if (twoWord) {
        if (twoWord.kind === "mod" && MODIFIERS[twoWord.text]) {
          pieces.push(MODIFIERS[twoWord.text]);
        } else {
          pieces.push(twoWord.text);
        }
        index += 2;
        continue;
      }
    }

    if (index === 0 && rawTokens.length > 1 && LEADING_VERBS[lower]) {
      pieces.push(LEADING_VERBS[lower]);
      index += 1;
      continue;
    }

    if (MODIFIERS[lower]) {
      pieces.push(MODIFIERS[lower]);
      index += 1;
      continue;
    }

    if (NOUNS[lower]) {
      pieces.push(NOUNS[lower]);
      index += 1;
      continue;
    }

    if (TECH_TERMS[lower]) {
      pieces.push(TECH_TERMS[lower]);
      index += 1;
      continue;
    }

    return null;
  }

  if (pieces.length === 0) return null;
  const joined = joinZhSegments(pieces);
  return CJK_CHAR_RE.test(joined) ? joined : null;
}

export function summarizeEnglishCommandPhraseZh(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed || CJK_CHAR_RE.test(trimmed)) return null;

  const rawClauses = trimmed
    .split(/\s*(?:,\s*(?:and\s+)?|\s+(?:and|&|\+)\s+)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (rawClauses.length === 0 || rawClauses.length > 4) return null;

  const translated: string[] = [];
  for (const clause of rawClauses) {
    const zh = translateCommandClauseZh(clause);
    if (!zh) return null;
    translated.push(zh);
  }

  if (translated.length === 1) return translated[0];
  if (translated.length === 2) return joinZhSegments([translated[0], "与", translated[1]]);
  return joinZhSegments([
    translated.slice(0, -1).join("、"),
    "与",
    translated[translated.length - 1],
  ]);
}

function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        current += input[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function commandBaseName(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  const last = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return last.replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
}

function scriptBaseName(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function unwrapShellCommand(rawCommand: string): string {
  let current = rawCommand.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    const tokens = tokenizeCommandLine(current);
    if (tokens.length < 2) break;
    const bin = commandBaseName(tokens[0]);
    if (!SHELL_WRAPPERS.has(bin)) break;

    let cmdIndex = -1;
    for (let i = 1; i < tokens.length - 1; i += 1) {
      const flag = tokens[i].toLowerCase();
      if (flag === "-c" || flag === "-lc" || flag === "/c" || flag === "-command" || flag === "-encodedcommand") {
        cmdIndex = i + 1;
        break;
      }
    }
    if (cmdIndex === -1 || cmdIndex >= tokens.length) break;
    current = tokens.slice(cmdIndex).join(" ").trim();
  }
  return current;
}

function extractLeadingCommandTokens(rawCommand: string): string[] {
  const unwrapped = unwrapShellCommand(rawCommand);
  const firstSegment = unwrapped.split(/\s*(?:&&|\|\||;)\s*/);
  let selected = firstSegment[0]?.trim() ?? "";

  for (let i = 0; i < firstSegment.length; i += 1) {
    const seg = firstSegment[i].trim();
    if (!seg) continue;
    const segTokens = tokenizeCommandLine(seg);
    if (segTokens.length > 0 && commandBaseName(segTokens[0]) === "cd") {
      continue;
    }
    selected = seg;
    break;
  }

  let tokens = tokenizeCommandLine(selected);
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    tokens = tokens.slice(1);
  }
  if (tokens.length > 1 && commandBaseName(tokens[0]) === "env") {
    tokens = tokens.slice(1);
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens = tokens.slice(1);
    }
  }
  return tokens;
}

function summarizeScriptRun(scriptToken: string): string | null {
  if (!scriptToken || scriptToken.startsWith("-")) return null;
  const base = scriptBaseName(scriptToken);
  if (!base || /[\s"'`<>|&;]/.test(base)) return null;
  const lower = base.toLowerCase();
  if (lower.includes("smoke")) return `运行冒烟脚本 ${base}`;
  if (lower.includes("test") || lower.includes("spec")) return `运行测试脚本 ${base}`;
  if (lower.includes("build") || lower.includes("bundle")) return `运行构建脚本 ${base}`;
  if (lower.includes("check") || lower.includes("verify") || lower.includes("lint")) {
    return `运行检查脚本 ${base}`;
  }
  return `运行脚本 ${base}`;
}

function summarizePackageManagerScript(scriptName: string): string {
  const lower = scriptName.toLowerCase();
  if (lower === "build" || lower.startsWith("build:") || lower.endsWith(":build")) return "执行项目构建";
  if (lower === "dev" || lower === "start" || lower.startsWith("dev:")) return "启动开发服务";
  if (lower === "lint" || lower.startsWith("lint:")) return "运行代码检查";
  if (lower === "typecheck" || lower === "type-check" || lower.includes("tsc")) return "TypeScript 类型检查";
  if (lower === "test" || lower.startsWith("test:")) return "运行项目测试";
  if (lower === "check" || lower.startsWith("check:")) return "执行项目检查";
  if (lower === "e2e" || lower.includes("e2e")) return "运行端到端测试";
  if (lower.includes("smoke")) return "运行冒烟测试";
  if (lower === "install" || lower === "ci") return "安装项目依赖";
  return `运行脚本 ${scriptName}`;
}

function summarizeRunnerTokens(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const bin = commandBaseName(tokens[0]);
  const args = tokens.slice(1);
  const sub = args.find((a) => !a.startsWith("-"))?.toLowerCase();

  if (bin === "pnpm" || bin === "npm" || bin === "yarn" || bin === "bun") {
    if (sub === "exec" || sub === "dlx" || sub === "x") {
      const subIdx = args.findIndex((a) => a.toLowerCase() === sub);
      if (subIdx !== -1 && subIdx + 1 < args.length) {
        return summarizeRunnerTokens(args.slice(subIdx + 1));
      }
    }
    if (sub === "run" || sub === "run-script") {
      const subIdx = args.findIndex((a) => a.toLowerCase() === sub);
      const script = subIdx !== -1 ? args.slice(subIdx + 1).find((a) => !a.startsWith("-")) : undefined;
      if (script) return summarizePackageManagerScript(script);
    }
    if (sub) return summarizePackageManagerScript(sub);
    return null;
  }

  if (bin === "npx" || bin === "bunx") {
    const nextIdx = args.findIndex((a) => !a.startsWith("-"));
    if (nextIdx !== -1) {
      return summarizeRunnerTokens(args.slice(nextIdx));
    }
    return null;
  }

  if (bin === "cargo") {
    if (sub === "test") return "运行 Cargo 测试";
    if (sub === "check") return "运行 Cargo 检查";
    if (sub === "clippy") return "运行 Clippy 检查";
    if (sub === "build") return "执行 Cargo 构建";
    if (sub === "run") return "运行 Cargo 程序";
    if (sub === "fmt") return "格式化 Rust 代码";
    return "运行 Cargo 任务";
  }

  if (bin === "vitest") return "运行 Vitest 测试";
  if (bin === "jest") return "运行 Jest 测试";
  if (bin === "pytest") return "运行 Pytest 测试";
  if (bin === "playwright") return "运行 Playwright 测试";
  if (bin === "tsc") return "TypeScript 类型检查";
  if (bin === "eslint" || bin === "biome") return "运行代码检查";
  if (bin === "prettier") return "格式化代码";
  if (bin === "vite") return sub === "build" ? "执行 Vite 构建" : "启动 Vite 服务";

  if (bin === "node" || bin === "tsx" || bin === "ts-node" || bin === "deno") {
    if (args.some((a) => a === "--test")) return "运行 Node 测试";
    const firstNonFlag = args.find((a) => !a.startsWith("-"));
    return firstNonFlag ? summarizeScriptRun(firstNonFlag) : null;
  }

  if (bin === "python" || bin === "python3" || bin === "py" || bin === "uv") {
    if (bin === "uv" && sub === "run") {
      const subIdx = args.findIndex((a) => a.toLowerCase() === "run");
      if (subIdx !== -1 && subIdx + 1 < args.length) {
        return summarizeRunnerTokens(args.slice(subIdx + 1));
      }
    }
    const mIdx = args.indexOf("-m");
    if (mIdx !== -1 && args[mIdx + 1]) {
      return summarizeRunnerTokens(args.slice(mIdx + 1));
    }
    const firstNonFlag = args.find((a) => !a.startsWith("-"));
    return firstNonFlag ? summarizeScriptRun(firstNonFlag) : null;
  }

  if (bin === "git") {
    if (sub === "status") return "检查 Git 状态";
    if (sub === "diff") return "检查 Git 差异";
    if (sub === "log") return "查看 Git 提交记录";
    if (sub === "pull" || sub === "fetch") return "拉取 Git 仓库更新";
    return "执行 Git 操作";
  }

  if (bin === "find") {
    const target = args.find((a) => !a.startsWith("-"));
    return target ? `检索文件 ${target}` : "检索目录文件";
  }

  if (bin === "rg" || bin === "grep") return "检索代码内容";

  if (bin === "go") {
    if (sub === "test") return "运行 Go 测试";
    if (sub === "build") return "执行 Go 构建";
    if (sub === "run") return "运行 Go 程序";
  }

  if (bin === "dotnet") {
    if (sub === "test") return "运行 .NET 测试";
    if (sub === "build") return "执行 .NET 构建";
    if (sub === "run") return "运行 .NET 程序";
  }

  return null;
}

export function summarizeCliCommandZh(rawCommand?: string): string | null {
  if (!rawCommand?.trim()) return null;
  const tokens = extractLeadingCommandTokens(rawCommand);
  return summarizeRunnerTokens(tokens);
}

function looksLikeCliCommand(label: string): boolean {
  const trimmed = label.trim();
  if (!trimmed) return false;
  if (/[\\/|;&`]|--[A-Za-z]/.test(trimmed)) return true;
  const firstToken = tokenizeCommandLine(trimmed)[0];
  if (!firstToken) return false;
  // Require lowercase bare executable name (or explicit path/extension) so capitalized
  // English phrases like "Git status check" or "Node integration tests" go to phrase translation first.
  const isLowerBare = firstToken === firstToken.toLowerCase();
  const hasPathOrExt = /[\\/]|\.(?:exe|cmd|bat|ps1|mjs|cjs|js|ts|py|sh)$/i.test(firstToken);
  return (isLowerBare || hasPathOrExt) && KNOWN_CLI_BINARIES.has(commandBaseName(firstToken));
}

export function formatNativeTaskDisplayLabel(
  step: Pick<AgentTaskStep, "label" | "nativeKind" | "nativeSummary">,
  language: string,
): string {
  if (!language?.toLowerCase().startsWith("zh")) return step.label;
  if (!isNativeCommandKind(step.nativeKind)) return step.label;
  const trimmed = step.label?.trim();
  if (!trimmed) return step.label;

  if (CJK_CHAR_RE.test(trimmed)) return trimmed;

  if (trimmed.toLowerCase() === "background command") {
    return summarizeCliCommandZh(step.nativeSummary) ?? "执行后台命令";
  }

  if (looksLikeCliCommand(trimmed)) {
    const cliSummary = summarizeCliCommandZh(trimmed) ?? summarizeCliCommandZh(step.nativeSummary);
    if (cliSummary) return cliSummary;
  }

  const phraseSummary = summarizeEnglishCommandPhraseZh(trimmed);
  if (phraseSummary) return phraseSummary;

  const fallbackCliSummary = summarizeCliCommandZh(step.nativeSummary);
  if (fallbackCliSummary) return fallbackCliSummary;

  return step.label;
}
