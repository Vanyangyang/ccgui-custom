//! Skills hub 后端：从参考项目 desktop-cc-gui 的 Rust 移植 `skills_hub/` 迁移而来
//! （MIT，Copyright (c) 2026 Thomas Ricouard / zhukunpenglinyutong（朱昆鹏）），
//! 上游可溯源到 TokenTracker 的 `skills-manager.js` / `skill-usage.js`（MIT）。
//!
//! 与参考实现的差异（均为适配本仓库）：
//! 1. SSOT 根目录为本应用数据目录下的 `skills-hub/`（`paths::app_home()`），
//!    可用 env `CCGUI_SKILLS_HUB_HOME` 覆盖（测试注入点）。参考实现用
//!    `~/.ccgui/skills`，与本应用的可写存储隔离，不共享注册表。
//! 2. 目标引擎首期仅 Claude Code / Codex；引擎目录解析走 `engine::engine_home`
//!    与 `engine::codex_home`，尊重 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 与设置页
//!    的 Codex 目录覆盖。只出现在 CLI 目录、不属于本应用托管的目标是只读来源
//!    （Codex `.system`、插件缓存、随包分发的内置 skill）。
//! 3. skill_usage 的统计范围固定为 Claude Code 会话转录
//!    （`<claude home>/projects/**/*.jsonl`），响应带 scope 字段说明；Codex
//!    没有可可靠读取的 Skill 调用记录，不可用时显示"暂无可用数据"。
//! 4. 删除/卸载入口对只读来源（内置、系统、插件）一律拒绝，保护
//!    `creator_skill.rs` 安装的随包 skill。

use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};

use super::core::*;
// ===== 小工具：JSON / fs / 编码 / JS 语义兼容 =====

pub(super) fn read_text(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

pub(super) fn read_json(path: &Path) -> Option<Value> {
    read_text(path).and_then(|text| serde_json::from_str(&text).ok())
}

pub(super) fn ensure_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)
}

/// unix 下把文件权限收紧到 0o600（registry/cache/activity 共用）；Windows 退化为 no-op。
pub(super) fn set_private_permissions(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// 以 unix 0o600 权限写文件（Windows 下退化为普通写；registry/cache/activity 共用）。
pub(super) fn write_file_private(path: &Path, contents: &str) -> std::io::Result<()> {
    fs::write(path, contents)?;
    set_private_permissions(path)
}

/// upstream writeJson：pretty 2 空格 + 尾换行 + 0o600。
pub(super) fn write_json(path: &Path, value: &Value) -> SkillResult<()> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let mut text =
        serde_json::to_string_pretty(value).map_err(|e| SkillError::other(e.to_string()))?;
    text.push('\n');
    write_file_private(path, &text).map_err(SkillError::from)
}

/// 追加一行（activity.jsonl 用），创建时 0o600。
pub(super) fn append_line_private(path: &Path, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(line.as_bytes())?;
    set_private_permissions(path)
}

pub(super) fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

/// upstream removePath：entity 或 dangling symlink 存在才删除，递归 force、吞错。
/// 符号链接按平台挑删除方式：Windows 的目录 symlink 只有 `remove_dir` 能删
/// （`remove_file` 报 Access denied），Unix 则相反 —— 先试 `remove_file`，
/// 失败再试 `remove_dir`，否则残留链接会被后续 copy 当作空目录写穿。
pub(super) fn remove_path(path: &Path) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() {
        if fs::remove_file(path).is_err() {
            let _ = fs::remove_dir(path);
        }
    } else if meta.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

/// 类似 Node `path.resolve`：拼成绝对路径并做词法归一（不解 symlink、不触盘）。
pub(super) fn resolve_lexical(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop(); // root 处的 `..` 归一时丢弃（root 上 pop 返回 false）
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

/// 对应 upstream pathStrictlyWithin：child 必须严格位于 parent 之内（词法判定）。
pub(super) fn path_strictly_within(parent: &Path, child: &Path) -> bool {
    match child.strip_prefix(parent) {
        Ok(rest) => !rest.as_os_str().is_empty(),
        Err(_) => false,
    }
}

/// upstream removeEmptyAncestors：从 startDir 逐级向上删空目录直到 stopDir。
pub(super) fn remove_empty_ancestors(start_dir: &Path, stop_dir: &Path) {
    let stop = resolve_lexical(stop_dir);
    let mut current = resolve_lexical(start_dir);
    while path_strictly_within(&stop, &current) {
        if fs::remove_dir(&current).is_err() {
            return;
        }
        let Some(parent) = current.parent() else {
            return;
        };
        current = parent.to_path_buf();
    }
}

/// 对应 fs.cpSync(source, dest, {recursive, force})（默认 follow symlink）。
pub(super) fn copy_dir_recursive(source: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        let meta = fs::metadata(entry.path())?;
        if meta.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// upstream copyDir：先防嵌套、清空 dest，再整目录递归 copy。
pub(super) fn copy_dir(source: &Path, dest: &Path) -> SkillResult<()> {
    assert_not_nested(source, dest)?;
    remove_path(dest);
    // 删不掉的残留链接不能当空目录写：create_dir_all 会顺着链接把文件灌进
    // 链接目标（SSOT 或用户自己的目录）。
    if is_symlink(dest) {
        return Err(SkillError::other(format!(
            "Could not clear symbolic link before copy: {}",
            dest.display()
        )));
    }
    copy_dir_recursive(source, dest).map_err(SkillError::from)
}

/// 平台 symlink（目录）；任何失败由调用方回退到 copy。
pub(super) fn symlink_dir(source: &Path, dest: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    return std::os::unix::fs::symlink(source, dest);
    #[cfg(windows)]
    return std::os::windows::fs::symlink_dir(source, dest);
    #[cfg(not(any(unix, windows)))]
    unreachable!("unsupported platform")
}

/// JS `encodeURIComponent`：保留 A-Za-z0-9 与 `- _ . ! ~ * ' ( )`。
pub(super) fn encode_uri_component(value: &str) -> String {
    const UNRESERVED: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";
    let mut out = String::new();
    for byte in value.as_bytes() {
        if UNRESERVED.contains(byte) {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// URLSearchParams 的 form-urlencoded：空格 → `+`，保留 A-Za-z0-9 与 `* - . _`。
pub(super) fn encode_form_param(value: &str) -> String {
    const KEEP: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._";
    let mut out = String::new();
    for byte in value.as_bytes() {
        if KEEP.contains(byte) {
            out.push(*byte as char);
        } else if *byte == b' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// GitHub raw/doc URL 的 path 部分逐段 encodeURIComponent。
pub(super) fn encode_url_path(path: &str) -> String {
    path.split('/')
        .map(encode_uri_component)
        .collect::<Vec<_>>()
        .join("/")
}
pub(super) fn github_raw_url(owner: &str, name: &str, branch: &str, file_path: &str) -> String {
    format!(
        "https://raw.githubusercontent.com/{owner}/{name}/{branch}/{}",
        encode_url_path(file_path)
    )
}
pub(super) fn github_doc_url(owner: &str, name: &str, branch: &str, file_path: &str) -> String {
    format!(
        "https://github.com/{owner}/{name}/blob/{branch}/{}",
        encode_url_path(file_path)
    )
}

/// uninstall trash 名：`base64url(directory, 无 padding)`。
pub(super) fn base64url_no_pad(value: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.as_bytes())
}

/// 近似 JS `String(value)`：null/missing → ""，基本类型转字符串，object/array → ""。
pub(super) fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => String::new(),
    }
}

/// 近似 JS `Number(value)`：string 先 trim，空串 → 0，非法 → NaN。
pub(super) fn js_f64(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// 对应 JS `Number(x || default)`：falsy（missing/null/false/0/""/NaN）→ default。
pub(super) fn js_number_or(value: Option<&Value>, default: f64) -> f64 {
    match value {
        None | Some(Value::Null) => default,
        Some(v) => {
            let n = js_f64(v);
            if n == 0.0 || n.is_nan() {
                default
            } else {
                n
            }
        }
    }
}

/// JS Number 的 JSON 序列化：整数值输出为整数（避免 serde_json 把 5.0 打成 "5.0"）。
pub(super) fn json_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() <= 9.0e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// JS 的 Unicode 大小写不敏感比较（`a.toLowerCase() === b.toLowerCase()`）。
pub(super) fn eq_ignore_case(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

// ===== 安全函数：sanitize 三件套 + targetSkillPath + assertNotNested =====

/// upstream sanitizePathSegment：拒空/`.`/`..`/含 `/` `\` `\0`；允许 `.hidden`。
pub(super) fn sanitize_path_segment(value: &str) -> Option<String> {
    let segment = value.trim();
    if segment.is_empty() || segment == "." || segment == ".." {
        return None;
    }
    if segment.contains('/') || segment.contains('\\') || segment.contains('\0') {
        return None;
    }
    Some(segment.to_string())
}

/// Node `path.win32.isAbsolute`：以 `/` 或 `\` 开头，或 `X:` 后接分隔符。
pub(super) fn is_win32_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    if bytes[0] == b'/' || bytes[0] == b'\\' {
        return true;
    }
    bytes.len() > 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// upstream sanitizeRelativePath：`\`→`/`，拒绝对路径/NUL/`.`/`..`/含 `:` 段。
pub(super) fn sanitize_relative_path(value: &str) -> Option<String> {
    let input = value.trim();
    let raw = input.replace('\\', "/");
    if raw.is_empty() || raw.contains('\0') {
        return None;
    }
    if raw.starts_with('/') || is_win32_absolute(input) || is_win32_absolute(&raw) {
        return None;
    }
    let parts: Vec<&str> = raw.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty()
        || parts
            .iter()
            .any(|part| *part == "." || *part == ".." || part.contains(':'))
    {
        return None;
    }
    Some(parts.join("/"))
}

/// upstream sanitizeLocalSkillPath = sanitizeRelativePath + 拒任何 `.` 开头段。
pub(super) fn sanitize_local_skill_path(value: &str) -> Option<String> {
    let safe = sanitize_relative_path(value)?;
    if safe.split('/').any(|part| part.starts_with('.')) {
        return None;
    }
    Some(safe)
}

/// upstream installNameFromDirectory：末段再过 sanitizePathSegment。
pub(super) fn install_name_from_directory(directory: &str) -> Option<String> {
    let safe = sanitize_relative_path(directory)?;
    safe.rsplit('/').next().and_then(sanitize_path_segment)
}

/// upstream targetSkillPath：词法归一 + 严格内含 + 中间祖先 lstat 校验。
pub(super) fn target_skill_path(base_dir: &Path, directory: &str) -> Option<PathBuf> {
    let safe = sanitize_relative_path(directory)?;
    let root = resolve_lexical(base_dir);
    let target = resolve_lexical(&root.join(&safe));
    if !path_strictly_within(&root, &target) {
        return None;
    }
    // root 若存在必须是目录；ENOENT 放行。
    match fs::metadata(&root) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    // safe 的中间祖先逐段 lstat：ENOENT 继续，symlink 或非目录 → None。
    let parts: Vec<&str> = safe.split('/').collect();
    let mut current = root.clone();
    for part in &parts[..parts.len() - 1] {
        current = current.join(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if !meta.file_type().is_symlink() && meta.is_dir() => {}
            Ok(_) => return None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
    }
    Some(target)
}

/// upstream managedSkillPath：SSOT managed/ 下的目标路径。
pub(super) fn managed_skill_path(directory: &str) -> SkillResult<PathBuf> {
    target_skill_path(&ssot_dir(), directory)
        .ok_or_else(|| SkillError::other(format!("Invalid skill directory: {directory}")))
}

/// upstream assertNotNested：resolve 后相等放行，互为严格祖先则拒绝。
pub(super) fn assert_not_nested(source: &Path, dest: &Path) -> SkillResult<()> {
    let a = resolve_lexical(source);
    let b = resolve_lexical(dest);
    if a == b {
        return Ok(());
    }
    if path_strictly_within(&a, &b) || path_strictly_within(&b, &a) {
        return Err(SkillError::other(
            "Refusing to sync a skill into its own directory tree",
        ));
    }
    Ok(())
}
