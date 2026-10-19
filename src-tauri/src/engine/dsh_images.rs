//! DSH image attachments: load composer images into `session/prompt` image
//! content parts, and declare image input on hand-declared `llm-pi-ai`
//! routes before the prompt.
//!
//! The host admits images from `resolveModelInfo().inputModalities`, not
//! from whether the upstream endpoint can actually see. Official adapters
//! declare their own modalities; hand-declared `llm-pi-ai` routes fall back
//! to `defaultInput: [text]`, so ccgui writes that one modality claim
//! (`settings/mutate`) before dispatching a prompt with attachments. Wire
//! names verified against the dsh source (`settings/describe`,
//! `settings/mutate(ns, ops, expectedRevision)`,
//! `llm/listConfigurableProviders`, `session/prompt`).

use serde_json::{json, Value};
use std::path::Path;

use crate::dsh_host::HostRpcError;

const PI_AI_NS: &str = "llm-pi-ai";
const TEXT_AND_IMAGE: [&str; 2] = ["text", "image"];

/// One loaded composer attachment, ready for a `session/prompt` image part.
pub(crate) struct DshPromptImage {
    media_type: String,
    data: String,
    name: Option<String>,
}

/// Load composer attachments through the shared image pipeline (data URLs,
/// sandboxed picks, workspace-relative paths; 8MB cap). Any attached-but-
/// unreadable image fails the send instead of being silently dropped —
/// same contract as the other engines.
pub(crate) fn load_prompt_images(
    images: &[String],
    workspace: &Path,
) -> Result<Vec<DshPromptImage>, String> {
    let mut loaded = Vec::new();
    let mut errors = Vec::new();
    for raw in images {
        if raw.trim().is_empty() {
            continue;
        }
        match crate::engine::images::load_image(raw, workspace) {
            Ok((media_type, data)) => loaded.push(DshPromptImage {
                media_type,
                data,
                name: image_name(raw),
            }),
            Err(error) => errors.push(format!("{}: {error}", raw.trim())),
        }
    }
    if !errors.is_empty() {
        return Err(format!(
            "DSH 图片读取失败：{} 张附件中有 {} 张无法读取（{}）",
            images.len(),
            errors.len(),
            errors.join("；")
        ));
    }
    Ok(loaded)
}

/// Display name for a `name` part field; data URLs carry no filename.
fn image_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.starts_with("data:") {
        return None;
    }
    Path::new(trimmed.trim_start_matches("file://"))
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
}

/// `session/prompt` content parts: text first, then one image part per
/// attachment. The host schema is `$strip` + `name?: string` — `name: null`
/// is rejected as an invalid payload, so the key is omitted when no name
/// exists.
pub(crate) fn build_prompt_content(text: &str, images: &[DshPromptImage]) -> Vec<Value> {
    let mut content = vec![json!({ "type": "text", "text": text })];
    for image in images {
        let mut part = json!({
            "type": "image",
            "mediaType": image.media_type,
            "data": image.data,
        });
        if let Some(name) = image
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            part["name"] = json!(name);
        }
        content.push(part);
    }
    content
}

/// The session's effective route for admission: the picker's `provider/model`
/// selector when one was dispatched this turn, else the host's current model
/// (`session/modelCatalog` `default`). `None` means no route is knowable.
pub(crate) async fn current_selection(
    origin: &str,
    requested_model: Option<&str>,
) -> Option<(String, String)> {
    if let Some((provider, model)) = requested_model
        .filter(|model| model.contains('/'))
        .and_then(|model| model.split_once('/'))
    {
        if !provider.is_empty() && !model.is_empty() {
            return Some((provider.to_string(), model.to_string()));
        }
    }
    let catalog = crate::dsh_host::host_call(origin, "session/modelCatalog", json!({}))
        .await
        .ok()?;
    let default = catalog.get("default")?;
    let provider = default.get("provider")?.as_str()?.trim();
    let model = default.get("model")?.as_str()?.trim();
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    Some((provider.to_string(), model.to_string()))
}

#[derive(Debug, PartialEq)]
enum AdmissionPlan {
    /// Nothing to write: an official adapter owns the route, the route is
    /// outside the configurable directory (ccgui cannot know its settings
    /// namespace), or the declaration already covers image input.
    Noop,
    Mutate {
        ops: Vec<Value>,
        expected_revision: u64,
    },
    Reject(String),
}

/// Declare image input for `provider/model` when the route is a writable
/// hand-declared `llm-pi-ai` profile that does not admit images yet. One
/// conflict retry: a concurrent settings write bumps the revision, so the
/// plan is recomputed against a fresh describe.
pub(crate) async fn ensure_image_admission(
    origin: &str,
    provider: &str,
    model: &str,
) -> Result<(), String> {
    let mut retried_conflict = false;
    loop {
        let describe = crate::dsh_host::host_call(origin, "settings/describe", json!({}))
            .await
            .map_err(|error| {
                format!("无法读取 DSH 设置为 {provider}/{model} 声明图片输入：{error}")
            })?;
        let configurable =
            crate::dsh_host::host_call(origin, "llm/listConfigurableProviders", json!({}))
                .await
                .unwrap_or(Value::Null);
        match plan_image_admission(&describe, &configurable, provider, model) {
            AdmissionPlan::Noop => return Ok(()),
            AdmissionPlan::Reject(reason) => return Err(reason),
            AdmissionPlan::Mutate {
                ops,
                expected_revision,
            } => {
                let result = crate::dsh_host::host_call_rpc(
                    origin,
                    "settings/mutate",
                    json!({
                        "ns": PI_AI_NS,
                        "ops": ops,
                        "expectedRevision": expected_revision,
                    }),
                )
                .await;
                match result {
                    Ok(_) => return Ok(()),
                    Err(error) if !retried_conflict && error.code == "settings/conflict" => {
                        retried_conflict = true;
                        continue;
                    }
                    Err(error) => {
                        return Err(format!(
                            "无法为 {provider}/{model} 在 DSH llm-pi-ai 路由上声明图片输入：{}",
                            error.message
                        ));
                    }
                }
            }
        }
    }
}

/// The one prompt refusal admission cannot pre-empt (read-only host, a
/// non-pi-ai adapter, or the upstream itself rejecting the image after the
/// declaration): say so plainly instead of sending every user to hand-edit
/// DSH settings.
pub(crate) fn format_prompt_refusal(error: &HostRpcError) -> String {
    if error.code == "session/attachment-invalid"
        && error.details.get("reason").and_then(Value::as_str)
            == Some("MODEL_DOES_NOT_SUPPORT_IMAGES")
    {
        return format!(
            "{}。ccgui 已为自定义 llm-pi-ai 路由声明图片输入；仍然被拒绝说明 host 设置不可写、该路由不是 llm-pi-ai 适配器，或上游接口本身拒绝了图片。",
            error.message
        );
    }
    error.message.clone()
}

fn plan_image_admission(
    describe: &Value,
    configurable: &Value,
    provider: &str,
    model: &str,
) -> AdmissionPlan {
    let provider = provider.trim();
    let model = model.trim();
    if provider.is_empty() || model.is_empty() {
        return AdmissionPlan::Reject(
            "需要先选定 provider/model，ccgui 才能为 DSH 声明图片输入".to_string(),
        );
    }

    match provider_settings_ns(configurable, provider) {
        // Official adapters (llm-deepseek, …) declare their own modalities.
        Some(ns) if ns != PI_AI_NS => return AdmissionPlan::Noop,
        // Not in the configurable directory: ccgui cannot know which
        // namespace owns the route, so it must not invent a settings write.
        None => return AdmissionPlan::Noop,
        Some(_) => {}
    }

    if describe.get("writable").and_then(Value::as_bool) != Some(true) {
        return AdmissionPlan::Reject(format!(
            "DSH 设置不可写，无法为 `{provider}/{model}` 声明图片输入。请在本机可写的 DSH host 上配置后重试。"
        ));
    }

    let Some(namespace) = find_namespace(describe, PI_AI_NS) else {
        return AdmissionPlan::Reject(format!(
            "DSH 没有 `{PI_AI_NS}` 设置命名空间，无法为 `{provider}/{model}` 声明图片输入。"
        ));
    };

    let value_profile = namespace
        .get("value")
        .and_then(|value| value.get("providers"))
        .and_then(|providers| providers.get(provider));
    let user_profile = namespace
        .get("user")
        .and_then(|value| value.get("providers"))
        .and_then(|providers| providers.get(provider));

    if value_profile.is_none() && user_profile.is_none() {
        return AdmissionPlan::Reject(format!(
            "DSH 的 `{PI_AI_NS}` 中没有 `{provider}` 的配置，ccgui 不会仅为发图而凭空创建路由。请先在 DSH 设置中配置该路由。"
        ));
    }

    if modalities_include_image(value_profile, model) {
        return AdmissionPlan::Noop;
    }

    let Some(expected_revision) = json_u64(namespace.get("revision")) else {
        return AdmissionPlan::Reject(
            "settings/describe 未返回 llm-pi-ai 的 revision，无法安全写入".to_string(),
        );
    };

    // The user layer is the one ccgui writes: pin `input` on the exact model
    // entry when it exists there, otherwise widen the route's `defaultInput`.
    let ops = if let Some(models) = user_models_array(user_profile) {
        if let Some(index) = model_index(models, model) {
            let mut next_models = models.clone();
            next_models[index] = with_image_input(&next_models[index]);
            vec![json!({
                "op": "set",
                "path": ["providers", provider, "models"],
                "value": next_models,
            })]
        } else {
            default_input_op(provider)
        }
    } else {
        default_input_op(provider)
    };

    AdmissionPlan::Mutate {
        ops,
        expected_revision,
    }
}

/// `llm/listConfigurableProviders` value (a bare array) → the settings
/// namespace owning `provider`'s route.
fn provider_settings_ns(configurable: &Value, provider: &str) -> Option<String> {
    configurable
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| entry.get("provider").and_then(Value::as_str) == Some(provider))
        .and_then(|entry| {
            entry
                .get("settingsNs")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn find_namespace<'a>(describe: &'a Value, ns: &str) -> Option<&'a Value> {
    describe
        .get("namespaces")
        .and_then(Value::as_array)?
        .iter()
        .find(|entry| entry.get("ns").and_then(Value::as_str) == Some(ns))
}

fn user_models_array(user_profile: Option<&Value>) -> Option<&Vec<Value>> {
    user_profile
        .and_then(|profile| profile.get("models"))
        .and_then(Value::as_array)
}

fn model_index(models: &[Value], model: &str) -> Option<usize> {
    models
        .iter()
        .position(|entry| entry.get("id").and_then(Value::as_str).map(str::trim) == Some(model))
}

/// Image admitted when the model entry's `input` says so, or — the entry
/// omitting it — the route's `defaultInput` does. An empty `input` array is
/// schemastery's materialized "no answer here", not a refusal.
fn modalities_include_image(value_profile: Option<&Value>, model: &str) -> bool {
    if let Some(entry) = first_model_entry(value_profile, model) {
        if let Some(input) = entry.get("input").and_then(Value::as_array) {
            if !input.is_empty() {
                return input.iter().any(is_image_modality);
            }
        }
    }
    value_profile
        .and_then(|profile| profile.get("defaultInput"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(is_image_modality)
}

fn first_model_entry<'a>(profile: Option<&'a Value>, model: &str) -> Option<&'a Value> {
    profile
        .and_then(|value| value.get("models"))
        .and_then(Value::as_array)?
        .iter()
        .find(|entry| entry.get("id").and_then(Value::as_str).map(str::trim) == Some(model))
}

fn is_image_modality(value: &Value) -> bool {
    value.as_str() == Some("image")
}

fn with_image_input(entry: &Value) -> Value {
    let mut object = entry.as_object().cloned().unwrap_or_default();
    object.insert("input".to_string(), json!(TEXT_AND_IMAGE));
    Value::Object(object)
}

fn default_input_op(provider: &str) -> Vec<Value> {
    vec![json!({
        "op": "set",
        "path": ["providers", provider, "defaultInput"],
        "value": TEXT_AND_IMAGE,
    })]
}

fn json_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn describe(writable: bool, revision: u64, value: Value, user: Option<Value>) -> Value {
        let mut namespace = json!({
            "ns": PI_AI_NS,
            "value": value,
            "revision": revision,
        });
        if let Some(user) = user {
            namespace["user"] = user;
        }
        json!({
            "writable": writable,
            "hasDocument": true,
            "namespaces": [namespace],
        })
    }

    fn configurable(ns: &str) -> Value {
        json!([{
            "provider": "acme",
            "displayName": "Acme",
            "settingsNs": ns,
            "settingsPath": ["providers", "acme"],
        }])
    }

    fn profile_with_model(input: Option<Value>) -> Value {
        let mut model = json!({ "id": "vision-1", "contextWindow": 65536 });
        if let Some(input) = input {
            model["input"] = input;
        }
        json!({ "providers": { "acme": { "models": [model] } } })
    }

    #[test]
    fn noop_when_model_entry_already_declares_image() {
        let plan = plan_image_admission(
            &describe(
                true,
                3,
                profile_with_model(Some(json!(["text", "image"]))),
                None,
            ),
            &configurable(PI_AI_NS),
            "acme",
            "vision-1",
        );
        assert_eq!(plan, AdmissionPlan::Noop);
    }

    #[test]
    fn noop_when_default_input_declares_image() {
        let mut value = profile_with_model(None);
        value["providers"]["acme"]["defaultInput"] = json!(["text", "image"]);
        let plan = plan_image_admission(
            &describe(true, 3, value, None),
            &configurable(PI_AI_NS),
            "acme",
            "vision-1",
        );
        assert_eq!(plan, AdmissionPlan::Noop);
    }

    #[test]
    fn noop_for_official_adapter_namespace() {
        let plan = plan_image_admission(
            &describe(true, 3, profile_with_model(None), None),
            &configurable("llm-deepseek"),
            "acme",
            "vision-1",
        );
        assert_eq!(plan, AdmissionPlan::Noop);
    }

    #[test]
    fn noop_when_route_not_in_configurable_directory() {
        let plan = plan_image_admission(
            &describe(true, 3, profile_with_model(None), None),
            &json!([]),
            "acme",
            "vision-1",
        );
        assert_eq!(plan, AdmissionPlan::Noop);
    }

    #[test]
    fn mutate_pins_input_on_the_user_layer_model_entry() {
        let user = profile_with_model(None);
        let plan = plan_image_admission(
            &describe(true, 7, profile_with_model(None), Some(user)),
            &configurable(PI_AI_NS),
            "acme",
            "vision-1",
        );
        assert_eq!(
            plan,
            AdmissionPlan::Mutate {
                ops: vec![json!({
                    "op": "set",
                    "path": ["providers", "acme", "models"],
                    "value": [{ "id": "vision-1", "contextWindow": 65536, "input": ["text", "image"] }],
                })],
                expected_revision: 7,
            }
        );
    }

    #[test]
    fn mutate_widens_default_input_when_model_not_in_user_layer() {
        // The model exists only in the effective (base) layer: the user
        // layer has the profile but no models array to pin.
        let user = json!({ "providers": { "acme": { "apiKeyEnv": "ACME_KEY" } } });
        let plan = plan_image_admission(
            &describe(true, 4, profile_with_model(None), Some(user)),
            &configurable(PI_AI_NS),
            "acme",
            "vision-1",
        );
        assert_eq!(
            plan,
            AdmissionPlan::Mutate {
                ops: vec![json!({
                    "op": "set",
                    "path": ["providers", "acme", "defaultInput"],
                    "value": ["text", "image"],
                })],
                expected_revision: 4,
            }
        );
    }

    #[test]
    fn reject_when_settings_not_writable() {
        let plan = plan_image_admission(
            &describe(false, 3, profile_with_model(None), None),
            &configurable(PI_AI_NS),
            "acme",
            "vision-1",
        );
        assert!(matches!(plan, AdmissionPlan::Reject(reason) if reason.contains("不可写")));
    }

    #[test]
    fn reject_when_route_has_no_pi_ai_profile() {
        let plan = plan_image_admission(
            &describe(true, 3, json!({ "providers": {} }), None),
            &configurable(PI_AI_NS),
            "acme",
            "vision-1",
        );
        assert!(matches!(plan, AdmissionPlan::Reject(reason) if reason.contains("acme")));
    }

    #[test]
    fn reject_on_empty_selection() {
        let plan = plan_image_admission(
            &describe(true, 3, profile_with_model(None), None),
            &configurable(PI_AI_NS),
            "",
            "vision-1",
        );
        assert!(matches!(plan, AdmissionPlan::Reject(_)));
    }

    #[test]
    fn prompt_content_puts_text_first_and_omits_empty_names() {
        let images = vec![
            DshPromptImage {
                media_type: "image/png".to_string(),
                data: "AQ==".to_string(),
                name: Some("shot.png".to_string()),
            },
            DshPromptImage {
                media_type: "image/jpeg".to_string(),
                data: "Ag==".to_string(),
                name: None,
            },
        ];
        let content = build_prompt_content("看这张图", &images);
        assert_eq!(
            content,
            vec![
                json!({ "type": "text", "text": "看这张图" }),
                json!({ "type": "image", "mediaType": "image/png", "data": "AQ==", "name": "shot.png" }),
                // `name: null` is an invalid payload on the host: omit the key.
                json!({ "type": "image", "mediaType": "image/jpeg", "data": "Ag==" }),
            ]
        );
    }

    #[test]
    fn image_name_only_for_path_refs() {
        assert_eq!(image_name("/tmp/shot.png"), Some("shot.png".to_string()));
        assert_eq!(
            image_name("file:///tmp/shot.jpg"),
            Some("shot.jpg".to_string())
        );
        assert_eq!(image_name("data:image/png;base64,AQ=="), None);
    }

    #[test]
    fn prompt_refusal_explains_the_leftover_model_rejection() {
        let error = HostRpcError {
            code: "session/attachment-invalid".to_string(),
            message: "session/prompt 被拒绝：Model \"grok-4.5\" does not support image input."
                .to_string(),
            details: json!({ "reason": "MODEL_DOES_NOT_SUPPORT_IMAGES" }),
        };
        let mapped = format_prompt_refusal(&error);
        assert!(mapped.contains("grok-4.5"), "unexpected: {mapped}");
        assert!(mapped.contains("llm-pi-ai"), "unexpected: {mapped}");
    }

    #[test]
    fn prompt_refusal_passes_other_errors_through() {
        let error = HostRpcError {
            code: "session/not-found".to_string(),
            message: "session/prompt 被拒绝：会话不存在".to_string(),
            details: Value::Null,
        };
        assert_eq!(format_prompt_refusal(&error), error.message);
    }
}
