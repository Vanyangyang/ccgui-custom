//! WSL 发行版内的引擎模型目录:经 wsl_transport 远程跑各 CLI 的模型命令
//! (bin = 插件探针写进 meta 的发行版内绝对路径),解析复用本机同名解析器。
//! 所有远程 catalog 都带 remote 旗标:即使为空,前端也不得掺本机配置。

use super::{pi, EngineCatalog, EngineModel};

use crate::engine::wsl_transport::WslTransport;

pub(super) async fn pi_family_catalog_remote(
    engine: &str,
    transport: &WslTransport,
) -> EngineCatalog {
    let (Some(bin), Some(cwd)) = (bin_for(transport, engine), remote_cwd(transport)) else {
        return EngineCatalog::authoritative_remote(Vec::new());
    };
    let script = format!("cd {cwd} 2>/dev/null; {bin} models --json");
    match crate::engine::wsl_transport::run_script_output(transport, &script).await {
        Ok(stdout) => match pi::parse_models_json(&stdout) {
            Ok(models) if !models.is_empty() => EngineCatalog::authoritative_remote(models),
            _ => EngineCatalog::authoritative_remote(Vec::new()),
        },
        Err(_) => EngineCatalog::authoritative_remote(Vec::new()),
    }
}

/// Codex 远程目录:`<bin> debug models`(与本机 codex_catalog 同一命令),
/// 失败/为空时回退发行版 `$CODEX_HOME/config.toml` 的 model= 单条。
pub(super) async fn codex_catalog_remote(transport: &WslTransport) -> EngineCatalog {
    let (Some(bin), Some(cwd)) = (bin_for(transport, "codex"), remote_cwd(transport)) else {
        return EngineCatalog::authoritative_remote(Vec::new());
    };
    let script = format!("cd {cwd} 2>/dev/null; {bin} debug models 2>/dev/null");
    if let Ok(stdout) = crate::engine::wsl_transport::run_script_output(transport, &script).await {
        if let Ok(models) = super::codex::parse_codex_models_json(&stdout) {
            if !models.is_empty() {
                return EngineCatalog::authoritative_remote(super::with_default_first(
                    models,
                    codex_config_model_remote(transport).await,
                ));
            }
        }
    }
    EngineCatalog::authoritative_remote(
        codex_config_model_remote(transport)
            .await
            .into_iter()
            .collect(),
    )
}

/// Kimi 远程目录:`<bin> provider list --json`(与本机同命令)。
pub(super) async fn kimi_catalog_remote(transport: &WslTransport) -> EngineCatalog {
    let (Some(bin), Some(cwd)) = (bin_for(transport, "kimi"), remote_cwd(transport)) else {
        return EngineCatalog::authoritative_remote(Vec::new());
    };
    let script = format!("cd {cwd} 2>/dev/null; {bin} provider list --json 2>/dev/null");
    let default = kimi_config_model_remote(transport).await;
    if let Ok(stdout) = crate::engine::wsl_transport::run_script_output(transport, &script).await {
        let models = super::kimi::parse_kimi_provider_list(&stdout);
        if !models.is_empty() {
            // 与本机 kimi_catalog 同语义:配置默认置顶(pick 重置以首项为
            // "CLI 实际默认",字母序兜底会重置到任意条目)。
            return EngineCatalog::authoritative_remote(super::with_default_first(models, default));
        }
    }
    EngineCatalog::authoritative_remote(default.into_iter().collect())
}

/// 发行版内 `$KIMI_CODE_HOME/config.toml`(默认 ~/.kimi-code)的顶层
/// `default_model = "…"`:provider list 失败时唯一可跑的条目。
async fn kimi_config_model_remote(transport: &WslTransport) -> Option<EngineModel> {
    let script = r#"cat "${KIMI_CODE_HOME:-$HOME/.kimi-code}/config.toml" 2>/dev/null"#;
    let content = crate::engine::wsl_transport::run_script_output(transport, script)
        .await
        .ok()?;
    let model = super::parse_top_level_toml_string(&content, "default_model")?;
    Some(EngineModel {
        id: model,
        name: None,
        description: None,
        provider: "kimi".to_string(),
        context_window: None,
    })
}

/// Claude 远程目录:CLI 别名是内置常量,逐字段合并发行版
/// `$CLAUDE_CONFIG_DIR` 的 settings.json / settings.local.json(与本机
/// read_cli_config_from 同一合并语义),复现 distro 自己的 /model 菜单。
pub(super) async fn claude_catalog_remote(transport: &WslTransport) -> EngineCatalog {
    // 随机分隔符:固定串可能出现在 settings 内容里(env 值等),split_once
    // 取首次出现会把 user settings 后半截当 local 合并,优先级错乱。
    let sep = format!("=CCGUI_SEP_{}=", uuid::Uuid::new_v4().simple());
    let script = format!(
        r#"d="${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}"; cat "$d/settings.json" 2>/dev/null; echo "{sep}"; cat "$d/settings.local.json" 2>/dev/null"#
    );
    let out = crate::engine::wsl_transport::run_script_output(transport, &script)
        .await
        .unwrap_or_default();
    let (user, local) = match out.split_once(&sep) {
        Some((u, l)) => (u, l),
        None => (out.as_str(), ""),
    };
    EngineCatalog::authoritative_remote(super::claude::claude_models_remote(user, local))
}
fn bin_for(transport: &WslTransport, engine: &str) -> Option<String> {
    transport
        .engine_paths
        .get(engine)
        .map(|b| shell_safe_bin(b))
        .filter(|b| !b.is_empty())
}

/// 发行版内 `$CODEX_HOME/config.toml`(默认 ~/.codex)的顶层 model=。
async fn codex_config_model_remote(transport: &WslTransport) -> Option<EngineModel> {
    let script = r#"cat "${CODEX_HOME:-$HOME/.codex}/config.toml" 2>/dev/null"#;
    let content = crate::engine::wsl_transport::run_script_output(transport, script)
        .await
        .ok()?;
    let model = super::parse_top_level_toml_string(&content, "model")?;
    Some(EngineModel {
        id: model,
        name: None,
        description: None,
        provider: "codex".to_string(),
        context_window: None,
    })
}

/// 发行版内 `cd` 目标;workspace 字符白名单与 send 路径 build_script 同一
/// 规则(is_safe_workspace),违例返回 None —— 调用方给空 catalog,绝不
/// 拿违例路径发脚本(此前 catalog 路径绕过白名单直排,是注入面)。
fn remote_cwd(transport: &WslTransport) -> Option<String> {
    match &transport.workspace {
        Some(ws) => crate::engine::wsl_transport::is_safe_workspace(ws).then(|| ws.clone()),
        None => Some("~".to_string()),
    }
}

/// 探针写入的路径来自 `command -v` 输出(发行版内绝对路径),再过一遍
/// 白名单防御:仅 `[A-Za-z0-9_./~-]`,违例返回空串让命令失败而非注入。
fn shell_safe_bin(bin: &str) -> String {
    if bin.is_empty()
        || bin
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-' | '~')))
    {
        return String::new();
    }
    bin.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bin_allowlist_rejects_injection() {
        assert_eq!(
            shell_safe_bin("/home/u/.local/bin/omp"),
            "/home/u/.local/bin/omp"
        );
        assert_eq!(shell_safe_bin("/x; rm -rf /"), "");
        assert_eq!(shell_safe_bin("/a b/c"), "");
        assert_eq!(shell_safe_bin(""), "");
    }

    fn tp(workspace: Option<&str>) -> WslTransport {
        WslTransport {
            host: "10.0.0.2".into(),
            port: 22,
            user: "dev".into(),
            distro: "Ubuntu".into(),
            control_path: None,
            engine_paths: Default::default(),
            workspace: workspace.map(str::to_string),
        }
    }

    #[test]
    fn remote_cwd_rejects_injection_shaped_workspace() {
        // catalog 脚本直排 `cd <cwd>`,违例 workspace 必须拿不到 cwd
        // (空 catalog),而不是拼进脚本(catalog 路径曾与 build_script
        // 白名单脱节,是注入面)。
        assert_eq!(
            remote_cwd(&tp(Some("/home/dev/proj"))).as_deref(),
            Some("/home/dev/proj")
        );
        assert_eq!(remote_cwd(&tp(None)).as_deref(), Some("~"));
        assert!(remote_cwd(&tp(Some("/home/dev/my proj"))).is_none());
        assert!(remote_cwd(&tp(Some("/x;id"))).is_none());
        assert!(remote_cwd(&tp(Some("/x$(id)"))).is_none());
    }
}
