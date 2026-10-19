//! Skills hub 后端：从参考项目 desktop-cc-gui 的 Rust 移植 `skills_hub/` 迁移而来
//! （MIT，Copyright (c) 2026 Thomas Ricouard / zhukunpenglinyutong（朱昆鹏）），
//! 上游可溯源到 TokenTracker 的 `skills-manager.js` / `skill-usage.js`（MIT）。
//!
//! 与参考实现的差异（均为适配本仓库）：
//! 1. SSOT 根目录为本应用数据目录下的 `skills-hub/`（`paths::app_home()`），
//!    可用 env `CCGUI_SKILLS_HUB_HOME` 覆盖（测试注入点）。参考实现用
//!    `~/.ccgui/skills`，与本应用的可写存储隔离，不共享注册表。
//! 2. 同步目标覆盖本应用接入的全部 CLI（Claude / Codex / Kimi / Grok / PI /
//!    OMP / dsh / Antigravity / Gemini / OpenCode / Qoder / Qoder CN / Hermes）
//!    加跨 agent 的 `~/.agents`；每个 CLI 的 home 走它自己的 env 与设置页
//!    覆盖（见 `engine::engine_home` / `engine::codex_home`）。home 不存在的
//!    目标标 `available: false`，UI 隐去。只出现在 CLI 目录、不属于本应用
//!    托管的目标是只读来源（Codex `.system` 与插件缓存、dsh `.system`、
//!    随包分发的内置 skill）。
//! 3. skill_usage 的统计范围固定为 Claude Code 会话转录
//!    （`<claude home>/projects/**/*.jsonl`），响应带 scope 字段说明；其他
//!    引擎没有可可靠读取的 Skill 调用记录，不可用时显示"暂无可用数据"。
//! 4. 删除/卸载入口对只读来源（内置、系统、插件）一律拒绝，保护
//!    `creator_skill.rs` 安装的随包 skill。

use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::fsutil::*;
// ===== 常量（与上游 skills-manager.js / skill-usage.js 对齐） =====

pub(super) const FETCH_TIMEOUT: Duration = Duration::from_secs(20); // upstream FETCH_TIMEOUT_MS
pub(super) const DISCOVER_CONCURRENCY: usize = 4; // upstream DISCOVER_CONCURRENCY
pub(super) const DISCOVER_CACHE_TTL_MS: i64 = 60 * 60 * 1000; // 1 小时
pub(super) const UPDATE_CACHE_TTL_MS: i64 = 60 * 60 * 1000; // 1 小时
pub(super) const UPDATE_CHECK_CONCURRENCY: usize = 2; // upstream UPDATE_CHECK_CONCURRENCY
pub(super) const POPULAR_CACHE_TTL_MS: i64 = 6 * 60 * 60 * 1000; // 6 小时
pub(super) const TRASH_TTL_MS: i64 = 5 * 60 * 1000; // 5 分钟
pub(super) const ACTIVITY_MAX: usize = 500; // upstream ACTIVITY_MAX
pub(super) const ACTIVITY_TRIM_BYTES: u64 = 256 * 1024; // 超过则截尾保留最后 ACTIVITY_MAX 行
pub(super) const USAGE_CACHE_TTL_MS: i64 = 10 * 60 * 1000; // 10 分钟
pub(super) const MAX_LOCAL_SKILL_SCAN_DEPTH: usize = 3; // upstream MAX_LOCAL_SKILL_SCAN_DEPTH
pub(super) const DISCOVER_MAX_SKILLS_PER_REPO: usize = 200; // upstream discover 单 repo 截断 200
pub(super) const POPULAR_SEED_QUERIES: [&str; 12] = [
    "agent", "code", "test", "review", "git", "web", "design", "data", "docs", "python", "api",
    "deploy",
];
pub(super) const HASH_IGNORE: [&str; 4] = [".git", ".DS_Store", "Thumbs.db", ".gitignore"];
/// 统计口径：Claude Code 的会话转录（含 Skill 工具调用）。
pub(super) const USAGE_SCOPE_CLAUDE_TRANSCRIPTS: &str = "claude_code_transcripts";

// ===== 错误类型：RateLimit 需要在 allSettled 语义里被单独识别并上抛 =====

#[derive(Debug)]
pub(super) enum SkillError {
    /// GitHub / skills.sh 限流（HTTP 429|403），文案必须与 upstream 一致。
    RateLimited(String),
    /// 带错误码的失败：前端据此给出对应恢复路径。
    Coded(&'static str, String),
    Other(String),
}

impl SkillError {
    pub(super) fn other(message: impl Into<String>) -> Self {
        Self::Other(message.into())
    }
    pub(super) fn coded(code: &'static str, message: impl Into<String>) -> Self {
        Self::Coded(code, message.into())
    }
    pub(super) fn is_rate_limited(&self) -> bool {
        matches!(self, Self::RateLimited(_))
    }
}

impl std::fmt::Display for SkillError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RateLimited(m) | Self::Coded(_, m) | Self::Other(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for SkillError {}

impl From<std::io::Error> for SkillError {
    fn from(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "permission",
            std::io::ErrorKind::AlreadyExists => "conflict",
            _ => "internal",
        };
        Self::coded(code, error.to_string())
    }
}

pub(super) type SkillResult<T> = Result<T, SkillError>;

// ===== 路径解析：SSOT 根目录（可注入）与本应用托管的引擎目标 =====

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// SSOT 根目录：env `CCGUI_SKILLS_HUB_HOME` 覆盖（测试注入点），
/// 缺省 `~/.ccgui-next/skills-hub`（本应用自己的数据目录，与参考项目隔离）。
pub(super) fn skills_root() -> PathBuf {
    if let Some(override_dir) = std::env::var_os("CCGUI_SKILLS_HUB_HOME") {
        if !override_dir.is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    crate::paths::app_home().join("skills-hub")
}

pub(super) fn registry_path() -> PathBuf {
    skills_root().join("registry.json")
}
pub(super) fn ssot_dir() -> PathBuf {
    skills_root().join("managed")
}
pub(super) fn trash_dir() -> PathBuf {
    skills_root().join(".trash")
}
pub(super) fn tmp_dir() -> PathBuf {
    skills_root().join("tmp")
}
pub(super) fn discover_cache_path() -> PathBuf {
    skills_root().join("discover-cache.json")
}
pub(super) fn updates_cache_path() -> PathBuf {
    skills_root().join("updates-cache.json")
}
pub(super) fn popular_cache_path() -> PathBuf {
    skills_root().join("popular-cache.json")
}
pub(super) fn activity_path() -> PathBuf {
    skills_root().join("activity.jsonl")
}
pub(super) fn usage_cache_path() -> PathBuf {
    skills_root().join("usage-cache.json")
}

pub(super) fn is_dir(path: &Path) -> bool {
    fs::metadata(path)
        .map(|meta| meta.is_dir())
        .unwrap_or(false)
}

// ===== 目标引擎：每个 CLI 自己的用户级 skills 根 =====
//
// 只登记 CLI 真正会读取的目录：写进别处的副本引擎看不到，那是假同步。目录
// 解析与设置页/聊天页共用 `engine::engine_home` / `codex_home` 与各 CLI 自己
// 的环境变量（Claude 的 `CLAUDE_CONFIG_DIR`、Codex 的 `CODEX_HOME` 与设置页
// 覆盖、Grok 的 `GROK_HOME`……），并把引擎 home 不存在（没装该 CLI）的目标
// 标记为 unavailable，由 UI 隐去，避免凭空造出一堆空目录。

/// pi / omp 的用户 skills 在 agent 目录下（`$PI_CODING_AGENT_DIR` /
/// `$OMP_CODING_AGENT_DIR`，缺省 `~/.pi/agent`、`~/.omp/agent`），不在配置根；
/// omp 是 pi 的 fork，两个变量它都认。
fn coding_agent_home(env_keys: &[&str], home_dir_name: &str) -> PathBuf {
    if let Some(home) = crate::development_profile::home() { return home.join(home_dir_name).join("agent"); }
    for key in env_keys {
        if let Some(dir) = std::env::var_os(key).filter(|value| !value.is_empty()) {
            return PathBuf::from(dir);
        }
    }
    crate::engine::engine_home(None, home_dir_name).join("agent")
}

/// Antigravity 的一个目标覆盖三个 home：应用自带的 `agy` 引擎（CLI）、
/// Antigravity 应用与 Antigravity IDE（参考实现的扫描范围）。
fn antigravity_homes() -> Vec<PathBuf> {
    let mut homes = vec![crate::engine::engine_home(
        Some("ANTIGRAVITY_HOME"),
        ".gemini/antigravity-cli",
    )];
    for home in [".gemini/antigravity", ".gemini/antigravity-ide"] {
        homes.push(crate::engine::engine_home(None, home));
    }
    homes
}

/// 本应用托管的同步目标；`agents` 是跨 agent 的共享 skills 根（Claude /
/// Codex / Kimi / dsh 等都读它），沿用参考实现的隐藏目标：不进 UI 引擎
/// 列表，但参与扫描/分类/同步，保证"移除某个引擎副本"的语义完整。
pub(super) enum TargetKind {
    Claude,
    Codex,
    Cursor,
    Kimi,
    Grok,
    Pi,
    Omp,
    Dsh,
    Agy,
    Gemini,
    Opencode,
    Qoder,
    QoderCn,
    Hermes,
    Agents,
}

pub(super) struct Target {
    pub(super) id: &'static str,
    pub(super) label: &'static str,
    pub(super) visible: bool, // visible=false 不进 targetList
    pub(super) kind: TargetKind,
}

/// 支持全部已接入 CLI 的用户级 skills 根；顺序与设置页引擎列表一致
/// （`config.rs` 的 ENGINE_IDS），Gemini CLI / Hermes 追加在末尾。
pub(super) static TARGETS: [Target; 15] = [
    Target {
        id: "claude",
        label: "Claude",
        visible: true,
        kind: TargetKind::Claude,
    },
    Target {
        id: "codex",
        label: "Codex",
        visible: true,
        kind: TargetKind::Codex,
    },
    Target {
        id: "cursor",
        label: "Cursor",
        visible: true,
        kind: TargetKind::Cursor,
    },
    Target {
        id: "kimi",
        label: "Kimi",
        visible: true,
        kind: TargetKind::Kimi,
    },
    Target {
        id: "grok",
        label: "Grok",
        visible: true,
        kind: TargetKind::Grok,
    },
    Target {
        id: "pi",
        label: "PI",
        visible: true,
        kind: TargetKind::Pi,
    },
    Target {
        id: "omp",
        label: "OMP",
        visible: true,
        kind: TargetKind::Omp,
    },
    Target {
        id: "dsh",
        label: "DeepSeek",
        visible: true,
        kind: TargetKind::Dsh,
    },
    Target {
        id: "agy",
        label: "Antigravity",
        visible: true,
        kind: TargetKind::Agy,
    },
    Target {
        id: "gemini",
        label: "Gemini",
        visible: true,
        kind: TargetKind::Gemini,
    },
    Target {
        id: "opencode",
        label: "OpenCode",
        visible: true,
        kind: TargetKind::Opencode,
    },
    Target {
        id: "qoder",
        label: "Qoder",
        visible: true,
        kind: TargetKind::Qoder,
    },
    Target {
        id: "qoder-cn",
        label: "Qoder CN",
        visible: true,
        kind: TargetKind::QoderCn,
    },
    Target {
        id: "hermes",
        label: "Hermes",
        visible: true,
        kind: TargetKind::Hermes,
    },
    Target {
        id: "agents",
        label: "Agents",
        visible: false,
        kind: TargetKind::Agents,
    },
];

pub(super) fn target_by_id(id: &str) -> Option<&'static Target> {
    TARGETS.iter().find(|target| target.id == id)
}

fn skills_dirs_for_id(id: &str) -> Vec<PathBuf> {
    target_by_id(id).map(target_dirs).unwrap_or_default()
}

/// 目标的引擎 home（skills 根的父目录）；多目录 target（Antigravity）返回多个。
pub(super) fn target_home_dirs(target: &Target) -> Vec<PathBuf> {
    match target.kind {
        TargetKind::Claude => vec![crate::engine::engine_home(Some("CLAUDE_CONFIG_DIR"), ".claude")],
        TargetKind::Codex => vec![crate::engine::codex_home()],
        TargetKind::Cursor => vec![crate::engine::cursor::cursor_home()],
        TargetKind::Kimi => vec![crate::engine::engine_home(Some("KIMI_CODE_HOME"), ".kimi-code")],
        TargetKind::Grok => vec![crate::engine::engine_home(Some("GROK_HOME"), ".grok")],
        TargetKind::Pi => vec![coding_agent_home(&["PI_CODING_AGENT_DIR"], ".pi")],
        TargetKind::Omp => vec![coding_agent_home(
            &["OMP_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"],
            ".omp",
        )],
        TargetKind::Dsh => vec![crate::engine::engine_home(Some("DSH_HOME"), ".dsh")],
        TargetKind::Agy => antigravity_homes(),
        TargetKind::Gemini => vec![crate::engine::engine_home(Some("GEMINI_DIR"), ".gemini")],
        TargetKind::Opencode => vec![crate::engine::engine_home(Some("XDG_CONFIG_HOME"), ".config")
            .join("opencode")],
        TargetKind::Qoder => vec![crate::engine::engine_home(None, ".qoder")],
        TargetKind::QoderCn => vec![crate::engine::engine_home(None, ".qoder-cn")],
        TargetKind::Hermes => vec![crate::engine::engine_home(Some("HERMES_HOME"), ".hermes")],
        TargetKind::Agents => vec![crate::engine::engine_home(None, ".agents")],
    }
}

/// 目标目录在调用时按 env/home 动态解析（测试可经 HOME / 各 CLI 的 env 注入）。
pub(super) fn target_dirs(target: &Target) -> Vec<PathBuf> {
    target_home_dirs(target)
        .into_iter()
        .map(|home| home.join("skills"))
        .collect()
}

/// 对应 upstream targetPrimaryDir（多目录 target 取第一个用于 UI 展示）。
pub(super) fn target_primary_dir(target: &Target) -> PathBuf {
    target_dirs(target).into_iter().next().unwrap_or_default()
}

/// 该引擎是否装着（home 存在）：UI 用它把没装的 CLI 隐去。已存在的副本
/// （含副本丢失的 orphan）不受影响——卸载 CLI 不能把清理路径一起藏掉。
fn target_available(target: &Target) -> bool {
    target_dirs(target)
        .iter()
        .any(|dir| is_dir(dir) || dir.parent().is_some_and(is_dir))
}

/// 对应 upstream targetList：仅 visible target。`available` 是本地扩展。
pub(super) fn target_list() -> Vec<Value> {
    TARGETS
        .iter()
        .filter(|target| target.visible)
        .map(|t| {
            json!({
                "id": t.id,
                "label": t.label,
                "path": target_primary_dir(t).to_string_lossy(),
                "readonly": false,
                "available": target_available(t),
            })
        })
        .collect()
}

/// 引擎 home 已存在、可以直接写入的 skills 根（含隐藏的 `agents`）。
/// `creator_skill` 用它把随包分发的内置 skill 装进每个已安装的 CLI：
/// 没装的引擎不替用户建目录（与 `creator_skill` 的既有约定一致）。
pub(crate) fn installed_engine_skill_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for target in TARGETS.iter() {
        let homes = target_home_dirs(target);
        for (home, root) in homes.into_iter().zip(target_dirs(target)) {
            if !home.is_dir() || roots.contains(&root) {
                continue;
            }
            roots.push(root);
        }
    }
    roots
}

// ===== 只读来源：本应用不纳管、只扫描展示的 skill 目录 =====

/// 只读来源的种类。UI 用它区分"内置 / 系统 / 插件提供"，并禁用所有删除入口。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum ReadonlyKind {
    /// 随包分发的内置 skill（creator_skill.rs 安装到各引擎 skills 根）。
    Builtin,
    /// Codex 自带的 `.system` skills。
    System,
    /// Codex 插件缓存里随插件附带的 skills。
    Plugin,
}

impl ReadonlyKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Builtin => "builtin",
            Self::System => "system",
            Self::Plugin => "plugin",
        }
    }
}

pub(super) struct ReadonlySource {
    pub(super) kind: ReadonlyKind,
    pub(super) dir: PathBuf,
}

/// 内置 skill 的保留目录名（来自 `creator_skill::BUNDLED_SKILL_IDS`）。这些目录即使出现在
/// 引擎的托管目标根里也按“内置”处理：只读、禁止删除/导入。
pub(super) fn bundled_skill_names() -> HashSet<String> {
    crate::creator_skill::BUNDLED_SKILL_IDS.iter()
        .map(|id| (*id).to_string())
        .collect()
}

/// 当前存在的只读来源目录。引擎自带的 `.system`（Codex / dsh）与插件
/// 缓存目录在未安装时不存在，函数只返回真实存在的目录。
pub(super) fn readonly_sources() -> Vec<ReadonlySource> {
    let mut out: Vec<ReadonlySource> = Vec::new();
    let mut push_system = |dir: PathBuf| {
        if is_dir(&dir) {
            out.push(ReadonlySource {
                kind: ReadonlyKind::System,
                dir,
            });
        }
    };
    let codex_home = crate::engine::codex_home();
    push_system(codex_home.join("skills").join(".system"));
    // dsh 的用户 skills 根同样带一个 `.system` 子目录（随 CLI 分发）。
    for dir in skills_dirs_for_id("dsh") {
        push_system(dir.join(".system"));
    }
    for (dir, _) in crate::slash_commands::codex_plugin_skills_dirs(&codex_home) {
        out.push(ReadonlySource {
            kind: ReadonlyKind::Plugin,
            dir,
        });
    }
    out
}

/// 一个 skill 目录的来源种类（用于 UI 徽标与写操作门禁）。
pub(super) fn readonly_kind_for_dir(directory: &str) -> Option<ReadonlyKind> {
    let leaf = install_name_from_directory(directory)?;
    if bundled_skill_names().contains(&leaf) {
        // 内置 skill 的名字是全局保留的：同名目录一律按内置保护，避免用户
        // 误建同名目录后被通用删除逻辑清掉、也避免被同步覆盖。
        return Some(ReadonlyKind::Builtin);
    }
    for source in readonly_sources() {
        if super::scan::find_skill_marker(&source.dir.join(&leaf)).is_some() {
            return Some(source.kind);
        }
    }
    None
}

/// 目录是否是"内置 skill 名"（不受位置影响，用于 import/delete 预检）。
pub(super) fn is_bundled_skill_name(directory: &str) -> bool {
    install_name_from_directory(directory)
        .map(|leaf| bundled_skill_names().contains(&leaf))
        .unwrap_or(false)
}
