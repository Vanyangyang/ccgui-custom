//! Qoder engine — ACP host-session variant.
//!
//! `qodercli --acp` speaks the Agent Client Protocol (JSON-RPC over stdio)
//! and stays resident across requests, so the engine drives its own
//! transport ([`Engine::drives_own_transport`]): each send spawns one child
//! inside [`super::qoder_session::run_acp_turn`], which owns the handshake
//! (initialize → session/new|resume → set_model? → set_mode bypassPermissions
//! → session/prompt) and projects session/update notifications to engine
//! events.

use std::path::Path;

use super::{BuiltCommand, Engine, SendRequest};

/// Qoder ships two distributions with independent binaries and config dirs
/// (reference qoder_provider_profile.rs): Global (`qodercli`, `~/.qoder`)
/// and CN (`qoderclicn`, `~/.qoder-cn`). Each is a sibling engine id sharing
/// the one ACP driver — the pi/omp family pattern: sessions key off the
/// engine id, so `qoder/<id>` and `qoder-cn/<id>` never collide and no
/// profile-qualified identity is needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QoderDistribution {
    Global,
    Cn,
}

impl QoderDistribution {
    pub(crate) fn engine_id(self) -> &'static str {
        match self {
            Self::Global => "qoder",
            Self::Cn => "qoder-cn",
        }
    }

    /// CLI binary behind the engine id (the `qoder` binary is the IDE
    /// launcher and speaks no ACP).
    pub(crate) fn cli_name(self) -> &'static str {
        match self {
            Self::Global => "qodercli",
            Self::Cn => "qoderclicn",
        }
    }

    /// Default config/session home (the CLI's own default; sessions are
    /// scanned from `<home>/projects`).
    pub(crate) fn default_config_dir_name(self) -> &'static str {
        match self {
            Self::Global => ".qoder",
            Self::Cn => ".qoder-cn",
        }
    }
}

pub struct QoderEngine {
    distribution: QoderDistribution,
}

impl QoderEngine {
    pub(crate) fn new(distribution: QoderDistribution) -> Self {
        Self { distribution }
    }
}

impl Engine for QoderEngine {
    fn id(&self) -> &'static str {
        self.distribution.engine_id()
    }

    fn drives_own_transport(&self) -> bool {
        true
    }

    /// Never invoked on the virtual path (`send_host_stream` branches before
    /// the process spawn); a stub keeps the trait contract honest.
    fn build_command(&self, _req: &SendRequest, _bin: &str) -> Result<BuiltCommand, String> {
        Err("qoder runs as an ACP host session; no child command to build".to_string())
    }

    /// Never invoked on the virtual path: ACP frames are JSON-RPC, parsed by
    /// the turn driver, not line-mapped here.
    fn parse_line(&self, _line: &str, _out: &mut Vec<super::EngineEvent>) {}

    fn supports_images(&self) -> bool {
        // session/prompt carries image content blocks (base64).
        true
    }
    fn supports_effort(&self) -> bool {
        true
    }

    fn supported_permissions(&self) -> &'static [&'static str] {
        // A headless ACP turn cannot honor an approval flow: the driver
        // always sets session/set_mode bypassPermissions (permission
        // requests, if any still arrive, are auto-allowed). Only "bypass"
        // is honest.
        &["bypass"]
    }

    /// Qoder 的人工计划审批(ACP session/set_mode plan + ExitPlanMode 的
    /// request_permission)仅有文档与二进制字符串级证据:国际版 CLI 未
    /// 安装(PATH/npm 均无,按约束不安装),CN 证据来自 QoderWork CN.app
    /// 捆绑的 qoderclicn 1.0.41 与官方文档互证,ACP 报文细节未实机抓取,
    /// 且该捆绑 CLI 的 --help 未列出 --acp/plan 入口(可能门控)。当前
    /// 驱动固定 bypassPermissions——显式 plan 请求必须受控拒绝,而不是
    /// 静默以 bypass 执行(P0 取证 Qoder 节;接入前置条件:可登录实机 +
    /// 确认新旧 CLI 入口)。两发行版各自验证前都是 Unavailable。
    fn plan_approval(&self) -> super::plan_review::PlanApproval {
        super::plan_review::PlanApproval::Unavailable {
            reason: match self.distribution {
                QoderDistribution::Global => "Qoder (international) CLI is not installed on this machine; its ACP plan mode is documented but never verified against a live session. Install/login first — the app will not silently fall back to bypassPermissions",
                QoderDistribution::Cn => "Qoder CN plan approval is evidenced only by the QoderWork-bundled qoderclicn 1.0.41 and docs; its ACP plan messages were never captured on a live session, and the bundled CLI does not advertise --acp. The current driver always sets bypassPermissions, so a plan request would silently degrade",
            },
        }
    }
}

/// File stem of a bin path, lowercased (`/usr/local/bin/qodercli` → `qodercli`).
pub(crate) fn binary_file_stem(bin: &str) -> String {
    Path::new(bin.trim())
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(bin.trim())
        .to_ascii_lowercase()
}

/// The Qoder IDE launcher is also called `qoder` but speaks no ACP; only
/// the CLI (`qodercli`) works as an engine bin.
pub(crate) fn is_qoder_ide_launcher_bin(bin: &str) -> bool {
    binary_file_stem(bin) == "qoder"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distributions_carry_independent_identities() {
        assert_eq!(QoderDistribution::Global.engine_id(), "qoder");
        assert_eq!(QoderDistribution::Cn.engine_id(), "qoder-cn");
        assert_eq!(QoderDistribution::Global.cli_name(), "qodercli");
        assert_eq!(QoderDistribution::Cn.cli_name(), "qoderclicn");
        assert_eq!(
            QoderDistribution::Global.default_config_dir_name(),
            ".qoder"
        );
        assert_eq!(QoderDistribution::Cn.default_config_dir_name(), ".qoder-cn");
    }

    #[test]
    fn ide_launcher_stem_is_rejected() {
        assert!(is_qoder_ide_launcher_bin("/Applications/Qoder.app/qoder"));
        assert!(is_qoder_ide_launcher_bin("qoder"));
        assert!(!is_qoder_ide_launcher_bin("/usr/local/bin/qodercli"));
        assert!(!is_qoder_ide_launcher_bin("qodercli"));
    }
}
