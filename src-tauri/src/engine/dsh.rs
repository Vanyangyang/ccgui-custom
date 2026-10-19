//! DeepSeek Harness (dsh) engine — host-session variant.
//!
//! 0.1.2's durable streaming lives on the host (`/api/remote.mux` follow
//! stream with the `assistantStream` opt-in), so the engine drives its own
//! transport ([`Engine::drives_own_transport`]) instead of spawning a child
//! process: the turn runs as a host session (create → prompt → deltas),
//! projected in [`super::dsh_session::run_host_turn`]. The host itself is
//! probed/adopted/spawned by [`crate::dsh_host`].

use super::{BuiltCommand, Engine, SendRequest};

pub struct DshEngine;

impl Engine for DshEngine {
    fn id(&self) -> &'static str {
        "dsh"
    }

    fn drives_own_transport(&self) -> bool {
        true
    }

    /// Never invoked on the virtual path (`send_host_stream` branches before
    /// the process spawn); a stub keeps the trait contract honest.
    fn build_command(&self, _req: &SendRequest, _bin: &str) -> Result<BuiltCommand, String> {
        Err("dsh runs as a host session; no child process to build".to_string())
    }

    /// Never invoked on the virtual path: frames arrive over the mux WS and
    /// are projected directly to engine events.
    fn parse_line(&self, _line: &str, _out: &mut Vec<super::EngineEvent>) {}

    fn supports_images(&self) -> bool {
        // Images go out as `session/prompt` image content parts (base64) —
        // that IS the dsh image transport; `dsh_images` declares the
        // input modality on hand-declared llm-pi-ai routes first.
        true
    }
    fn supports_effort(&self) -> bool {
        true
    }

    /// DSH 的人工计划审批经 commands/execute "/plan" 进入、plan-review
    /// presentation intent 等待（0.1.5-rc.1 源码已证实完整协议，适配器见
    /// dsh_session::park_plan_review / enter_plan_mode）。
    fn plan_approval(&self) -> super::plan_review::PlanApproval {
        super::plan_review::PlanApproval::Typed {
            review_kind: super::plan_review::PlanReviewKind::NativeRequest,
            evidence: "dsh 0.1.5-rc.1 dsh-plan-mode plan-review intent + commands/execute /plan",
            limitations: "host 须组合 plan-mode 插件（运行时探测）；plan 是软行为引导非只读沙箱；host 重启后悬挂评审丢失",
        }
    }

    fn supported_permissions(&self) -> &'static [&'static str] {
        &["auto", "plan"]
    }
}
