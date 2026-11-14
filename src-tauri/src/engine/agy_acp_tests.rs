use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::driver::{
    build_prompt_blocks, effective_display_model, extract_launch, normalize_acp_prompt_usage,
    parse_agy_retry_chunk, parse_config_snapshot, run_acp_turn, split_agy_model_and_effort,
};
use super::AgyAcpState;
use crate::engine::agy::{
    acp_turn_requested, append_host_instructions, AgyEngine,
};
use crate::engine::registry::ChildEntry;
use crate::engine::{Engine, ProcessRegistry, SendRequest, TurnCore};
use crate::event_sink::{Emit, EventSink};

struct CollectingEmitter(StdMutex<Vec<Value>>);

#[path = "agy_acp_cancel_tests.rs"]
mod cancel_tests;

#[path = "agy_acp_live_workflow_tests.rs"]
mod live_workflow_tests;

impl Emit for CollectingEmitter {
    fn emit_json(&self, name: &str, raw_json: &str) {
        if name == crate::event_sink::ENGINE_EVENT_NAME {
            if let Ok(items) = serde_json::from_str::<Vec<Value>>(raw_json) {
                self.0.lock().unwrap().extend(items);
            }
        }
    }
}

fn base_req(workspace: &Path, permission: Option<&str>) -> SendRequest {
    SendRequest {
        claude_ultracode: None,
        host_instructions: None,
        session_id: None,
        workspace: workspace.to_path_buf(),
        prompt: "hello acp".into(),
        images: Vec::new(),
        model: Some("gemini-4-carbon-medium".into()),
        effort: Some("medium".into()),
        service_tier: None,
        permission: permission.map(str::to_string),
        additional_dirs: Vec::new(),
        provider_id: None,
        computer_use: None,
        allowed_tools: None,
    }
}

fn make_turn_core(
    run_id: &str,
    virtual_pid: u32,
) -> (
    TurnCore,
    Arc<ProcessRegistry>,
    Arc<CollectingEmitter>,
    Arc<AtomicBool>,
) {
    let emitter = Arc::new(CollectingEmitter(StdMutex::new(Vec::new())));
    let registry = Arc::new(ProcessRegistry::default());
    let killed = Arc::new(AtomicBool::new(false));
    registry.insert(
        run_id.to_string(),
        ChildEntry {
            child: None,
            pid: virtual_pid,
            run_id: run_id.to_string(),
            killed: Arc::clone(&killed),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: None,
            questions: Arc::new(StdMutex::new(HashMap::new())),
            plans: Arc::new(StdMutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        },
    );
    let core = TurnCore {
        sink: EventSink::new(emitter.clone()),
        registry: Arc::clone(&registry),
        engine_id: "agy".to_string(),
        run_id: run_id.to_string(),
        db: None,
    };
    (core, registry, emitter, killed)
}

#[test]
fn routing_predicate_isolates_personal_subscription_from_vertex_wsl_and_constraints() {
    let ws = Path::new("/tmp/ws");
    let mut personal = base_req(ws, Some("auto"));
    assert!(acp_turn_requested(&personal, false));
    assert!(!acp_turn_requested(&personal, true));

    personal.model = Some("gemini-api://ccgui-vertex/high/models/gemini-4-argon".into());
    assert!(!acp_turn_requested(&personal, false));

    let mut constrained = base_req(ws, Some("auto"));
    constrained.allowed_tools = Some(vec!["Read".into()]);
    assert!(!acp_turn_requested(&constrained, false));
}

#[test]
fn splits_catalog_slug_and_reconstructs_subscription_display_model() {
    let handshake = json!({
        "sessionId": "s-1",
        "configOptions": [
            {
                "id": "mode",
                "currentValue": "default",
                "options": [{"value": "default"}, {"value": "accept-edits"}, {"value": "plan"}]
            },
            {
                "id": "model",
                "currentValue": "gemini-4-argon",
                "options": [
                    {"value": "gemini-4-argon"},
                    {"value": "gemini-4-carbon"},
                    {"value": "gemini-3.8-flash"},
                    {"value": "claude-opus-4-6"}
                ]
            },
            {
                "id": "thought_level",
                "currentValue": "high",
                "options": [{"value": "low"}, {"value": "medium"}, {"value": "high"}]
            }
        ]
    });
    let mut snap = parse_config_snapshot(&handshake);
    assert_eq!(
        split_agy_model_and_effort(Some("gemini-3.8-flash-low"), Some("high"), &snap),
        (Some("gemini-3.8-flash".into()), Some("low".into()))
    );
    assert_eq!(
        split_agy_model_and_effort(Some("claude-opus-4-6"), Some("xhigh"), &snap),
        (Some("claude-opus-4-6".into()), Some("high".into()))
    );
    assert_eq!(
        effective_display_model(&snap, None).as_deref(),
        Some("gemini-4-argon-high")
    );
    snap.current_model = Some("gemini-4-carbon".into());
    snap.current_thought = Some("medium".into());
    assert_eq!(
        effective_display_model(&snap, None).as_deref(),
        Some("gemini-4-carbon-medium")
    );
}

#[test]
fn orchestrator_ignores_stale_acp_thought_and_keeps_exact_display_model() {
    let mut snap = parse_config_snapshot(&json!({
        "configOptions": [{
            "id": "model", "currentValue": "gemini-pro-orchestrator",
            "options": [{"value": "gemini-pro-orchestrator"}]
        }, {
            "id": "thought_level", "currentValue": "high",
            "options": [{"value": "low"}, {"value": "medium"}, {"value": "high"}]
        }]
    }));
    assert_eq!(
        split_agy_model_and_effort(Some("gemini-pro-orchestrator"), Some("high"), &snap),
        (Some("gemini-pro-orchestrator".into()), None)
    );
    assert_eq!(effective_display_model(&snap, None).as_deref(), Some("gemini-pro-orchestrator"));
    snap.model_values.clear();
    snap.current_model = None;
    assert_eq!(
        split_agy_model_and_effort(Some("gemini-pro-orchestrator"), Some("medium"), &snap),
        (Some("gemini-pro-orchestrator".into()), None)
    );
    assert_eq!(effective_display_model(&snap, Some("gemini-pro-orchestrator")).as_deref(), Some("gemini-pro-orchestrator"));
}

#[test]
fn encoded_xhigh_model_takes_precedence_over_independent_effort() {
    let mut snap = parse_config_snapshot(&json!({
        "configOptions": [{
            "id": "model",
            "currentValue": "gemini-4-hydrogen-xhigh",
            "options": [{"value": "gemini-4-hydrogen-xhigh"}]
        }, {
            "id": "thought_level",
            "currentValue": "medium",
            "options": [{"value": "medium"}, {"value": "xhigh"}]
        }]
    }));
    assert_eq!(
        split_agy_model_and_effort(Some("gemini-4-hydrogen-xhigh"), Some("medium"), &snap),
        (Some("gemini-4-hydrogen-xhigh".into()), None)
    );
    assert_eq!(effective_display_model(&snap, None).as_deref(), Some("gemini-4-hydrogen-xhigh"));
    snap.model_values.clear();
    assert_eq!(
        split_agy_model_and_effort(Some("gemini-4-hydrogen-xhigh"), Some("medium"), &snap),
        (Some("gemini-4-hydrogen".into()), Some("xhigh".into()))
    );
}

#[test]
fn independent_xhigh_uses_the_advertised_thinking_levels() {
    let mut snap = parse_config_snapshot(&json!({"configOptions":[
        {"id":"model","currentValue":"gemini-4-hydrogen"},
        {"id":"thought_level","currentValue":"high","options":[{"value":"high"},{"value":"xhigh"}]}
    ]}));
    assert_eq!(split_agy_model_and_effort(Some("gemini-4-hydrogen"), Some("xhigh"), &snap),
        (Some("gemini-4-hydrogen".into()), Some("xhigh".into())));
    snap.thought_values.remove("xhigh");
    assert_eq!(split_agy_model_and_effort(Some("gemini-4-carbon"), Some("xhigh"), &snap),
        (Some("gemini-4-carbon".into()), Some("high".into())));
}

#[test]
fn parses_transient_retry_chunks_and_normalizes_camel_case_usage() {
    assert_eq!(
        parse_agy_retry_chunk(
            "\n⚠ API error (attempt 2): UNAVAILABLE (code 503): No capacity available\n"
        ),
        Some((
            2,
            "UNAVAILABLE (code 503): No capacity available".to_string()
        ))
    );
    assert_eq!(parse_agy_retry_chunk("Normal assistant answer ⚠ ok"), None);

    let usage = normalize_acp_prompt_usage(&json!({
        "stopReason": "end_turn",
        "usage": {
            "inputTokens": 3004,
            "outputTokens": 835,
            "cachedReadTokens": 9658,
            "cachedWriteTokens": 0,
            "thoughtTokens": 811,
            "totalTokens": 13497
        }
    }))
    .unwrap();
    assert_eq!(usage["usage_scope"], "turn");
    assert_eq!(usage["input_tokens"], 3004);
    assert_eq!(usage["output_tokens"], 835);
    assert_eq!(usage["cached_input_tokens"], 9658);
    assert_eq!(usage["cache_read_input_tokens"], 9658);
    assert_eq!(usage["thinking_tokens"], 811);
    assert_eq!(usage["reasoning_output_tokens"], 811);
    assert_eq!(usage["total_tokens"], 13497);
}

#[test]
fn multimodal_prompt_blocks_embed_base64_without_read_file_text_pollution() {
    let dir = std::env::temp_dir().join(format!("ccgui-agy-acp-img-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    // Minimal 1x1 transparent PNG
    let png_bytes: [u8; 67] = [
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let img_path = dir.join("shot.png");
    std::fs::write(&img_path, png_bytes).unwrap();

    let blocks = build_prompt_blocks(
        "请看这张截图",
        &[img_path.to_string_lossy().into_owned()],
        &dir,
        false,
    )
    .unwrap();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0], json!({ "type": "text", "text": "请看这张截图" }));
    assert_eq!(blocks[1]["type"], "image");
    assert_eq!(blocks[1]["mimeType"], "image/png");
    assert!(!blocks[1]["data"].as_str().unwrap().is_empty());

    let compact_blocks = build_prompt_blocks("/compact keep notes", &[], &dir, true).unwrap();
    assert_eq!(
        compact_blocks,
        vec![json!({ "type": "text", "text": "/compact" })]
    );

    let _ = std::fs::remove_dir_all(&dir);
}

fn find_node_exe() -> Option<PathBuf> {
    let win = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
    if win.is_file() {
        return Some(win);
    }
    which::which("node").ok()
}

struct FakeAcpFixture {
    root: PathBuf,
    bin_path: PathBuf,
    spawns_log: PathBuf,
}

impl FakeAcpFixture {
    fn new() -> Option<Self> {
        Self::with_behavior(json!({}))
    }

    fn with_behavior(behavior: Value) -> Option<Self> {
        let node = find_node_exe()?;
        let root =
            std::env::temp_dir().join(format!("ccgui-fake-agy-acp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("ws")).unwrap();
        std::fs::write(root.join("behavior.json"), behavior.to_string()).unwrap();
        let spawns_log = root.join("spawns.log");
        let server_js = root.join("fake-acp.mjs");
        std::fs::write(
            &server_js,
            r#"
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fixtureRoot = path.dirname(process.env.FAKE_SPAWNS_LOG);
const behavior = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'behavior.json'), 'utf8'));

if (process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== 'true') {
  process.exit(9);
}
fs.appendFileSync(process.env.FAKE_SPAWNS_LOG, `${process.pid}\n`);

let currentModel = behavior.initialModel || 'gemini-4-argon';
let currentThought = 'high';
let currentMode = 'default';
let cachedTokenFile = null;
let cachedPluginRoot = null;
let cancelTimer = null;
let pendingPromptId = null;
let activeSession = 'sid-warm-1';

function configOptions() {
  const modelOptions = ['gemini-4-argon', 'gemini-4-carbon', 'gemini-3.8-flash'];
  for (const extra of behavior.extraModels || []) {
    if (!modelOptions.includes(extra)) modelOptions.push(extra);
  }
  const thoughtless = Array.isArray(behavior.modelsWithoutThought)
    && behavior.modelsWithoutThought.includes(currentModel);
  const options = [
    { id: 'mode', currentValue: currentMode, options: [{ value: 'default' }, { value: 'accept-edits' }, { value: 'plan' }] },
    { id: 'model', currentValue: currentModel, options: modelOptions.map(value => ({ value })) },
  ];
  if (!thoughtless) {
    options.push({ id: 'thought_level', currentValue: currentThought, options: (behavior.thoughtValuesByModel?.[currentModel] || behavior.thoughtValues || ['low', 'medium', 'high']).map(value => ({value})) });
  }
  return options;
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function contextUpdates(stage, sid = activeSession) {
  for (const update of behavior.contextUpdates?.[stage] || []) {
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:update.sessionId || sid,update:{sessionUpdate:'usage_update',...update}}});
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method) fs.appendFileSync(path.join(fixtureRoot, 'requests.jsonl'), JSON.stringify({method:msg.method, params:msg.params}) + '\n');
  if (msg.method === 'initialize') {
    if (behavior.initializeGate) {
      while (!fs.existsSync(path.join(fixtureRoot, 'initialize.release'))) await new Promise(resolve => setTimeout(resolve, 20));
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, ...(behavior.resume ? {sessionCapabilities:{resume:{}}} : {}) } } });
    return;
  }
  if (msg.method === 'session/new') {
    activeSession = 'sid-warm-1';
    if (!cachedTokenFile && msg.params?.mcpServers?.[0]?.env?.[0]?.value) {
      // Simulate language_server caching the MCP process env from first session!
      cachedTokenFile = msg.params.mcpServers[0].env[0].value;
    }
    cachedPluginRoot = msg.params?.additionalDirectories?.[0] || cachedPluginRoot;
    contextUpdates('attach');
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sid-warm-1', configOptions: configOptions() } });
    return;
  }
  if (msg.method === 'session/load' || msg.method === 'session/resume') {
    if (msg.method === 'session/resume' && behavior.resume === 'unsupported') {
      send({jsonrpc:'2.0', id:msg.id, error:{code:-32601, message:'Method not found'}}); return;
    }
    if (behavior.restoreError) {
      send({jsonrpc:'2.0', id:msg.id, error:{code:behavior.restoreError, message:'Restore rejected'}}); return;
    }
    cachedPluginRoot = msg.params?.additionalDirectories?.[0] || cachedPluginRoot;
    activeSession = msg.params.sessionId;
    contextUpdates('attach');
    // Emit prior-turn replay chunk BEFORE responding to session/load!
    if (msg.method === 'session/load') send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE_HISTORY_REPLAY' } } },
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId, configOptions: configOptions() } });
    return;
  }
  if (msg.method === 'session/set_config_option') {
    if (msg.params.configId === behavior.rejectConfig) {
      send({jsonrpc:'2.0',id:msg.id,error:{code:-32602,message:'Configuration refused'}}); return;
    }
    if (msg.params.configId === 'thought_level'
      && Array.isArray(behavior.modelsWithoutThought)
      && behavior.modelsWithoutThought.includes(currentModel)) {
      send({jsonrpc:'2.0',id:msg.id,error:{code:-32602,message:`Thinking level "${msg.params.value}" is not offered for model "${currentModel}"`}}); return;
    }
    if (msg.params.configId === 'mode') currentMode = msg.params.value;
    if (msg.params.configId === 'model') currentModel = msg.params.value;
    if (msg.params.configId === 'model' && behavior.resetThoughtOnModel) {
      currentThought = 'low';
      send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'sid-warm-1',update:{sessionUpdate:'config_option_update',configOptions:configOptions().filter(option => option.id === 'thought_level')}}});
    }
    if (msg.params.configId === 'model' && behavior.resetModeOnModel) {
      currentMode = 'default';
      send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'sid-warm-1',update:{sessionUpdate:'current_mode_update',currentModeId:currentMode}}});
    }
    if (msg.params.configId === 'thought_level' && !behavior.wrongThoughtConfirmation) currentThought = msg.params.value;
    if (behavior.notificationConfirmation) {
      send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'sid-warm-1',update:{sessionUpdate:'config_option_update',configOptions:configOptions()}}});
    }
    contextUpdates(msg.params.configId);
    send({ jsonrpc: '2.0', id: msg.id, result: behavior.emptyConfirmation || behavior.notificationConfirmation ? {} : { configOptions: behavior.partialConfig ? configOptions().filter(option => option.id === msg.params.configId) : configOptions() } });
    if (behavior.trailingConfigNotifications) {
      if (msg.params.configId === 'mode') {
        send({jsonrpc:'2.0',method:'session/update',params:{sessionId:activeSession,update:{sessionUpdate:'current_mode_update',currentModeId:currentMode}}});
      }
      send({jsonrpc:'2.0',method:'session/update',params:{sessionId:activeSession,update:{sessionUpdate:'config_option_update',configOptions:configOptions()}}});
    }
    return;
  }
  if (msg.method === 'session/close') {
    if (behavior.closeError) {send({jsonrpc:'2.0',id:msg.id,error:{code:-32603,message:'Close failed'}});return;}
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/cancel') {
    if (cancelTimer) { clearTimeout(cancelTimer); cancelTimer = null; }
    if (pendingPromptId !== null) {
      const id = pendingPromptId;
      pendingPromptId = null;
      send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
    }
    return;
  }
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    const text = msg.params?.prompt?.[0]?.text || '';
    contextUpdates('prompt', sid);
    if (behavior.errorDb) {
      fs.writeSync(2, 'raw-provider-secret-never-publish\n');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(behavior.errorDb);
      db.prepare('INSERT INTO steps(idx,step_type,step_payload) VALUES(0,17,?)').run(Buffer.from('API error (attempt 1): unexpected EOF fake-secret-never-publish'));
      db.close();
      send({jsonrpc:'2.0',id:msg.id,result:{stopReason:'end_turn'}});return;
    }
    if (behavior.refusal) {send({jsonrpc:'2.0',id:msg.id,result:{stopReason:'refusal'}});return;}
    if (text === 'CRASH_NOW') {
      process.exit(1);
    }
    if (text === 'HANG_FOR_CANCEL') {
      if (behavior.cancelChild) {
        const beat = path.join(fixtureRoot, 'descendant-heartbeat');
        require('node:child_process').spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(beat + '.pid')},String(process.pid));setInterval(()=>require('fs').appendFileSync(${JSON.stringify(beat)},'.'),20)`], {stdio:'ignore',windowsHide:true});
      }
      pendingPromptId = msg.id;
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial-before-cancel' } } },
      });
      cancelTimer = setTimeout(() => {}, 30000);
      return;
    }
    if (text === 'HANDOFF_STREAM') {
      send({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'开始🙂\n'}}}});
      while (!fs.existsSync(path.join(fixtureRoot, 'prompt.release'))) await new Promise(resolve => setTimeout(resolve, 20));
      send({jsonrpc:'2.0',method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'完成🧪\n'}}}});
      send({jsonrpc:'2.0',id:msg.id,result:{stopReason:'end_turn'}});
      return;
    }
    if (text === 'ASK_PERM') {
      pendingPromptId = msg.id;
      send({
        jsonrpc: '2.0',
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          sessionId: sid,
          toolCall: { title: 'RunCommand' },
          options: [
            { optionId: 'allow_always', kind: 'allow_always' },
            { optionId: 'allow_once', kind: 'allow_once' },
            { optionId: 'reject_once', kind: 'reject_once' },
          ],
        },
      });
      return;
    }
    const rulesFile = cachedPluginRoot ? path.join(cachedPluginRoot, '.agents/plugins/ccgui-host/rules/AGENTS.md') : '';
    const rules = (rulesFile && fs.existsSync(rulesFile)) ? fs.readFileSync(rulesFile, 'utf8') : 'NO_RULES';
    const tokJson = (cachedTokenFile && fs.existsSync(cachedTokenFile)) ? JSON.parse(fs.readFileSync(cachedTokenFile, 'utf8')).token : 'NO_TOKEN';
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } } },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n⚠ API error (attempt 1): 503 busy\n' } } },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'read_file', status: 'in_progress', rawInput: { path: 'a.rs' } } },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: 'ok' } },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `PID=${process.pid}|SID=${sid}|CWD=${process.cwd()}|MODEL=${currentModel}-${currentThought}|MODE=${currentMode}|TOK=${tokJson}|RULES=${rules}` },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        stopReason: 'end_turn',
        ...(behavior.omitPromptUsage ? {} : {usage: { inputTokens: 100, outputTokens: 25, cachedReadTokens: 40, thoughtTokens: 5, totalTokens: 165 }}),
      },
    });
    return;
  }
  if (msg.id === 'perm-1' && pendingPromptId !== null) {
    const id = pendingPromptId;
    pendingPromptId = null;
    const chosen = msg.result?.outcome?.optionId || msg.result?.outcome?.outcome || 'none';
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'sid-warm-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `PERM_CHOICE=${chosen}` } } },
    });
    send({
      jsonrpc: '2.0',
      id,
      result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, totalTokens: 15 } },
    });
  }
});
"#,
        )
        .unwrap();

        #[cfg(windows)]
        let bin_path = {
            let cmd = root.join("fake-agy.cmd");
            std::fs::write(
                &cmd,
                format!(
                    "@echo off\r\nset \"FAKE_SPAWNS_LOG={}\"\r\n\"{}\" \"{}\" %*\r\n",
                    spawns_log.display(),
                    node.display(),
                    server_js.display()
                ),
            )
            .unwrap();
            cmd
        };
        #[cfg(not(windows))]
        let bin_path = {
            use std::os::unix::fs::PermissionsExt;
            let sh = root.join("fake-agy.sh");
            std::fs::write(
                &sh,
                format!(
                    "#!/bin/sh\nexport FAKE_SPAWNS_LOG=\"{}\"\nexec \"{}\" \"{}\" \"$@\"\n",
                    spawns_log.display(),
                    node.display(),
                    server_js.display()
                ),
            )
            .unwrap();
            let mut perms = std::fs::metadata(&sh).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&sh, perms).unwrap();
            sh
        };

        Some(Self {
            root,
            bin_path,
            spawns_log,
        })
    }

    fn spawn_pids(&self) -> Vec<String> {
        std::fs::read_to_string(&self.spawns_log)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect()
    }

    fn requests(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.join("requests.jsonl")).unwrap_or_default()
            .lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }
}

impl Drop for FakeAcpFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[path = "agy_acp_service_tests.rs"]
mod service_tests;

async fn run_optimization_fixture(
    fixture: &FakeAcpFixture,
    service: &Arc<AgyAcpState>,
    req: SendRequest,
    app_home: Option<&Path>,
) -> Vec<Value> {
    let bin = fixture.bin_path.to_string_lossy().to_string();
    let mut built = AgyEngine::new().build_command(&req, &bin).unwrap();
    if let Some(home) = app_home {
        built.command.env("ANTIGRAVITY_APP_DATA_DIR", home);
    }
    let (core, _, emitter, killed) = make_turn_core("optimization-turn", 4_000_001_999);
    run_acp_turn(core, req, bin, built, Arc::clone(service), killed, 4_000_001_999).await;
    let events = emitter.0.lock().unwrap().clone();
    events
}

#[tokio::test]
async fn official_context_updates_survive_attach_configuration_prompt_and_done() {
    for restore in [None, Some("supported"), Some("legacy")] {
        let mut behavior = json!({"contextUpdates":{
            "attach":[{"used":0,"size":1048576},{"sessionId":"unrelated","used":999,"size":999}],
            "model":[{"used":200,"size":2000000}],
            "thought_level":[{"used":210,"size":2000000}],
            "prompt":[{"used":240,"size":2000000},{"used":60,"size":2000000},{"used":null,"size":2000000},{"sessionId":"unrelated","used":999,"size":999}]
        }});
        if restore == Some("supported") { behavior["resume"] = json!("supported"); }
        let fixture = FakeAcpFixture::with_behavior(behavior).expect("node fixture");
        let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
        let mut req = base_req(&fixture.root.join("ws"), Some("auto"));
        if restore.is_some() { req.session_id = Some("sid-existing".into()); }
        let events = run_optimization_fixture(&fixture, &service, req, None).await;
        assert!(!events.iter().any(|event| event["kind"] == "error"), "{events:?}");
        let snapshots: Vec<_> = events.iter().filter(|e| e["kind"] == "usage")
            .map(|e| e["data"]["context_usage"]["input_tokens"].as_u64().unwrap()).collect();
        assert_eq!(snapshots, vec![0, 200, 210, 240, 60, 60], "{events:?}");
        let final_usage = &events.iter().find(|e| e["kind"] == "done").unwrap()["data"]["usage"];
        assert_eq!(final_usage["context_usage_source"], "acp_usage_update");
        assert_eq!(final_usage["context_usage"]["input_tokens"], 60);
        assert_eq!(final_usage["model_context_window"], 2000000);
        assert_eq!(final_usage["input_tokens"], 100);
        assert_eq!(final_usage["cache_read_input_tokens"], 40);
        assert!(!events.iter().any(|e| e.to_string().contains("STALE_HISTORY_REPLAY")));
        service.kill_spawned();
    }
}

#[tokio::test]
async fn official_zero_context_without_turn_usage_is_retained_at_completion_and_error() {
    for refusal in [false, true] {
        let fixture = FakeAcpFixture::with_behavior(json!({"refusal":refusal,"omitPromptUsage":true,"contextUpdates":{"attach":[{"used":0,"size":1048576}]}})).expect("node fixture");
        let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
        let req = base_req(&fixture.root.join("ws"), Some("auto"));
        let events = run_optimization_fixture(&fixture, &service, req, None).await;
        let usage = &events.iter().rev().find(|e| e["kind"] == "usage").unwrap()["data"];
        assert_eq!(usage["context_usage"]["input_tokens"], 0);
        assert_eq!(usage["model_context_window"], 1048576);
        assert!(usage.get("input_tokens").is_none());
        assert_eq!(events.iter().any(|e| e["kind"] == "error"), refusal);
        assert_eq!(events.iter().any(|e| e["kind"] == "done"), !refusal);
        service.kill_spawned();
    }
}

#[tokio::test]
async fn independent_thinking_uses_capabilities_after_switching_models() {
    for (initial, target, expected) in [
        ("gemini-4-carbon", "gemini-4-hydrogen", "xhigh"),
        ("gemini-4-hydrogen", "gemini-4-hydrogen", "xhigh"),
        ("gemini-4-hydrogen", "gemini-4-carbon", "high"),
    ] {
        let fixture = FakeAcpFixture::with_behavior(json!({"initialModel":initial,"thoughtValuesByModel":{"gemini-4-hydrogen":["low","medium","high","xhigh"],"gemini-4-carbon":["low","medium","high"]}})).expect("node fixture");
        let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
        let mut req = base_req(&fixture.root.join("ws"), Some("auto"));
        req.model = Some(target.into());
        req.effort = Some("xhigh".into());
        let events = run_optimization_fixture(&fixture, &service, req, None).await;
        assert!(!events.iter().any(|e| e["kind"] == "error"), "{events:?}");
        assert!(events.iter().any(|e| e["kind"] == "model" && e["data"] == format!("{target}-{expected}")), "{events:?}");
        assert!(!fixture.requests().iter().any(|r| r["params"]["configId"] == "thought_level" && r["params"]["value"] != expected));
        service.kill_spawned();
    }
}

#[tokio::test]
async fn restore_uses_advertised_resume_with_one_explicit_legacy_fallback() {
    for behavior in [json!({}), json!({"resume":"supported"}), json!({"resume":"unsupported"})] {
        let fixture = FakeAcpFixture::with_behavior(behavior.clone()).expect("node fixture");
        let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
        let mut req = base_req(&fixture.root.join("ws"), Some("auto"));
        req.session_id = Some("sid-existing".into());
        let events = run_optimization_fixture(&fixture, &service, req, None).await;
        assert!(!events.iter().any(|event| event["kind"] == "error"), "{events:?}");
        let methods: Vec<_> = fixture.requests().iter().filter_map(|r| r["method"].as_str().map(str::to_owned)).collect();
        assert!(!methods.iter().any(|method| method == "session/new"));
        assert_eq!(methods.iter().filter(|method| method.as_str() == "session/prompt").count(), 1);
        assert_eq!(methods.iter().filter(|method| method.as_str() == "session/resume").count(), usize::from(behavior.get("resume").is_some()));
        assert_eq!(methods.iter().filter(|method| method.as_str() == "session/load").count(), usize::from(behavior["resume"] != "supported"));
        assert_eq!(methods.iter().filter(|method| method.as_str() == "session/close").count(), 1);
        service.kill_spawned();
    }
}

#[tokio::test]
async fn failed_restore_never_replaces_conversation_or_sends_prompt() {
    for resume in [false, true] {
        let behavior = if resume { json!({"resume":"supported", "restoreError":-32000}) } else { json!({"restoreError":-32000}) };
        let fixture = FakeAcpFixture::with_behavior(behavior).expect("node fixture");
        let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
        let mut req = base_req(&fixture.root.join("ws"), Some("auto"));
        req.session_id = Some("sid-existing".into());
        let events = run_optimization_fixture(&fixture, &service, req, None).await;
        assert!(events.iter().any(|event| event["kind"] == "error"));
        assert!(!events.iter().any(|event| event["kind"] == "done"));
        assert!(!fixture.requests().iter().any(|r| r["method"] == "session/new" || r["method"] == "session/prompt"));
        assert_eq!(service.inner.lock().unwrap().idle.len(), 0);
        service.kill_spawned();
    }
}

#[tokio::test]
async fn unconfirmed_configuration_fails_before_prompt() {
    for behavior in [
        json!({"rejectConfig":"thought_level"}),
        json!({"wrongThoughtConfirmation":true}),
        json!({"thoughtValues":["high"]}),
        json!({"emptyConfirmation":true}),
        json!({"rejectConfig":"mode"}),
    ] {
        let fixture = FakeAcpFixture::with_behavior(behavior).expect("node fixture");
        let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
        let mut req = base_req(&fixture.root.join("ws"), Some("auto"));
        req.model = Some("gemini-4-argon-low".into());
        let events = run_optimization_fixture(&fixture, &service, req, None).await;
        assert!(events.iter().any(|event| event["kind"] == "error"), "{events:?}");
        assert!(!events.iter().any(|event| event["kind"] == "done"));
        assert!(!fixture.requests().iter().any(|r| r["method"] == "session/prompt"));
        assert!(fixture.requests().iter().any(|r| r["method"] == "session/close"));
        service.kill_spawned();
    }
}

#[test]
fn partial_configuration_reply_retains_other_confirmed_values() {
    let mut snapshot = parse_config_snapshot(&json!({"configOptions":[
        {"id":"mode","currentValue":"accept-edits","options":[{"value":"default"},{"value":"accept-edits"},{"value":"plan"}]},
        {"id":"model","currentValue":"gemini-4-argon","options":[{"value":"gemini-4-argon"},{"value":"gemini-pro-orchestrator"}]},
        {"id":"thought_level","currentValue":"high","options":[{"value":"low"},{"value":"high"}]}
    ]}));
    assert!(snapshot.has_full_config_options);
    snapshot.merge_from(&json!({"configOptions":[{"id":"thought_level","currentValue":"low","options":[{"value":"low"},{"value":"high"}]}]}));
    assert_eq!(snapshot.current_model.as_deref(), Some("gemini-4-argon"));
    assert_eq!(snapshot.current_mode.as_deref(), Some("accept-edits"));
    assert_eq!(snapshot.current_thought.as_deref(), Some("low"));

    snapshot.merge_from(&json!({"modes":{"currentModeId":"plan"}}));
    assert_eq!(snapshot.current_mode.as_deref(), Some("plan"));
    assert!(snapshot.mode_values.contains("accept-edits"));
    assert!(snapshot.mode_values.contains("plan"));
    assert!(snapshot.has_thought_option);

    snapshot.merge_from(&json!({"configOptions":[
        {"id":"mode","currentValue":"plan","options":[{"value":"default"},{"value":"accept-edits"},{"value":"plan"}]},
        {"id":"model","currentValue":"gemini-pro-orchestrator","options":[{"value":"gemini-4-argon"},{"value":"gemini-pro-orchestrator"}]}
    ]}));
    assert_eq!(snapshot.current_model.as_deref(), Some("gemini-pro-orchestrator"));
    assert!(!snapshot.has_thought_option);
    assert_eq!(snapshot.current_thought, None);
    assert!(snapshot.thought_values.is_empty());

    let mut partial_only = parse_config_snapshot(&json!({"configOptions": []}));
    assert!(!partial_only.has_full_config_options);
    partial_only.merge_from(&json!({"configOptions":[{"id":"mode","currentValue":"accept-edits"}]}));
    partial_only.merge_from(&json!({"configOptions":[{"id":"model","currentValue":"gemini-4-carbon"}]}));
    assert!(!partial_only.has_full_config_options);
    assert!(!partial_only.has_thought_option);
}

#[tokio::test]
async fn first_new_session_turn_survives_trailing_config_notifications_and_thoughtless_models() {
    let behavior = json!({
        "trailingConfigNotifications": true,
        "extraModels": [
            "gemini-pro-orchestrator",
            "gemini-pro-orchestrator-argon",
            "custom-no-thought"
        ],
        "modelsWithoutThought": [
            "gemini-pro-orchestrator",
            "gemini-pro-orchestrator-argon",
            "custom-no-thought"
        ]
    });
    for (permission, model, expects_thought) in [
        ("bypass", "gemini-pro-orchestrator", false),
        ("bypass", "gemini-pro-orchestrator-argon", false),
        ("auto", "custom-no-thought", false),
        ("bypass", "gemini-4-carbon-low", true),
    ] {
        let fixture = FakeAcpFixture::with_behavior(behavior.clone()).expect("node fixture");
        let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
        let mut req = base_req(&fixture.root.join("ws"), Some(permission));
        req.session_id = None;
        req.model = Some(model.into());
        req.effort = Some("high".into());
        let events = run_optimization_fixture(&fixture, &service, req, None).await;
        let requests = fixture.requests();

        assert!(!events.iter().any(|event| event["kind"] == "error"), "case ({permission}, {model}): {events:?}");
        assert!(events.iter().any(|event| event["kind"] == "done"), "case ({permission}, {model}): {events:?}");
        assert_eq!(
            requests.iter().filter(|r| r["method"] == "session/prompt").count(),
            1,
            "case ({permission}, {model}): {requests:?}"
        );
        assert!(events.iter().any(|event| event["kind"] == "model" && event["data"] == model), "case ({permission}, {model}): {events:?}");
        if expects_thought {
            assert!(requests.iter().any(|r| r["method"] == "session/set_config_option" && r["params"]["configId"] == "thought_level" && r["params"]["value"] == "low"));
        } else {
            assert!(!requests.iter().any(|r| r["method"] == "session/set_config_option" && r["params"]["configId"] == "thought_level"));
            assert!(!events.iter().any(|event| event["kind"] == "effort"), "case ({permission}, {model}): {events:?}");
        }
        service.kill_spawned();
    }
}

#[tokio::test]
async fn failed_close_evicts_worker_instead_of_reusing_its_unclosed_session() {
    let fixture = FakeAcpFixture::with_behavior(json!({"closeError":true})).expect("node fixture");
    let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    for _ in 0..2 {
        let req = base_req(&fixture.root.join("ws"), Some("auto"));
        let events = run_optimization_fixture(&fixture, &service, req, None).await;
        assert!(events.iter().any(|event| event["kind"] == "done"));
        assert_eq!(service.inner.lock().unwrap().idle.len(), 0);
    }
    assert_eq!(fixture.spawn_pids().len(), 2);
    service.kill_spawned();
}

#[tokio::test]
async fn native_error_hidden_by_end_turn_is_reported_without_payload_leak() {
    let fixture = FakeAcpFixture::new().expect("node fixture");
    let app_home = fixture.root.join("native-home");
    std::fs::create_dir_all(app_home.join("conversations")).unwrap();
    let db_path = app_home.join("conversations/sid-warm-1.db");
    let db = rusqlite::Connection::open(&db_path).unwrap();
    db.execute_batch("CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)").unwrap();
    drop(db);
    std::fs::write(fixture.root.join("behavior.json"), json!({"errorDb":db_path}).to_string()).unwrap();
    let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let req = base_req(&fixture.root.join("ws"), Some("auto"));
    let events = run_optimization_fixture(&fixture, &service, req, Some(&app_home)).await;
    assert!(events.iter().any(|event| event["kind"] == "error" && event["data"].to_string().contains("unexpected EOF")), "{events:?}");
    assert!(!events.iter().any(|event| event["kind"] == "done"));
    assert!(!serde_json::to_string(&events).unwrap().contains("fake-secret-never-publish"));
    assert!(!serde_json::to_string(&events).unwrap().contains("raw-provider-secret-never-publish"));
    assert!(fixture.requests().iter().any(|r| r["method"] == "session/close"));
    service.kill_spawned();
}

#[tokio::test]
async fn native_refusal_cannot_be_reported_as_success_without_a_database() {
    let fixture = FakeAcpFixture::with_behavior(json!({"refusal":true})).expect("node fixture");
    let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let req = base_req(&fixture.root.join("ws"), Some("auto"));
    let events = run_optimization_fixture(&fixture, &service, req, None).await;
    assert!(events.iter().any(|event| event["kind"] == "error"));
    assert!(!events.iter().any(|event| event["kind"] == "done"));
    service.kill_spawned();
}

#[tokio::test]
async fn configuration_notifications_prevent_stale_thinking_selection() {
    let fixture = FakeAcpFixture::with_behavior(json!({"partialConfig":true,"resetThoughtOnModel":true})).expect("node fixture");
    let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let mut req = base_req(&fixture.root.join("ws"), Some("auto"));
    req.model = Some("gemini-4-carbon-high".into());
    let events = run_optimization_fixture(&fixture, &service, req, None).await;
    assert!(!events.iter().any(|event| event["kind"] == "error"), "{events:?}");
    assert!(fixture.requests().iter().any(|r| r["method"] == "session/set_config_option" && r["params"]["configId"] == "thought_level" && r["params"]["value"] == "high"));
    assert!(events.iter().any(|event| event["kind"] == "delta" && event["data"].to_string().contains("MODEL=gemini-4-carbon-high")));
    service.kill_spawned();
}

#[tokio::test]
async fn native_notifications_can_confirm_configuration_without_response_options() {
    let fixture = FakeAcpFixture::with_behavior(json!({"notificationConfirmation":true})).expect("node fixture");
    let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let mut req = base_req(&fixture.root.join("ws"), Some("auto"));
    req.model = Some("gemini-4-carbon-low".into());
    let events = run_optimization_fixture(&fixture, &service, req, None).await;
    assert!(!events.iter().any(|event| event["kind"] == "error"), "{events:?}");
    assert!(events.iter().any(|event| event["kind"] == "done"));
    service.kill_spawned();
}

#[tokio::test]
async fn a_later_configuration_change_cannot_reset_an_already_confirmed_mode() {
    let fixture = FakeAcpFixture::with_behavior(json!({"partialConfig":true,"resetModeOnModel":true})).expect("node fixture");
    let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let mut req = base_req(&fixture.root.join("ws"), Some("auto"));
    req.model = Some("gemini-4-carbon-high".into());
    let events = run_optimization_fixture(&fixture, &service, req, None).await;
    assert!(events.iter().any(|event| event["kind"] == "error" && event["data"].to_string().contains("configuration changed")));
    assert!(!fixture.requests().iter().any(|r| r["method"] == "session/prompt"));
    service.kill_spawned();
}

#[tokio::test]
async fn workspace_workers_use_request_cwd_pin_sessions_and_evict_oldest_idle() {
    let fixture = FakeAcpFixture::new().expect("node is required for the native ACP fixture");
    let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let engine = AgyEngine::new();
    let bin = fixture.bin_path.to_string_lossy().to_string();
    let db = Arc::new(crate::db::Db::open_at(&fixture.root.join("app.db")).unwrap());
    let workspaces: Vec<_> = (0..=super::MAX_IDLE_WORKERS).map(|index| {
        let ws = fixture.root.join(format!("workspace-{index}"));
        std::fs::create_dir_all(&ws).unwrap();
        dunce::canonicalize(ws).unwrap()
    }).collect();
    let mut first_pids = Vec::new();
    let order = (0..workspaces.len()).chain([workspaces.len() - 1, 0]);
    for (turn, index) in order.enumerate() {
        let ws = &workspaces[index];
        let req = base_req(ws, Some("auto"));
        let built = engine.build_command(&req, &bin).unwrap();
        let pid = 4_000_000_100 + turn as u32;
        let (mut core, _, emitter, killed) = make_turn_core(&format!("workspace-turn-{turn}"), pid);
        core.db = Some(Arc::clone(&db));
        run_acp_turn(core, req, bin.clone(), built, Arc::clone(&service), killed, pid).await;
        let events = emitter.0.lock().unwrap();
        assert!(!events.iter().any(|e| e["kind"] == "error"), "{events:?}");
        assert!(events.iter().any(|e| e["kind"] == "done"));
        let text: String = events.iter().filter(|e| e["kind"] == "delta").filter_map(|e| e["data"].as_str()).collect();
        let cwd = text.split("|CWD=").nth(1).unwrap().split('|').next().unwrap();
        assert_eq!(Path::new(cwd), ws);
        assert_eq!(db.agy_session_workspaces().unwrap().get("sid-warm-1"), Some(&ws.to_string_lossy().to_string()));
        let actual_pid = text.split("PID=").nth(1).unwrap().split('|').next().unwrap().to_string();
        if turn < workspaces.len() {
            assert!(!first_pids.contains(&actual_pid), "different workspaces must use different workers");
            first_pids.push(actual_pid);
        } else if index == workspaces.len() - 1 {
            assert_eq!(actual_pid, first_pids[index], "newest worker must survive pool overflow");
        } else {
            assert_ne!(actual_pid, first_pids[0], "oldest idle worker must be evicted");
        }
    }
    assert_eq!(fixture.spawn_pids().len(), super::MAX_IDLE_WORKERS + 2);
    service.kill_spawned();
}

#[tokio::test]
async fn broker_reuses_single_warm_daemon_across_workers_refreshes_tokens_and_suppresses_replay() {
    let Some(fixture) = FakeAcpFixture::with_behavior(json!({"resume":"supported", "partialConfig":true})) else {
        return;
    };
    let desktop_state = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    desktop_state.start_broker().await.unwrap();

    // Separate worker state pointing at the same profile root simulates per-turn `--task-worker`.
    let worker_state_1 = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let worker_state_2 = Arc::new(AgyAcpState::with_root(fixture.root.clone()));

    let engine = AgyEngine::new();
    let bin = fixture.bin_path.to_string_lossy().to_string();
    let ws = fixture.root.join("ws");

    // Turn 1 (`session/new`)
    let tok1 = uuid::Uuid::new_v4().to_string();
    let srv1 = json!({
        "command": "fake-host-mcp",
        "args": ["--host-chat-mcp"],
        "env": { "CCGUI_HOST_CHAT_URL": "http://127.0.0.1:43210/host-chat", "CCGUI_HOST_CHAT_TOKEN": tok1 }
    });
    let mut req1 = base_req(&ws, Some("auto"));
    req1.model = Some("gemini-4-carbon-low".into());
    req1.host_instructions = Some("POLICY_TURN_ONE".into());
    let mut built1 = engine
        .build_command_with_host_chat(&req1, &bin, Some(&srv1))
        .unwrap();
    append_host_instructions(&mut built1, "POLICY_TURN_ONE").unwrap();

    let (core1, _reg1, emit1, killed1) = make_turn_core("run-1", 4_000_000_001);
    run_acp_turn(
        core1,
        req1,
        bin.clone(),
        built1,
        worker_state_1,
        killed1,
        4_000_000_001,
    )
    .await;

    let ev1 = emit1.0.lock().unwrap().clone();
    let delta1: String = ev1
        .iter()
        .filter(|e| e["kind"] == "delta")
        .filter_map(|e| e["data"].as_str())
        .collect();
    assert!(delta1.contains("MODEL=gemini-4-carbon-low"), "{delta1}");
    assert!(delta1.contains("MODE=accept-edits"), "{delta1}");
    assert!(delta1.contains(&format!("TOK={tok1}")), "{delta1}");
    assert!(delta1.contains("RULES=POLICY_TURN_ONE"), "{delta1}");
    assert!(ev1.iter().any(|e| e["kind"] == "thinking"));
    assert!(ev1.iter().any(|e| e["kind"] == "retry"));
    assert!(ev1.iter().any(|e| e["kind"] == "throughput"));
    assert!(ev1.iter().any(|e| e["kind"] == "done"));
    assert!(!desktop_state.has_active_turns());

    // Verify host-chat.json was scrubbed immediately when Turn 1 ended!
    let slots_dir = fixture.root.join("agy-acp-slots");
    for entry in std::fs::read_dir(&slots_dir).unwrap().flatten() {
        assert!(!entry.path().join("host-chat.json").exists());
    }

    // Turn 2 (`session/resume` on the SAME warm daemon via a second worker!)
    let tok2 = uuid::Uuid::new_v4().to_string();
    let srv2 = json!({
        "command": "fake-host-mcp",
        "args": ["--host-chat-mcp"],
        "env": { "CCGUI_HOST_CHAT_URL": "http://127.0.0.1:43210/host-chat", "CCGUI_HOST_CHAT_TOKEN": tok2 }
    });
    let mut req2 = base_req(&ws, Some("plan"));
    req2.session_id = Some("sid-warm-1".into());
    req2.model = Some("gemini-3.8-flash-high".into());
    req2.host_instructions = Some("POLICY_TURN_TWO".into());
    let extra_dir = fixture.root.join("extra-context");
    std::fs::create_dir_all(&extra_dir).unwrap();
    req2.additional_dirs.push(extra_dir.to_string_lossy().to_string());
    let mut built2 = engine
        .build_command_with_host_chat(&req2, &bin, Some(&srv2))
        .unwrap();
    append_host_instructions(&mut built2, "POLICY_TURN_TWO").unwrap();

    let (core2, _reg2, emit2, killed2) = make_turn_core("run-2", 4_000_000_002);
    run_acp_turn(
        core2,
        req2,
        bin,
        built2,
        worker_state_2,
        killed2,
        4_000_000_002,
    )
    .await;

    let ev2 = emit2.0.lock().unwrap().clone();
    let delta2: String = ev2
        .iter()
        .filter(|e| e["kind"] == "delta")
        .filter_map(|e| e["data"].as_str())
        .collect();
    assert!(!delta2.contains("STALE_HISTORY_REPLAY"), "{delta2}");
    assert!(delta2.contains("MODEL=gemini-3.8-flash-high"), "{delta2}");
    assert!(delta2.contains("MODE=plan"), "{delta2}");
    assert!(delta2.contains(&format!("TOK={tok2}")), "{delta2}");
    assert!(delta2.contains("RULES=POLICY_TURN_TWO"), "{delta2}");

    // Spawn count MUST be 1 across both worker turns!
    let pids = fixture.spawn_pids();
    assert_eq!(pids.len(), 1, "expected 1 warm daemon spawn, got {pids:?}");
    let requests = fixture.requests();
    assert!(!requests.iter().any(|r| r["method"] == "session/load"));
    let resumed = requests.iter().find(|r| r["method"] == "session/resume").unwrap();
    assert_eq!(resumed["params"]["cwd"], ws.to_string_lossy().as_ref());
    assert!(resumed["params"]["additionalDirectories"].as_array().unwrap().contains(&json!(extra_dir.to_string_lossy())));
    assert_eq!(resumed["params"]["mcpServers"].as_array().unwrap().len(), 1);
    assert_eq!(requests.iter().filter(|r| r["method"] == "session/close").count(), 2);

    desktop_state.kill_spawned();
}

#[tokio::test]
async fn broker_auth_change_restarts_daemon_and_loads_original_session() {
    let fixture = FakeAcpFixture::new().expect("node is required for the native ACP fixture");
    let auth = Arc::new(StdMutex::new(Some("account-a".to_string())));
    let mut desktop = AgyAcpState::with_root(fixture.root.clone());
    let auth_reader = Arc::clone(&auth);
    desktop.auth_fingerprint_reader = Arc::new(move |_| auth_reader.lock().unwrap().clone());
    let desktop = Arc::new(desktop);
    desktop.start_broker().await.unwrap();
    let bin = fixture.bin_path.to_string_lossy().to_string();
    let engine = AgyEngine::new();

    for (index, credential) in [Some("account-a"), Some("account-a"), Some("account-b"), Some("account-b")].into_iter().enumerate() {
        *auth.lock().unwrap() = credential.map(str::to_owned);
        let mut req = base_req(&fixture.root.join("ws"), Some("auto"));
        req.session_id = Some("original-account-a-session".into());
        let built = engine.build_command(&req, &bin).unwrap();
        let pid = 4_000_001_000 + index as u32;
        let (core, _, emitter, killed) = make_turn_core(&format!("auth-turn-{index}"), pid);
        // Every request has a separate client; only the desktop can verify the
        // current login, and it must not trust a fingerprint supplied by clients.
        let worker = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
        run_acp_turn(core, req, bin.clone(), built, worker, killed, pid).await;
        let events = emitter.0.lock().unwrap();
        assert!(!events.iter().any(|e| e["kind"] == "error"), "{events:?}");
        assert!(events.iter().any(|e| e["kind"] == "done"));
        let text: String = events.iter().filter(|e| e["kind"] == "delta").filter_map(|e| e["data"].as_str()).collect();
        assert!(text.contains("|SID=original-account-a-session|"), "{text}");
        assert!(!text.contains("STALE_HISTORY_REPLAY"), "{text}");
        let expected_spawns = if index < 2 { 1 } else { 2 };
        assert_eq!(fixture.spawn_pids().len(), expected_spawns, "auth changed before turn {index}");
    }
    desktop.kill_spawned();
}

fn auth_fixture_profile(fixture: &FakeAcpFixture) -> super::WorkerProfileKey {
    let req = base_req(&fixture.root.join("ws"), Some("auto"));
    let bin = fixture.bin_path.to_string_lossy().to_string();
    let built = AgyEngine::new().build_command(&req, &bin).unwrap();
    super::driver::extract_launch("auth-fixture", &req, &bin, built).unwrap().profile
}

#[tokio::test]
async fn auth_unavailable_never_reuses_a_daemon_including_after_logout() {
    let fixture = FakeAcpFixture::new().expect("node is required for the native ACP fixture");
    let profile = auth_fixture_profile(&fixture);
    let auth = Arc::new(StdMutex::new(Some("account-a".to_string())));
    let mut service = AgyAcpState::with_root(fixture.root.clone());
    let auth_reader = Arc::clone(&auth);
    service.auth_fingerprint_reader = Arc::new(move |_| auth_reader.lock().unwrap().clone());
    let mut first_slot = None;
    for (index, credential) in [Some("account-a"), None, None, Some("account-b"), Some("account-b")].into_iter().enumerate() {
        *auth.lock().unwrap() = credential.map(str::to_owned);
        let (worker, _guard, _, _, _) = service.checkout_local(&profile, "", None).await.unwrap();
        let slot = worker.slot_dir.clone();
        if index == 0 { first_slot = Some(slot.clone()); }
        service.release_local(worker, true).await;
        if credential.is_none() { assert!(!slot.exists(), "unverified login must not enter the idle pool"); }
        if index > 0 { assert!(!first_slot.as_ref().unwrap().exists(), "logged-out process must be retired"); }
        assert_eq!(fixture.spawn_pids().len(), (index + 1).min(4));
    }
    service.kill_spawned();
}

#[tokio::test]
async fn auth_change_during_active_turn_retires_only_the_old_lease_on_return() {
    let fixture = FakeAcpFixture::new().expect("node is required for the native ACP fixture");
    let profile = auth_fixture_profile(&fixture);
    let auth = Arc::new(StdMutex::new(Some("account-a".to_string())));
    let mut service = AgyAcpState::with_root(fixture.root.clone());
    let auth_reader = Arc::clone(&auth);
    service.auth_fingerprint_reader = Arc::new(move |_| auth_reader.lock().unwrap().clone());
    let (mut old, old_guard, _, _, _) = service.checkout_local(&profile, "", None).await.unwrap();
    let old_slot = old.slot_dir.clone();
    *auth.lock().unwrap() = Some("account-b".into());
    let (new, new_guard, _, _, _) = service.checkout_local(&profile, "", None).await.unwrap();
    assert!(old.child.try_wait().unwrap().is_none(), "account changes must not interrupt an active request");
    service.release_local(new, true).await;
    service.release_local(old, true).await;
    drop((old_guard, new_guard));
    assert!(!old_slot.exists(), "old account process must not be pooled after a late return");
    let (current, _guard, _, _, _) = service.checkout_local(&profile, "", None).await.unwrap();
    assert_eq!(fixture.spawn_pids().len(), 2, "new account's warm process should survive");
    service.release_local(current, true).await;
    service.kill_spawned();
}

#[tokio::test]
async fn auth_change_during_startup_restarts_before_leasing_the_process() {
    let fixture = FakeAcpFixture::new().expect("node is required for the native ACP fixture");
    let profile = auth_fixture_profile(&fixture);
    let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut service = AgyAcpState::with_root(fixture.root.clone());
    service.auth_fingerprint_reader = Arc::new(move |_| {
        Some(if reads.fetch_add(1, Ordering::SeqCst) == 0 { "account-a" } else { "account-b" }.into())
    });
    let (worker, _guard, _, _, _) = service.checkout_local(&profile, "", None).await.unwrap();
    assert_eq!(fixture.spawn_pids().len(), 2, "startup auth changes must be settled before session/prompt");
    service.release_local(worker, true).await;
    service.kill_spawned();
}

#[tokio::test]
async fn auth_changes_during_both_startups_fail_without_an_unbounded_retry() {
    let fixture = FakeAcpFixture::new().expect("node is required for the native ACP fixture");
    let profile = auth_fixture_profile(&fixture);
    let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut service = AgyAcpState::with_root(fixture.root.clone());
    service.auth_fingerprint_reader = Arc::new(move |_| Some(format!("auth-{}", reads.fetch_add(1, Ordering::SeqCst))));
    let result = service.checkout_local(&profile, "", None).await;
    match result {
        Ok((worker, _, _, _, _)) => {
            service.release_local(worker, false).await;
            panic!("continuously changing authentication must fail before leasing");
        }
        Err(error) => assert!(error.contains("authentication changed"), "{error}"),
    }
    assert_eq!(fixture.spawn_pids().len(), 2);
    assert_eq!(std::fs::read_dir(service.slots_parent()).unwrap().count(), 0);
}

#[tokio::test]
async fn auth_login_and_logout_during_startup_both_replace_the_process() {
    for (initial, final_auth) in [(None, Some("account-b")), (Some("account-a"), None)] {
        let fixture = FakeAcpFixture::new().expect("node is required for the native ACP fixture");
        let profile = auth_fixture_profile(&fixture);
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut service = AgyAcpState::with_root(fixture.root.clone());
        service.auth_fingerprint_reader = Arc::new(move |_| {
            if reads.fetch_add(1, Ordering::SeqCst) == 0 { initial } else { final_auth }.map(str::to_owned)
        });
        let (worker, _guard, _, _, _) = service.checkout_local(&profile, "", None).await.unwrap();
        assert_eq!(fixture.spawn_pids().len(), 2);
        service.release_local(worker, true).await;
        service.kill_spawned();
    }
}

#[tokio::test]
async fn broker_auth_rejection_does_not_fall_back_and_send_the_prompt_locally() {
    let fixture = FakeAcpFixture::new().expect("node is required for the native ACP fixture");
    let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut desktop = AgyAcpState::with_root(fixture.root.clone());
    desktop.auth_fingerprint_reader = Arc::new(move |_| Some(format!("auth-{}", reads.fetch_add(1, Ordering::SeqCst))));
    let desktop = Arc::new(desktop);
    desktop.start_broker().await.unwrap();
    let client = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let req = base_req(&fixture.root.join("ws"), Some("auto"));
    let bin = fixture.bin_path.to_string_lossy().to_string();
    let built = AgyEngine::new().build_command(&req, &bin).unwrap();
    let (core, _, emitter, killed) = make_turn_core("auth-rejected", 4_000_002_000);
    run_acp_turn(core, req, bin, built, client, killed, 4_000_002_000).await;
    let events = emitter.0.lock().unwrap();
    assert!(events.iter().any(|e| e["kind"] == "error" && e["data"].as_str().is_some_and(|s| s.contains("authentication changed"))), "{events:?}");
    assert!(!events.iter().any(|e| matches!(e["kind"].as_str(), Some("delta" | "done"))), "{events:?}");
    assert_eq!(fixture.spawn_pids().len(), 2, "broker rejection must not spawn a third local process");
    assert!(!desktop.has_active_turns());
    desktop.kill_spawned();
}

#[test]
fn auth_overrides_cannot_be_identified_by_the_shared_native_keyring() {
    let fixture = FakeAcpFixture::new().expect("node is required for the native ACP fixture");
    let mut profile = auth_fixture_profile(&fixture);
    for name in ["ANTIGRAVITY_HOME", "ANTIGRAVITY_GEMINI_DIR", "ANTIGRAVITY_CONFIG_REL_DIR", "ANTIGRAVITY_APP_DATA_DIR", "SSH_TTY", "SSH_CONNECTION", "GEMINI_API_KEY", "GOOGLE_API_KEY", "AGY_ADC_AUTH", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] {
        profile.env_pairs = vec![(name.to_ascii_lowercase(), "fixture-override".into())];
        assert!(super::native_worker_auth_fingerprint(&profile).is_none(), "{name}");
    }
}

#[tokio::test]
async fn permission_modes_cancel_retires_daemon_and_crash_respawns() {
    let Some(fixture) = FakeAcpFixture::new() else {
        return;
    };
    let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let engine = AgyEngine::new();
    let bin = fixture.bin_path.to_string_lossy().to_string();
    let ws = fixture.root.join("ws");

    // 1. `auto` mode denies `session/request_permission` (no silent escalation to bypass!)
    let mut req_auto = base_req(&ws, Some("auto"));
    req_auto.prompt = "ASK_PERM".into();
    let built_auto = engine.build_command(&req_auto, &bin).unwrap();
    let (core_a, _reg_a, emit_a, killed_a) = make_turn_core("run-auto", 4_000_000_010);
    run_acp_turn(
        core_a,
        req_auto,
        bin.clone(),
        built_auto,
        Arc::clone(&service),
        killed_a,
        4_000_000_010,
    )
    .await;
    let ev_a = emit_a.0.lock().unwrap().clone();
    let text_a: String = ev_a
        .iter()
        .filter(|e| e["kind"] == "delta")
        .filter_map(|e| e["data"].as_str())
        .collect();
    assert!(text_a.contains("PERM_CHOICE=reject_once"), "{text_a}");
    assert!(ev_a.iter().any(|e| e["kind"] == "permission_denied"));

    // 2. `bypass` mode selects `allow_once` (never mutating persistent `allow_always`!)
    let mut req_bypass = base_req(&ws, Some("bypass"));
    req_bypass.prompt = "ASK_PERM".into();
    let built_bypass = engine.build_command(&req_bypass, &bin).unwrap();
    let (core_b, _reg_b, emit_b, killed_b) = make_turn_core("run-bypass", 4_000_000_011);
    run_acp_turn(
        core_b,
        req_bypass,
        bin.clone(),
        built_bypass,
        Arc::clone(&service),
        killed_b,
        4_000_000_011,
    )
    .await;
    let ev_b = emit_b.0.lock().unwrap().clone();
    let text_b: String = ev_b
        .iter()
        .filter(|e| e["kind"] == "delta")
        .filter_map(|e| e["data"].as_str())
        .collect();
    assert!(text_b.contains("PERM_CHOICE=allow_once"), "{text_b}");
    assert!(!ev_b.iter().any(|e| e["kind"] == "permission_denied"));

    // 3. Cancel retires this worker even when the CLI acknowledges the prompt.
    let mut req_cancel = base_req(&ws, Some("auto"));
    req_cancel.prompt = "HANG_FOR_CANCEL".into();
    let built_cancel = engine.build_command(&req_cancel, &bin).unwrap();
    let (core_c, _reg_c, emit_c, killed_c) = make_turn_core("run-cancel", 4_000_000_012);
    let cancel_trigger = Arc::clone(&killed_c);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        cancel_trigger.store(true, Ordering::SeqCst);
    });
    run_acp_turn(
        core_c,
        req_cancel,
        bin.clone(),
        built_cancel,
        Arc::clone(&service),
        killed_c,
        4_000_000_012,
    )
    .await;
    let ev_c = emit_c.0.lock().unwrap().clone();
    assert!(!ev_c.iter().any(|e| e["kind"] == "error"), "{ev_c:?}");
    assert!(ev_c.iter().any(|e| e["kind"] == "done"));
    assert_eq!(
        fixture.spawn_pids().len(),
        1,
        "cancel must not start a replacement before the next turn"
    );
    assert!(service.inner.lock().unwrap().idle.is_empty(), "cancelled workers must leave the pool");

    // 4. Simulated crash triggers clean error and auto-respawns on next turn!
    let mut req_crash = base_req(&ws, Some("auto"));
    req_crash.prompt = "CRASH_NOW".into();
    let built_crash = engine.build_command(&req_crash, &bin).unwrap();
    let (core_d, _reg_d, emit_d, killed_d) = make_turn_core("run-crash", 4_000_000_013);
    run_acp_turn(
        core_d,
        req_crash,
        bin.clone(),
        built_crash,
        Arc::clone(&service),
        killed_d,
        4_000_000_013,
    )
    .await;
    assert!(emit_d
        .0
        .lock()
        .unwrap()
        .iter()
        .any(|e| e["kind"] == "error"));

    let req_recover = base_req(&ws, Some("auto"));
    let built_recover = engine.build_command(&req_recover, &bin).unwrap();
    let (core_e, _reg_e, emit_e, killed_e) = make_turn_core("run-recover", 4_000_000_014);
    run_acp_turn(
        core_e,
        req_recover,
        bin,
        built_recover,
        Arc::clone(&service),
        killed_e,
        4_000_000_014,
    )
    .await;
    assert!(emit_e
        .0
        .lock()
        .unwrap()
        .iter()
        .any(|e| e["kind"] == "done"));
    assert_eq!(
        fixture.spawn_pids().len(),
        3,
        "expected fresh daemon spawns after cancellation and crash"
    );

    service.kill_spawned();
}

struct BgAndQuestionFixture {
    root: PathBuf,
    bin_path: PathBuf,
    cancel_log: PathBuf,
    owns_root: bool,
}

impl BgAndQuestionFixture {
    fn new() -> Option<Self> {
        let node = find_node_exe()?;
        let root = std::env::temp_dir().join(format!("ccgui-agy-bg-q-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("ws")).unwrap();
        let cancel_log = root.join("cancel.json");
        let server_js = root.join("fake-bg-q-acp.mjs");
        std::fs::write(
            &server_js,
            r#"
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import {spawn} from 'child_process';

const appDir = process.env.ANTIGRAVITY_APP_DATA_DIR;
const cancelLog = process.env.FAKE_CANCEL_LOG;
let sessionSeq = 0;
let closedSessions = new Set();
let pendingAskPromptId = null;
let pendingAskSid = null;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function appendTranscript(sid, obj) {
  const dir = path.join(appDir, 'brain', sid, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'transcript.jsonl'), JSON.stringify(obj) + '\n');
}

function writeTaskLog(sid, shortId, content, append = false) {
  const dir = path.join(appDir, 'brain', sid, '.system_generated', 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${shortId}.log`);
  if (append) fs.appendFileSync(fp, content);
  else fs.writeFileSync(fp, content);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (!msg.params?.clientCapabilities?.elicitation?.form) {
      process.exit(17);
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }
  if (msg.method === 'session/new') {
    sessionSeq += 1;
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: `sid-bg-${sessionSeq}`, configOptions: [] } });
    return;
  }
  if (msg.method === 'session/load') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId, configOptions: [] } });
    return;
  }
  if (msg.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [{id:msg.params.configId,currentValue:msg.params.value}] } });
    return;
  }
  if (msg.method === 'session/close') {
    closedSessions.add(msg.params.sessionId);
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/cancel') {
    fs.writeFileSync(cancelLog, JSON.stringify(msg.params));
    if (pendingAskPromptId !== null) {
      send({ jsonrpc: '2.0', id: pendingAskPromptId, result: { stopReason: 'cancelled' } });
      pendingAskPromptId = null;
    }
    return;
  }
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    const text = msg.params?.prompt?.[0]?.text || '';
    if (text === 'BG_WAKEUP') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-bg-1',
            title: 'run_command',
            status: 'in_progress',
            rawInput: { CommandLine: 'pnpm build', toolSummary: 'Production build', IsDaemon: false },
          },
        },
      });
      writeTaskLog(sid, 'task-206', 'Created At: 2026-11-12T22:00:00Z\n\x1b[32mvite building...\x1b[0m\n');
      appendTranscript(sid, {
        type: 'TOOL_RESPONSE',
        source: 'SYSTEM',
        status: 'RUNNING',
        content: `Tool is running as a background task with task id: ${sid}/task-206\nTask Description: pnpm build\n`,
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started build.' } } },
      });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } },
      });
      setTimeout(() => {
        if (closedSessions.has(sid)) process.exit(19);
        writeTaskLog(sid, 'task-206', 'dist/app.js 42 kB\n', true);
        appendTranscript(sid, {
          type: 'SYSTEM_MESSAGE',
          source: 'SYSTEM',
          status: 'DONE',
          content: `<SYSTEM_MESSAGE sender=${sid}/task-206>\nTask id "${sid}/task-206" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`,
        });
      }, 220);
      return;
    }
    if (text.includes('[ccgui:agy-background-task-wakeup]')) {
      appendTranscript(sid, { type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'Build finished.' });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Build finished.' } } },
      });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 12, totalTokens: 92 } },
      });
      return;
    }
    if (text === 'BG_DAEMON') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-daemon',
            title: 'run_command',
            status: 'in_progress',
            rawInput: { CommandLine: 'pnpm dev', toolSummary: 'Dev server', IsDaemon: true },
          },
        },
      });
      appendTranscript(sid, {
        type: 'TOOL_RESPONSE',
        source: 'SYSTEM',
        status: 'RUNNING',
        content: `Tool is running as a background task with task id: ${sid}/task-daemon\nTask Description: pnpm dev\n`,
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } } });
      return;
    }
    if (text === 'BG_STOP') {
      const beat = path.join(path.dirname(cancelLog), 'descendant-heartbeat');
      spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(beat + '.pid')},String(process.pid));setInterval(()=>require('fs').appendFileSync(${JSON.stringify(beat)},'.'),20)`], {stdio:'ignore',windowsHide:true});
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-stop',
            title: 'run_command',
            status: 'in_progress',
            rawInput: { CommandLine: 'sleep 99', toolSummary: 'Long job', IsDaemon: false },
          },
        },
      });
      appendTranscript(sid, {
        type: 'TOOL_RESPONSE',
        source: 'SYSTEM',
        status: 'RUNNING',
        content: `Tool is running as a background task with task id: ${sid}/task-stop\nTask Description: sleep 99\n`,
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } } });
      return;
    }
    if (text === 'BG_RESTART_NOTICE') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-restart',
            title: 'RunCommand',
            kind: 'execute',
            status: 'pending',
            rawInput: {},
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-restart',
            status: 'in_progress',
            rawInput: { CommandLine: 'npm --prefix /app run watch', toolSummary: 'Watch dev bundle', IsDaemon: false },
          },
        },
      });
      appendTranscript(sid, {
        type: 'GENERIC',
        source: 'MODEL',
        status: 'RUNNING',
        content: `Created At: 2026-11-13T21:48:00Z\nTool is running as a background task with task id: ${sid}/task-restart\nTask Description: npm --prefix /app run watch\n`,
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Watching bundle.' } } },
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 25, outputTokens: 5, totalTokens: 30 } } });
      setTimeout(() => {
        if (closedSessions.has(sid)) process.exit(20);
        appendTranscript(sid, {
          type: 'SYSTEM_MESSAGE',
          source: 'SYSTEM',
          status: 'DONE',
          content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-13T21:48:07Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>',
        });
      }, 150);
      return;
    }
    if (text === 'ASK_Q' || text === 'ASK_Q_CRASH') {
      pendingAskPromptId = msg.id;
      pendingAskSid = sid;
      send({
        jsonrpc: '2.0',
        id: 'ask-rpc-1',
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: 'Clarify options',
          requestedSchema: {
            type: 'object',
            properties: {
              q0: { type: 'string', description: 'Pick strategy', enum: ['(Recommended) Unified', 'Custom'] },
              q0_other: { type: 'string', description: 'Other strategy' },
              q1: { type: 'array', description: 'Targets', items: { type: 'string', enum: ['rust', 'ts'] } },
            },
            required: ['q0'],
          },
        },
      });
      if (text === 'ASK_Q_CRASH') setTimeout(() => process.exit(23), 150);
      return;
    }
  }
  if (msg.id === 'ask-rpc-1' && pendingAskPromptId !== null) {
    const pid = pendingAskPromptId;
    const sid = pendingAskSid;
    pendingAskPromptId = null;
    pendingAskSid = null;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ANSWER=${JSON.stringify(msg.result)}` } } },
    });
    send({ jsonrpc: '2.0', id: pid, result: { stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 8, totalTokens: 38 } } });
  }
});
"#,
        )
        .unwrap();

        #[cfg(windows)]
        let bin_path = {
            let cmd = root.join("fake-bg-q.cmd");
            std::fs::write(
                &cmd,
                format!(
                    "@echo off\r\nset \"FAKE_CANCEL_LOG={}\"\r\n\"{}\" \"{}\" %*\r\n",
                    cancel_log.display(),
                    node.display(),
                    server_js.display()
                ),
            )
            .unwrap();
            cmd
        };
        #[cfg(not(windows))]
        let bin_path = {
            use std::os::unix::fs::PermissionsExt;
            let sh = root.join("fake-bg-q.sh");
            std::fs::write(
                &sh,
                format!(
                    "#!/bin/sh\nexport FAKE_CANCEL_LOG=\"{}\"\nexec \"{}\" \"{}\" \"$@\"\n",
                    cancel_log.display(),
                    node.display(),
                    server_js.display()
                ),
            )
            .unwrap();
            let mut perms = std::fs::metadata(&sh).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&sh, perms).unwrap();
            sh
        };

        Some(Self {
            root,
            bin_path,
            cancel_log,
            owns_root: true,
        })
    }
}

impl Drop for BgAndQuestionFixture {
    fn drop(&mut self) {
        if self.owns_root {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

#[tokio::test]
async fn background_tasks_and_elicitation_questions_follow_native_lifecycle() {
    tokio::time::timeout(Duration::from_secs(20), exercise_background_and_questions())
        .await.expect("background/question lifecycle hung");
}

#[tokio::test]
async fn broker_background_tasks_and_elicitation_questions_follow_native_lifecycle() {
    let fixture = BgAndQuestionFixture::new().expect("Node is required for ACP integration tests");
    let mut svc = AgyAcpState::with_root(fixture.root.clone());
    svc.auth_fingerprint_reader = Arc::new(|_| Some("test-auth".to_string()));
    let desktop = Arc::new(svc);
    desktop.start_broker().await.unwrap();
    // A separate Rust process owns the run registry and OUTBOUND_RUNS. Only
    // NDJSON crosses the broker; an accidental desktop-local answer map fails.
    let result = tokio::time::timeout(Duration::from_secs(30), tokio::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "engine::agy_acp::tests::background_tasks_and_elicitation_questions_follow_native_lifecycle", "--nocapture"])
        .env("CCGUI_AGY_ACP_TEST_ROOT", &fixture.root)
        .env("CCGUI_AGY_ACP_TEST_BIN", &fixture.bin_path)
        .kill_on_drop(true)
        .output()).await;
    desktop.kill_spawned();
    let output = result.expect("broker worker subprocess hung").unwrap();
    assert!(output.status.success(), "worker stdout: {}\nworker stderr: {}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
}

async fn exercise_background_and_questions() {
    let remote_root = std::env::var_os("CCGUI_AGY_ACP_TEST_ROOT").map(PathBuf::from);
    let remote = remote_root.is_some();
    let fixture = if let Some(root) = remote_root {
        BgAndQuestionFixture {
            bin_path: std::env::var_os("CCGUI_AGY_ACP_TEST_BIN").unwrap().into(),
            cancel_log: root.join("cancel.json"),
            root,
            owns_root: false,
        }
    } else {
        BgAndQuestionFixture::new().expect("Node is required for ACP integration tests")
    };
    let mut svc = AgyAcpState::with_root(fixture.root.clone());
    svc.auth_fingerprint_reader = Arc::new(|_| Some("test-auth".to_string()));
    let desktop = Arc::new(svc);
    let service = if remote {
        Arc::new(AgyAcpState::with_root(fixture.root.clone()))
    } else {
        Arc::clone(&desktop)
    };
    let engine = AgyEngine::new();
    let bin = fixture.bin_path.to_string_lossy().to_string();
    let ws = fixture.root.join("ws");

    // 1. Non-daemon background task tracks log progress, waits for completion, and wakes model.
    let mut req_bg = base_req(&ws, Some("auto"));
    req_bg.prompt = "BG_WAKEUP".into();
    let mut built_bg = engine.build_command(&req_bg, &bin).unwrap();
    built_bg.command.env("ANTIGRAVITY_APP_DATA_DIR", &fixture.root);
    let (core_bg, _reg_bg, emit_bg, killed_bg) = make_turn_core(&format!("run-bg-wakeup-{remote}"), 4_100_000_001);
    run_acp_turn(
        core_bg,
        req_bg,
        bin.clone(),
        built_bg,
        Arc::clone(&service),
        killed_bg,
        4_100_000_001,
    )
    .await;
    let ev_bg = emit_bg.0.lock().unwrap().clone();
    assert!(!ev_bg.iter().any(|e| e["kind"] == "error"), "{ev_bg:?}");
    let deltas_bg: String = ev_bg
        .iter()
        .filter(|e| e["kind"] == "delta")
        .filter_map(|e| e["data"].as_str())
        .collect();
    assert!(deltas_bg.contains("Started build.") && deltas_bg.contains("Build finished."), "{deltas_bg}");
    assert!(ev_bg.iter().any(|e| e["kind"] == "activity" && e["data"]["state"] == "waiting"));
    assert!(ev_bg.iter().any(|e| e["kind"] == "activity" && e["data"]["state"] == "running"));
    assert_eq!(
        ev_bg.iter().filter(|e| e["kind"] == "turn_complete").count(),
        2,
        "both initial turn and wakeup continuation must emit TurnComplete: {ev_bg:?}"
    );
    let reply_usage: Vec<_> = ev_bg.iter().filter(|e| e["kind"] == "turn_complete")
        .map(|e| e["data"]["usage"]["output_tokens"].as_u64().unwrap()).collect();
    assert_eq!(reply_usage, vec![10, 12]);
    let done = ev_bg.iter().filter(|e| e["kind"] == "done").collect::<Vec<_>>();
    assert_eq!(done.len(), 1);
    assert!(done[0]["data"]["usage"].is_null(), "Done must not double-count the final reply");
    let tc_positions: Vec<_> = ev_bg
        .iter()
        .enumerate()
        .filter(|(_, e)| e["kind"] == "turn_complete")
        .map(|(i, _)| i)
        .collect();
    let complete_tp: Vec<_> = ev_bg
        .iter()
        .enumerate()
        .filter(|(_, e)| e["kind"] == "throughput" && e["data"]["status"] == "complete")
        .collect();
    assert_eq!(
        complete_tp.len(),
        2,
        "both continuations must emit their own complete throughput before TurnComplete: {ev_bg:?}"
    );
    let tp_tokens: Vec<_> = complete_tp
        .iter()
        .map(|(_, e)| e["data"]["outputTokens"].as_u64().unwrap())
        .collect();
    assert_eq!(tp_tokens, vec![10, 12]);
    assert!(complete_tp[0].0 < tc_positions[0], "{ev_bg:?}");
    let waiting_pos = ev_bg
        .iter()
        .position(|e| e["kind"] == "activity" && e["data"]["state"] == "waiting")
        .expect("expected waiting activity");
    let resume_running_pos = ev_bg
        .iter()
        .enumerate()
        .find(|(i, e)| *i > waiting_pos && e["kind"] == "activity" && e["data"]["state"] == "running")
        .map(|(i, _)| i)
        .expect("expected resume running activity");
    assert!(
        complete_tp[1].0 > resume_running_pos && complete_tp[1].0 < tc_positions[1],
        "{ev_bg:?}"
    );
    let last_tasks = ev_bg
        .iter()
        .rev()
        .find(|e| e["kind"] == "tasks")
        .expect("expected tasks event");
    assert_eq!(last_tasks["data"]["tasks"][0]["status"], "completed");
    assert_eq!(last_tasks["data"]["tasks"][0]["description"], "Production build");
    assert_eq!(last_tasks["data"]["tasks"][0]["summary"], "pnpm build");
    assert_eq!(
        last_tasks["data"]["tasks"][0]["progress"],
        "vite building...\ndist/app.js 42 kB"
    );

    // 2. Ambient daemon task does not block turn completion.
    let mut req_daemon = base_req(&ws, Some("auto"));
    req_daemon.prompt = "BG_DAEMON".into();
    let mut built_daemon = engine.build_command(&req_daemon, &bin).unwrap();
    built_daemon.command.env("ANTIGRAVITY_APP_DATA_DIR", &fixture.root);
    let (core_d, _reg_d, emit_d, killed_d) = make_turn_core(&format!("run-bg-daemon-{remote}"), 4_100_000_002);
    run_acp_turn(
        core_d,
        req_daemon,
        bin.clone(),
        built_daemon,
        Arc::clone(&service),
        killed_d,
        4_100_000_002,
    )
    .await;
    let ev_d = emit_d.0.lock().unwrap().clone();
    assert!(!ev_d.iter().any(|e| e["kind"] == "activity" && e["data"]["state"] == "waiting"));
    let daemon_tasks = ev_d.iter().rev().find(|e| e["kind"] == "tasks").unwrap();
    assert_eq!(daemon_tasks["data"]["tasks"][0]["ambient"], true);
    assert_eq!(daemon_tasks["data"]["tasks"][0]["status"], "running");

    // 3. User Stop while waiting sends killBackgroundTasks: true and settles task as stopped.
    let mut req_stop = base_req(&ws, Some("auto"));
    req_stop.prompt = "BG_STOP".into();
    let mut built_stop = engine.build_command(&req_stop, &bin).unwrap();
    built_stop.command.env("ANTIGRAVITY_APP_DATA_DIR", &fixture.root);
    let (core_s, _reg_s, emit_s, killed_s) = make_turn_core(&format!("run-bg-stop-{remote}"), 4_100_000_003);
    let stop_flag = Arc::clone(&killed_s);
    let stop_events = Arc::clone(&emit_s);
    let stop_beat = fixture.root.join("descendant-heartbeat");
    tokio::spawn(async move {
        for _ in 0..200 {
            if std::fs::metadata(&stop_beat).is_ok_and(|m| m.len() > 0)
                && stop_events.0.lock().unwrap().iter().any(|e| e["kind"] == "activity" && e["data"]["state"] == "waiting") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        stop_flag.store(true, Ordering::SeqCst);
    });
    run_acp_turn(
        core_s,
        req_stop,
        bin.clone(),
        built_stop,
        Arc::clone(&service),
        killed_s,
        4_100_000_003,
    )
    .await;
    let ev_s = emit_s.0.lock().unwrap().clone();
    let stop_tasks = ev_s.iter().rev().find(|e| e["kind"] == "tasks").unwrap();
    assert_eq!(stop_tasks["data"]["tasks"][0]["status"], "stopped");
    let cancel_json: Value =
        serde_json::from_str(&std::fs::read_to_string(&fixture.cancel_log).unwrap()).unwrap();
    assert_eq!(cancel_json["killBackgroundTasks"], true);
    let beat = fixture.root.join("descendant-heartbeat");
    let stopped_beat = std::fs::read(&beat).expect("background descendant must actually start");
    assert!(!stopped_beat.is_empty());
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(std::fs::read(&beat).unwrap(), stopped_beat, "background descendant survived terminal stop (remote={remote})");

    // 3b. Global server-restart SYSTEM_MESSAGE settles waiting background task and captures ACP late toolSummary.
    let mut req_restart = base_req(&ws, Some("auto"));
    req_restart.prompt = "BG_RESTART_NOTICE".into();
    let mut built_restart = engine.build_command(&req_restart, &bin).unwrap();
    built_restart.command.env("ANTIGRAVITY_APP_DATA_DIR", &fixture.root);
    let (core_r, _reg_r, emit_r, killed_r) =
        make_turn_core(&format!("run-bg-restart-{remote}"), 4_100_000_010);
    run_acp_turn(
        core_r,
        req_restart,
        bin.clone(),
        built_restart,
        Arc::clone(&service),
        killed_r,
        4_100_000_010,
    )
    .await;
    let ev_r = emit_r.0.lock().unwrap().clone();
    assert!(!ev_r.iter().any(|e| e["kind"] == "error"), "{ev_r:?}");
    assert_eq!(
        ev_r.iter().filter(|e| e["kind"] == "turn_complete").count(),
        1,
        "global restart stop must not fire a wakeup continuation: {ev_r:?}"
    );
    assert_eq!(
        ev_r.iter().filter(|e| e["kind"] == "done").count(),
        1,
        "{ev_r:?}"
    );
    let restart_tasks = ev_r
        .iter()
        .rev()
        .find(|e| e["kind"] == "tasks")
        .expect("expected tasks event on global restart notice");
    assert_eq!(restart_tasks["data"]["tasks"][0]["id"], "task-restart");
    assert_eq!(
        restart_tasks["data"]["tasks"][0]["description"],
        "Watch dev bundle"
    );
    assert_eq!(
        restart_tasks["data"]["tasks"][0]["summary"],
        "npm --prefix /app run watch"
    );
    assert_eq!(restart_tasks["data"]["tasks"][0]["status"], "stopped");

    // 4. Elicitation form parks QuestionCard, delivers write-in + multi-select, and resumes.
    let mut req_q = base_req(&ws, Some("auto"));
    req_q.prompt = "ASK_Q".into();
    let mut built_q = engine.build_command(&req_q, &bin).unwrap();
    built_q.command.env("ANTIGRAVITY_APP_DATA_DIR", &fixture.root);
    let question_run = format!("run-ask-q-{remote}");
    let (core_q, reg_q, emit_q, killed_q) = make_turn_core(&question_run, 4_100_000_004);
    let emit_q_watch = Arc::clone(&emit_q);
    let question_app = question_test_app(reg_q, Arc::clone(&service), &emit_q);
    let responder = tokio::spawn(async move {
        for _ in 0..80 {
            let q_id = {
                let guard = emit_q_watch.0.lock().unwrap();
                guard
                    .iter()
                    .find(|e| e["kind"] == "question")
                    .and_then(|e| e["data"]["requestId"].as_str().map(str::to_string))
            };
            if let Some(request_id) = q_id {
                tokio::time::sleep(Duration::from_millis(5)).await;
                let answers = json!({
                    "Pick strategy": "Custom write-in plan",
                    "Targets": ["rust", "ts"],
                });
                crate::engine::answer_question_inner(&question_app, question_run, request_id, Some(answers)).await.unwrap();
                return;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        panic!("question did not arrive");
    });
    run_acp_turn(
        core_q,
        req_q,
        bin.clone(),
        built_q,
        Arc::clone(&service),
        killed_q,
        4_100_000_004,
    )
    .await;
    responder.await.unwrap();
    let ev_q = emit_q.0.lock().unwrap().clone();
    assert!(ev_q.iter().any(|e| e["kind"] == "activity" && e["data"]["state"] == "requires_action"));
    let deltas_q: String = ev_q
        .iter()
        .filter(|e| e["kind"] == "delta")
        .filter_map(|e| e["data"].as_str())
        .collect();
    assert!(deltas_q.contains("\"action\":\"accept\""), "{deltas_q}");
    assert!(deltas_q.contains("\"q0_other\":\"Custom write-in plan\""), "{deltas_q}");
    assert!(deltas_q.contains("\"q1\":[\"rust\",\"ts\"]"), "{deltas_q}");

    assert!(ev_q.iter().any(|e| e["kind"] == "activity" && e["data"]["state"] == "running"));
    let tp_q = ev_q
        .iter()
        .rev()
        .find(|e| e["kind"] == "throughput" && e["data"]["status"] == "complete")
        .expect("expected complete throughput for ASK_Q");
    let wait_ms_q = tp_q["data"]["breakdown"]["waitMs"]
        .as_f64()
        .expect("expected breakdown.waitMs");
    assert!(
        wait_ms_q > 0.0,
        "elicitation question wait must be recorded in waitMs: {tp_q:?}"
    );

    // Cancellation is a JSON-RPC result; Stop/crash settle the outstanding card
    // before terminal events, also when AcpIo is attached through the broker.
    for action in ["cancel", "stop", "crash"] {
        let run_id = format!("question-{action}-{remote}");
        let mut req = base_req(&ws, Some("auto"));
        req.prompt = if action == "crash" { "ASK_Q_CRASH" } else { "ASK_Q" }.into();
        let mut built = engine.build_command(&req, &bin).unwrap();
        built.command.env("ANTIGRAVITY_APP_DATA_DIR", &fixture.root);
        let (core, registry, events, killed) = make_turn_core(&run_id, 4_100_000_005);
        let entry = registry.get(&run_id).unwrap();
        let app = question_test_app(registry, Arc::clone(&service), &events);
        let watch_events = Arc::clone(&events);
        let stop = Arc::clone(&killed);
        let answer_run = run_id.clone();
        let respond = tokio::spawn(async move {
            for _ in 0..200 {
                let request_id = watch_events.0.lock().unwrap().iter()
                    .find(|e| e["kind"] == "question")
                    .and_then(|e| e["data"]["requestId"].as_str().map(str::to_string));
                if let Some(request_id) = request_id {
                    if action == "cancel" {
                        crate::engine::answer_question_inner(&app, answer_run, request_id, None).await.unwrap();
                    } else if action == "stop" {
                        stop.store(true, Ordering::SeqCst);
                    }
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            panic!("question did not arrive for {action}");
        });
        tokio::time::timeout(Duration::from_secs(10), run_acp_turn(
            core, req, bin.clone(), built, Arc::clone(&service), killed, 4_100_000_005,
        )).await.expect("question lifecycle hung");
        respond.await.unwrap();
        let ev = events.0.lock().unwrap().clone();
        assert!(entry.questions.lock().unwrap().is_empty());
        assert!(super::send_run_frame(&run_id, json!({})).await.is_err());
        if action == "cancel" {
            assert!(ev.iter().any(|e| e["kind"] == "delta" && e["data"].as_str().unwrap_or("").contains("\"action\":\"cancel\"")), "{ev:?}");
        } else {
            let settled = ev.iter().position(|e| e["kind"] == "question_settled").expect("pending question must settle");
            let terminal = ev.iter().position(|e| e["kind"] == if action == "crash" { "error" } else { "done" }).unwrap();
            assert!(settled < terminal, "{ev:?}");
        }
    }

    service.kill_spawned();
    desktop.kill_spawned();
}

fn question_test_app(
    processes: Arc<ProcessRegistry>,
    agy_acp: Arc<AgyAcpState>,
    emitter: &Arc<CollectingEmitter>,
) -> crate::AppState {
    let emitters = crate::event_sink::BroadcastEmit::new(emitter.clone());
    crate::AppState {
        db: Arc::new(crate::db::Db::open_in_memory().unwrap()),
        sink: EventSink::new(emitters.clone()),
        terminal_sink: EventSink::new(emitters.clone()),
        plugin_sink: EventSink::new(emitters.clone()),
        mission_sink: EventSink::new(emitters.clone()),
        emitters,
        terminals: Default::default(),
        processes,
        web: Default::default(),
        relay: Default::default(),
        dsh_host: Arc::new(Default::default()),
        opencode_server: Arc::new(Default::default()),
        agy_acp,
        worktree_creations: Default::default(),
    }
}

#[tokio::test]
async fn background_tracker_preserves_daemon_metadata_and_tracks_schedule_subagent_and_kill() {
    let root = std::env::temp_dir().join(format!("agy-tracker-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let sid = "tracker-session";
    let mut req = base_req(&root, Some("auto"));
    req.session_id = Some(sid.into());
    let mut built = AgyEngine::new().build_command(&req, "fake-agy").unwrap();
    built.command.env("ANTIGRAVITY_APP_DATA_DIR", &root);
    let launch = extract_launch("tracker", &req, "fake-agy", built).unwrap();
    let mut tracker = super::support::AgyAcpTaskTracker::new(&launch.profile, sid, Some(0));
    let (core, _, _, _) = make_turn_core("tracker", 4_100_000_006);
    let mut state = crate::engine::TurnState::new(Some(sid.into()));
    tracker.on_tool_started("daemon", "run_command", Some(&json!({"CommandLine":"pnpm dev", "IsDaemon":true, "toolSummary":"Dev server"})));
    let running = "Tool is running as a background task with task id: tracker-session/task-daemon\nTask Description: pnpm dev\n";
    tracker.on_tool_completed(&core, &mut state, "daemon", Some(&json!(running)), false);
    tracker.on_tool_started("cron", "schedule", Some(&json!({"Prompt":"Check build", "DurationSeconds":1})));
    let logs = root.join("brain").join(sid).join(".system_generated/logs");
    std::fs::create_dir_all(&logs).unwrap();
    let transcript = logs.join("transcript.jsonl");
    std::fs::write(&transcript, format!("{}\n", json!({"type":"TOOL_RESPONSE","status":"RUNNING","content":running}))).unwrap();
    tracker.poll(&core, &mut state);
    assert_eq!(state.tasks[0].ambient, Some(true));
    assert_eq!(state.tasks[0].description, "Dev server");
    // A duplicate transcript row must not steal the next schedule candidate.
    tracker.on_tool_completed(&core, &mut state, "cron", Some(&json!("Tool is running as a background task with task id: tracker-session/task-cron")), false);
    assert_eq!(state.tasks[1].kind, "monitor");
    tracker.on_tool_started("child", "invoke_subagent", Some(&json!({"Role":"Reviewer", "Prompt":"Review"})));
    tracker.on_tool_completed(&core, &mut state, "child", Some(&json!({"conversationId":"child-session"})), false);
    assert_eq!(state.tasks[2].kind, "subagent");
    tracker.on_tool_started("kill", "manage_task", Some(&json!({"Action":"kill", "TaskId":"task-cron"})));
    tracker.on_tool_completed(&core, &mut state, "kill", Some(&json!("killed")), false);
    assert_eq!(state.tasks[1].status, "stopped");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
    writeln!(file, "{}", json!({"type":"SYSTEM_MESSAGE","content":"<SYSTEM_MESSAGE sender=child-session>failed with error</SYSTEM_MESSAGE>"})).unwrap();
    tracker.poll(&core, &mut state);
    assert_eq!(state.tasks[2].status, "failed");
    assert!(tracker.has_pending_wakeup());
    assert!(!tracker.has_running_non_ambient());
    tracker.mark_running_stopped(&core, &mut state);
    assert_eq!(state.tasks[0].status, "stopped");
    drop(file);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn background_tracker_extracts_short_names_from_planner_tool_calls_and_acp_updates() {
    use std::io::Write;

    let root = std::env::temp_dir().join(format!("agy-name-test-{}", uuid::Uuid::new_v4()));
    let sid = "planner-sid";
    let logs = root.join("brain").join(sid).join(".system_generated/logs");
    std::fs::create_dir_all(&logs).unwrap();
    let transcript = logs.join("transcript.jsonl");
    std::fs::write(&transcript, "").unwrap();

    let mut req = base_req(&root, Some("auto"));
    req.session_id = Some(sid.into());
    let mut built = AgyEngine::new().build_command(&req, "fake-agy").unwrap();
    built.command.env("ANTIGRAVITY_APP_DATA_DIR", &root);
    let launch = extract_launch("name-extract", &req, "fake-agy", built).unwrap();
    let mut tracker = super::support::AgyAcpTaskTracker::new(&launch.profile, sid, Some(0));
    let (core, _, _, _) = make_turn_core("name-extract", 4_100_000_011);
    let mut state = crate::engine::TurnState::new(Some(sid.into()));

    // 1. Transcript PLANNER_RESPONSE.tool_calls carries JSON-stringified args + toolSummary.
    let long_py = "python -c \"import re, itertools; data = open('agy.exe')\"";
    let mut file = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
    writeln!(
        file,
        "{}",
        json!({
            "step_index": 1,
            "source": "MODEL",
            "type": "PLANNER_RESPONSE",
            "status": "DONE",
            "tool_calls": [{
                "name": "run_command",
                "args": {
                    "CommandLine": serde_json::to_string(long_py).unwrap(),
                    "WaitMsBeforeAsync": "5000",
                    "toolSummary": "\"Inspect agy ACP strings\"",
                    "IsDaemon": "true"
                }
            }]
        })
    )
    .unwrap();
    writeln!(
        file,
        "{}",
        json!({
            "step_index": 2,
            "source": "MODEL",
            "type": "GENERIC",
            "status": "RUNNING",
            "content": format!(
                "Created At: 2026-11-14T05:23:21+08:00\nTool is running as a background task with task id: {sid}/task-50\nTask Description: {long_py}\n"
            )
        })
    )
    .unwrap();
    tracker.poll(&core, &mut state);
    assert_eq!(state.tasks.len(), 1);
    assert_eq!(state.tasks[0].id, "task-50");
    assert_eq!(state.tasks[0].description, "Inspect agy ACP strings");
    assert_eq!(state.tasks[0].summary.as_deref(), Some(long_py));
    assert_eq!(state.tasks[0].ambient, Some(true));

    // 2. ACP display title ("Terminal", kind "execute") + late in_progress tool_call_update rawInput.
    tracker.observe_session_update(&json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "tc-term",
        "title": "Terminal",
        "kind": "execute",
        "status": "pending",
        "rawInput": {}
    }));
    tracker.observe_session_update(&json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "tc-term",
        "status": "in_progress",
        "rawInput": {
            "CommandLine": "npm --prefix C:\\Projects\\ccgui-custom run build",
            "toolSummary": "Frontend package build"
        }
    }));
    tracker.on_tool_completed(
        &core,
        &mut state,
        "tc-term",
        Some(&json!(format!(
            "Tool is running as a background task with task id: {sid}/task-51\nTask Description: npm --prefix C:\\Projects\\ccgui-custom run build\n"
        ))),
        false,
    );
    assert_eq!(state.tasks.len(), 2);
    assert_eq!(state.tasks[1].id, "task-51");
    assert_eq!(state.tasks[1].description, "Frontend package build");
    assert_eq!(
        state.tasks[1].summary.as_deref(),
        Some("npm --prefix C:\\Projects\\ccgui-custom run build")
    );

    // 3. Bare long command without toolSummary compacts head cleanly instead of dumping full inline code.
    let huge_py = format!("python -c \"import sys; print('{}')\"", "x".repeat(200));
    tracker.observe_session_update(&json!({
        "sessionUpdate": "tool_call",
        "toolCallId": "tc-bare",
        "title": "Terminal",
        "kind": "execute",
        "status": "in_progress",
        "rawInput": { "CommandLine": huge_py }
    }));
    tracker.on_tool_completed(
        &core,
        &mut state,
        "tc-bare",
        Some(&json!(format!(
            "Tool is running as a background task with task id: {sid}/task-52\nTask Description: {huge_py}\n"
        ))),
        false,
    );
    assert_eq!(state.tasks.len(), 3);
    assert_eq!(state.tasks[2].id, "task-52");
    assert_eq!(state.tasks[2].description, "python -c");
    assert!(state.tasks[2].summary.as_deref().unwrap_or("").starts_with("python -c"));

    drop(file);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn background_tracker_ignores_phantom_task_markers_in_tool_outputs_and_foreign_sessions() {
    use std::io::Write;

    let root = std::env::temp_dir().join(format!("agy-phantom-test-{}", uuid::Uuid::new_v4()));
    let sid = "real-session";
    let logs = root.join("brain").join(sid).join(".system_generated/logs");
    std::fs::create_dir_all(&logs).unwrap();
    let transcript = logs.join("transcript.jsonl");
    std::fs::write(&transcript, "").unwrap();

    let mut req = base_req(&root, Some("auto"));
    req.session_id = Some(sid.into());
    let mut built = AgyEngine::new().build_command(&req, "fake-agy").unwrap();
    built.command.env("ANTIGRAVITY_APP_DATA_DIR", &root);
    let launch = extract_launch("phantom-guard", &req, "fake-agy", built).unwrap();
    let mut tracker = super::support::AgyAcpTaskTracker::new(&launch.profile, sid, Some(0));
    let (core, _, _, _) = make_turn_core("phantom-guard", 4_100_000_012);
    let mut state = crate::engine::TurnState::new(Some(sid.into()));

    let mut file = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
    // 1. Grep output quoting `tracker-session/task-cron` from source tests.
    writeln!(
        file,
        "{}",
        json!({
            "step_index": 1,
            "source": "MODEL",
            "type": "GENERIC",
            "status": "DONE",
            "content": "Created At: 2026-11-14T05:20:35+08:00\nCompleted At: 2026-11-14T05:20:36+08:00\nC:/Projects/ccgui-custom/src-tauri/src/engine/agy_acp_tests.rs\n2019: tracker.on_tool_completed(&core, &mut state, \"cron\", Some(&json!(\"Tool is running as a background task with task id: tracker-session/task-cron\")), false);"
        })
    )
    .unwrap();
    // 2. read_file output starting with Showing lines and containing own session id marker.
    writeln!(
        file,
        "{}",
        json!({
            "step_index": 2,
            "source": "MODEL",
            "type": "GENERIC",
            "status": "DONE",
            "content": format!("Created At: 2026-11-14T05:21:00+08:00\nCompleted At: 2026-11-14T05:21:01+08:00\nShowing lines 1-50 of 200\nTool is running as a background task with task id: {sid}/task-fake")
        })
    )
    .unwrap();
    // 4. Transcript RUNNING step belonging to a foreign session id.
    writeln!(
        file,
        "{}",
        json!({
            "step_index": 3,
            "source": "MODEL",
            "type": "GENERIC",
            "status": "RUNNING",
            "content": "Created At: 2026-11-14T05:21:02+08:00\nTool is running as a background task with task id: other-session/task-99\n"
        })
    )
    .unwrap();
    // 5. USER_INPUT step containing a pasted receipt marker.
    writeln!(
        file,
        "{}",
        json!({
            "step_index": 4,
            "source": "USER_EXPLICIT",
            "type": "USER_INPUT",
            "status": "DONE",
            "content": format!("Tool is running as a background task with task id: {sid}/task-user")
        })
    )
    .unwrap();
    tracker.poll(&core, &mut state);

    // 3. Synchronous ACP tool output echoing the marker under a Completed At header.
    tracker.on_tool_started(
        "sync-echo",
        "run_command",
        Some(&json!({ "CommandLine": "echo test", "toolSummary": "Echo test" })),
    );
    tracker.on_tool_completed(
        &core,
        &mut state,
        "sync-echo",
        Some(&json!(format!(
            "Created At: 2026-11-14T05:21:05+08:00\nCompleted At: 2026-11-14T05:21:05+08:00\nTool is running as a background task with task id: {sid}/task-echo\n"
        ))),
        false,
    );

    assert!(state.tasks.is_empty(), "phantom tasks adopted: {:?}", state.tasks);
    assert!(!tracker.has_running_non_ambient());

    drop(file);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn background_tracker_settles_tasks_on_server_restart_notice_and_manage_subagents() {
    use std::io::Write;

    let root = std::env::temp_dir().join(format!("agy-restart-test-{}", uuid::Uuid::new_v4()));
    let sid = "restart-session";
    let logs = root.join("brain").join(sid).join(".system_generated/logs");
    std::fs::create_dir_all(&logs).unwrap();
    let transcript = logs.join("transcript.jsonl");
    std::fs::write(&transcript, "").unwrap();

    let mut req = base_req(&root, Some("auto"));
    req.session_id = Some(sid.into());
    let mut built = AgyEngine::new().build_command(&req, "fake-agy").unwrap();
    built.command.env("ANTIGRAVITY_APP_DATA_DIR", &root);
    let launch = extract_launch("restart-tracker", &req, "fake-agy", built).unwrap();
    let mut tracker = super::support::AgyAcpTaskTracker::new(&launch.profile, sid, Some(0));
    let (core, _, _, _) = make_turn_core("restart-tracker", 4_100_000_013);
    let mut state = crate::engine::TurnState::new(Some(sid.into()));

    tracker.on_tool_started(
        "tc-cmd",
        "run_command",
        Some(&json!({ "CommandLine": "cargo build", "toolSummary": "Cargo build", "IsDaemon": false })),
    );
    tracker.on_tool_completed(
        &core,
        &mut state,
        "tc-cmd",
        Some(&json!(format!(
            "Tool is running as a background task with task id: {sid}/task-cmd\nTask Description: cargo build\n"
        ))),
        false,
    );
    tracker.on_tool_started(
        "tc-daemon",
        "run_command",
        Some(&json!({ "CommandLine": "pnpm dev", "toolSummary": "Dev daemon", "IsDaemon": true })),
    );
    tracker.on_tool_completed(
        &core,
        &mut state,
        "tc-daemon",
        Some(&json!(format!(
            "Tool is running as a background task with task id: {sid}/task-daemon\nTask Description: pnpm dev\n"
        ))),
        false,
    );
    tracker.on_tool_started(
        "tc-sub-1",
        "invoke_subagent",
        Some(&json!({ "Role": "Searcher 1", "Prompt": "Search 1" })),
    );
    tracker.on_tool_completed(
        &core,
        &mut state,
        "tc-sub-1",
        Some(&json!({ "conversationId": "sub-1" })),
        false,
    );
    tracker.on_tool_started(
        "tc-sub-2",
        "invoke_subagent",
        Some(&json!({ "Role": "Searcher 2", "Prompt": "Search 2" })),
    );
    tracker.on_tool_completed(
        &core,
        &mut state,
        "tc-sub-2",
        Some(&json!({ "conversationId": "sub-2" })),
        false,
    );

    // 1. manage_subagents kill targeted id stops only sub-1.
    tracker.on_tool_started(
        "tc-kill-one",
        "manage_subagents",
        Some(&json!({ "Action": "kill", "ConversationIds": ["sub-1"] })),
    );
    tracker.on_tool_completed(&core, &mut state, "tc-kill-one", Some(&json!("killed")), false);
    assert_eq!(state.tasks.iter().find(|t| t.id == "sub-1").unwrap().status, "stopped");
    assert_eq!(state.tasks.iter().find(|t| t.id == "sub-2").unwrap().status, "running");

    // 2. manage_subagents kill_all stops remaining subagents.
    tracker.on_tool_started(
        "tc-kill-all",
        "manage_subagents",
        Some(&json!({ "Action": "kill_all" })),
    );
    tracker.on_tool_completed(&core, &mut state, "tc-kill-all", Some(&json!("killed all")), false);
    assert_eq!(state.tasks.iter().find(|t| t.id == "sub-2").unwrap().status, "stopped");

    // 3. Global server-restart SYSTEM_MESSAGE stops both running command and daemon tasks cleanly.
    let mut file = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
    writeln!(
        file,
        "{}",
        json!({
            "type": "SYSTEM_MESSAGE",
            "source": "SYSTEM",
            "status": "DONE",
            "content": "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-13T21:48:07Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>"
        })
    )
    .unwrap();
    tracker.poll(&core, &mut state);

    assert_eq!(state.tasks.iter().find(|t| t.id == "task-cmd").unwrap().status, "stopped");
    assert_eq!(state.tasks.iter().find(|t| t.id == "task-daemon").unwrap().status, "stopped");
    assert!(!tracker.has_running_non_ambient());
    assert!(!tracker.has_pending_wakeup());

    drop(file);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn ambient_tasks_survive_only_successful_agy_completion() {
    for (engine, error, expected) in [("agy", false, "running"), ("agy", true, "unknown"), ("claude", false, "unknown")] {
        let (mut core, _, _, _) = make_turn_core(&format!("ambient-{engine}-{error}"), 4_100_000_007);
        core.engine_id = engine.into();
        let mut state = crate::engine::TurnState::new(None);
        core.dispatch_event(&mut state, crate::engine::EngineEvent::Tasks(vec![crate::engine::events::NativeTask {
            id: "daemon".into(), kind: "command".into(), description: "dev server".into(),
            status: "running".into(), tool_use_id: None, summary: None, progress: None,
            background: Some(true), ambient: Some(true),
            started_at: None, last_progress_at: None,
        }]));
        core.dispatch_event(&mut state, if error {
            crate::engine::EngineEvent::Error("daemon disconnected".into())
        } else {
            crate::engine::EngineEvent::Done { session_id: None, usage: None }
        });
        assert_eq!(state.tasks[0].status, expected);
    }
}

#[test]
fn telemetry_calibrates_authoritative_transcript_steps_and_avoids_tool_double_counting() {
    use std::io::Write;
    use std::time::Instant;

    let root = std::env::temp_dir().join(format!("agy-tps-cal-test-{}", uuid::Uuid::new_v4()));
    let sid = "tps-cal-session";
    let logs = root.join("brain").join(sid).join(".system_generated/logs");
    std::fs::create_dir_all(&logs).unwrap();
    let transcript = logs.join("transcript.jsonl");
    std::fs::write(&transcript, "").unwrap();

    let mut req = base_req(&root, Some("auto"));
    req.session_id = Some(sid.into());
    let mut built = AgyEngine::new().build_command(&req, "fake-agy").unwrap();
    built.command.env("ANTIGRAVITY_APP_DATA_DIR", &root);
    let launch = extract_launch("tps-cal", &req, "fake-agy", built).unwrap();
    let mut tracker = super::support::AgyAcpTaskTracker::new(&launch.profile, sid, Some(0));
    let (core, _, _, _) = make_turn_core("tps-cal", 4_100_000_008);
    let mut state = crate::engine::TurnState::new(Some(sid.into()));

    let t0 = Instant::now();
    let mut telemetry = super::driver::AgyAcpTelemetry::new(t0);
    let prompt_at = t0 + Duration::from_millis(40);
    telemetry.mark_prompt_sent(prompt_at);

    // 1. Condensed thought plus a large tool input before transcript flushes.
    telemetry.on_model_delta("plan", prompt_at + Duration::from_millis(200));
    let large_payload = json!({
        "TargetFile": "src/example.rs",
        "CodeContent": "fn demo() {}\n".repeat(40),
    });
    telemetry.on_tool_start(
        "tc-1",
        "write_to_file",
        Some(&large_payload),
        prompt_at + Duration::from_millis(300),
    );
    telemetry.on_tool_end("tc-1", prompt_at + Duration::from_millis(400));

    // Before transcript commits step 1, live estimate includes the streamed tool arguments.
    telemetry.on_model_delta("!", prompt_at + Duration::from_millis(1200));
    let pre_commit_live = telemetry
        .live_sample(prompt_at + Duration::from_millis(1200))
        .expect("expected live sample before transcript flush");
    let pre_tokens = pre_commit_live["liveEstimate"]["outputTokens"].as_u64().unwrap();
    assert!(
        pre_tokens > 40,
        "tool input args must contribute to liveEstimate before transcript calibration: {pre_commit_live:?}"
    );

    // 2. Transcript commits step 1 with authoritative output_tokens = 977.
    let mut file = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
    writeln!(
        file,
        "{}",
        json!({
            "step_index": 1,
            "source": "MODEL",
            "type": "PLANNER_RESPONSE",
            "status": "DONE",
            "output_tokens": 977
        })
    )
    .unwrap();
    let committed = tracker.poll(&core, &mut state);
    assert_eq!(committed, vec![977]);
    let running = telemetry
        .on_authoritative_steps(&committed, prompt_at + Duration::from_millis(1500))
        .expect("expected authoritative running sample");
    assert_eq!(running["status"], "running");
    assert_eq!(running["outputTokens"], 977);
    assert_eq!(running["elapsedMs"], 1400.0);
    assert_eq!(running["breakdown"]["toolMs"], 100.0);
    assert_eq!(running["breakdown"]["modelMs"], 1400.0);

    // Repeated poll or duplicate step_index must not emit or double-count.
    writeln!(
        file,
        "{}",
        json!({
            "step_index": 1,
            "source": "MODEL",
            "type": "PLANNER_RESPONSE",
            "status": "DONE",
            "output_tokens": 977
        })
    )
    .unwrap();
    assert!(tracker.poll(&core, &mut state).is_empty());

    // A tool started in the same already-committed step must not add inflight tokens.
    telemetry.on_tool_start(
        "tc-2",
        "read_file",
        Some(&large_payload),
        prompt_at + Duration::from_millis(1550),
    );
    telemetry.on_tool_end("tc-2", prompt_at + Duration::from_millis(1650));

    // Step 2 streams 2 CJK chars on top of authoritative 977.
    telemetry.on_model_delta("你好", prompt_at + Duration::from_millis(2700));
    let step2_live = telemetry
        .live_sample(prompt_at + Duration::from_millis(2700))
        .expect("expected live sample in step 2");
    assert_eq!(step2_live["liveEstimate"]["outputTokens"], 979);

    drop(file);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn telemetry_partitions_question_and_retry_waits_and_caps_finish_at_prompt_end() {
    use std::time::Instant;

    let t0 = Instant::now();
    let mut telemetry = super::driver::AgyAcpTelemetry::new(t0);
    telemetry.mark_prompt_sent(t0 + Duration::from_millis(50));

    // Partial failed attempt before 503 retry wait (inflight must be discarded on retry).
    telemetry.on_model_delta("discarded partial text", t0 + Duration::from_millis(150));
    telemetry.on_retry_wait_start(t0 + Duration::from_millis(250));
    // Retry wait ends at +750ms => 500ms wait.
    telemetry.on_model_delta("recovered", t0 + Duration::from_millis(750));

    // Question wait nested inside a tool call: tool [950, 2300] (1350ms span), wait [1000, 2000] (1000ms).
    telemetry.on_tool_start("tc-q", "ask_question", None, t0 + Duration::from_millis(950));
    telemetry.on_question_wait_start("ask-1", t0 + Duration::from_millis(1000));
    telemetry.on_question_wait_end(Some("ask-1"), true, t0 + Duration::from_millis(2000));
    telemetry.on_tool_end("tc-q", t0 + Duration::from_millis(2300));

    // Prompt ends at +3000ms, followed by 1500ms of post-prompt close/SQLite work.
    telemetry.mark_prompt_finished(t0 + Duration::from_millis(3000));
    let sample = telemetry
        .finish(
            false,
            Some(&json!({ "output_tokens": 110 })),
            t0 + Duration::from_millis(4500),
        )
        .expect("expected complete sample");

    assert_eq!(sample["status"], "complete");
    assert!(sample["turnReason"].is_null(), "{sample:?}");
    let b = &sample["breakdown"];
    assert_eq!(b["wallMs"], 3000.0);
    assert_eq!(b["startupMs"], 50.0);
    assert_eq!(b["waitMs"], 1500.0);
    assert_eq!(b["toolMs"], 350.0);
    assert_eq!(b["modelMs"], 1100.0);
    assert_eq!(sample["elapsedMs"], 1100.0);
    assert_eq!(sample["outputTokens"], 110);
}

#[tokio::test]
async fn background_tracker_records_started_at_and_advances_last_progress_on_log_growth() {
    use std::io::Write;

    let root = std::env::temp_dir().join(format!("agy-stall-ts-test-{}", uuid::Uuid::new_v4()));
    let sid = "stall-ts-session";
    let logs = root.join("brain").join(sid).join(".system_generated/logs");
    let tasks_dir = root.join("brain").join(sid).join(".system_generated/tasks");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::create_dir_all(&tasks_dir).unwrap();
    let transcript = logs.join("transcript.jsonl");
    std::fs::write(&transcript, "").unwrap();
    let task_log = tasks_dir.join("task-453.log");
    std::fs::write(&task_log, "").unwrap();

    let mut req = base_req(&root, Some("auto"));
    req.session_id = Some(sid.into());
    let mut built = AgyEngine::new().build_command(&req, "fake-agy").unwrap();
    built.command.env("ANTIGRAVITY_APP_DATA_DIR", &root);
    let launch = extract_launch("stall-ts-tracker", &req, "fake-agy", built).unwrap();
    let mut tracker = super::support::AgyAcpTaskTracker::new(&launch.profile, sid, Some(0));
    let (core, _, emitter, _) = make_turn_core("stall-ts-tracker", 4_100_000_021);
    let mut state = crate::engine::TurnState::new(Some(sid.into()));

    tracker.on_tool_started(
        "tc-453",
        "run_command",
        Some(&json!({ "CommandLine": "node --test", "toolSummary": "Node tests", "IsDaemon": false })),
    );
    tracker.on_tool_completed(
        &core,
        &mut state,
        "tc-453",
        Some(&json!(format!(
            "Tool is running as a background task with task id: {sid}/task-453\nTask Description: node --test\n"
        ))),
        false,
    );

    assert_eq!(state.tasks.len(), 1);
    let initial_started = state.tasks[0].started_at.expect("started_at set on adoption");
    let initial_progress_at = state.tasks[0]
        .last_progress_at
        .expect("last_progress_at set on adoption");
    assert_eq!(initial_progress_at, initial_started);
    core.sink.flush();
    let emitted_after_adopt = emitter.0.lock().unwrap().len();

    // Unchanged empty log after a short wait must not refresh last_progress_at or emit duplicate events.
    std::thread::sleep(Duration::from_millis(20));
    tracker.poll(&core, &mut state);
    core.sink.flush();
    assert_eq!(emitter.0.lock().unwrap().len(), emitted_after_adopt);
    assert_eq!(state.tasks[0].started_at, Some(initial_started));
    assert_eq!(state.tasks[0].last_progress_at, Some(initial_progress_at));

    // Replaying the same task in transcript must preserve original started_at.
    {
        let mut tfile = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
        writeln!(
            tfile,
            "{}",
            json!({
                "type": "GENERIC",
                "status": "RUNNING",
                "content": format!("Background command running with id {sid}/task-453")
            })
        )
        .unwrap();
    }
    tracker.poll(&core, &mut state);
    assert_eq!(state.tasks[0].started_at, Some(initial_started));
    assert_eq!(state.tasks[0].last_progress_at, Some(initial_progress_at));

    // Appending new output to task-453.log advances last_progress_at and emits updated progress.
    std::thread::sleep(Duration::from_millis(20));
    {
        let mut lfile = std::fs::OpenOptions::new().append(true).open(&task_log).unwrap();
        writeln!(lfile, "ok 1 - initial suite").unwrap();
    }
    tracker.poll(&core, &mut state);
    core.sink.flush();
    assert!(emitter.0.lock().unwrap().len() > emitted_after_adopt);
    assert_eq!(state.tasks[0].started_at, Some(initial_started));
    let updated_progress_at = state.tasks[0].last_progress_at.unwrap();
    assert!(updated_progress_at > initial_progress_at);
    assert_eq!(state.tasks[0].progress.as_deref(), Some("ok 1 - initial suite"));

    // Polling again while log length is unchanged keeps updated_progress_at stable.
    let emitted_after_growth = emitter.0.lock().unwrap().len();
    std::thread::sleep(Duration::from_millis(20));
    tracker.poll(&core, &mut state);
    core.sink.flush();
    assert_eq!(emitter.0.lock().unwrap().len(), emitted_after_growth);
    assert_eq!(state.tasks[0].last_progress_at, Some(updated_progress_at));

    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn background_tracker_handles_schedule_normal_reverse_and_fallback_cleanly() {
    use std::io::Write;

    let root = std::env::temp_dir().join(format!("agy-sched-test-{}", uuid::Uuid::new_v4()));
    let sid = "sched-session";
    let logs = root.join("brain").join(sid).join(".system_generated/logs");
    std::fs::create_dir_all(&logs).unwrap();
    let transcript = logs.join("transcript.jsonl");
    std::fs::write(&transcript, "").unwrap();

    let mut req = base_req(&root, Some("auto"));
    req.session_id = Some(sid.into());
    let mut built = AgyEngine::new().build_command(&req, "fake-agy").unwrap();
    built.command.env("ANTIGRAVITY_APP_DATA_DIR", &root);
    let launch = extract_launch("sched-tracker", &req, "fake-agy", built).unwrap();
    let mut tracker = super::support::AgyAcpTaskTracker::new(&launch.profile, sid, Some(0));
    let (core, _, _, _) = make_turn_core("sched-tracker", 4_100_000_031);
    let mut state = crate::engine::TurnState::new(Some(sid.into()));

    {
        let mut f = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
        // Normal order: PLANNER_RESPONSE before GENERIC(RUNNING) without Task logs footer.
        writeln!(
            f,
            "{}",
            json!({
                "type": "PLANNER_RESPONSE",
                "tool_calls": [{
                    "id": "call-sched-1",
                    "name": "schedule",
                    "args": { "DurationSeconds": 150, "Prompt": "等待构建并汇报结果" }
                }]
            })
        )
        .unwrap();
        writeln!(
            f,
            "{}",
            json!({
                "type": "GENERIC",
                "status": "RUNNING",
                "content": format!("Tool is running as a background task with task id: {sid}/task-s1\nTask Description: Timer: 2m 30s, condition: never\nPrompt: 等待构建并汇报结果")
            })
        )
        .unwrap();

        // Reverse order: GENERIC(RUNNING) arrives without Prompt first, then late PLANNER_RESPONSE upgrades it.
        writeln!(
            f,
            "{}",
            json!({
                "type": "GENERIC",
                "status": "RUNNING",
                "content": format!("Tool is running as a background task with task id: {sid}/task-s2\nTask Description: Timer: 2m 30s, condition: never")
            })
        )
        .unwrap();
    }
    tracker.poll(&core, &mut state);

    assert_eq!(state.tasks.len(), 2);
    assert_eq!(state.tasks[0].kind, "monitor");
    assert_eq!(state.tasks[0].description, "等待构建并汇报结果");
    assert_eq!(state.tasks[1].kind, "monitor");
    assert_eq!(state.tasks[1].description, "Timer: 2m 30s");

    {
        let mut f = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
        writeln!(
            f,
            "{}",
            json!({
                "type": "PLANNER_RESPONSE",
                "tool_calls": [{
                    "name": "schedule",
                    "args": { "DurationSeconds": 150, "Prompt": "复检定时结果" }
                }]
            })
        )
        .unwrap();
        // Pure fallback with Prompt and Cron list fallback without Prompt.
        writeln!(
            f,
            "{}",
            json!({
                "type": "GENERIC",
                "status": "RUNNING",
                "content": format!("Tool is running as a background task with task id: {sid}/task-s3\nTask Description: Timer: 1m, condition: never\nPrompt: 等待发布窗口\nTask logs are available at: /logs")
            })
        )
        .unwrap();
        writeln!(
            f,
            "{}",
            json!({
                "type": "GENERIC",
                "status": "RUNNING",
                "content": format!("Tool is running as a background task with task id: {sid}/task-s4\nTask Description: Cron: 0,30 * * * *, max_iterations: 2")
            })
        )
        .unwrap();
    }
    tracker.poll(&core, &mut state);

    assert_eq!(state.tasks[1].description, "复检定时结果");
    assert_eq!(state.tasks[2].kind, "monitor");
    assert_eq!(state.tasks[2].description, "等待发布窗口");
    assert_eq!(state.tasks[3].kind, "monitor");
    assert_eq!(state.tasks[3].description, "Cron: 0,30 * * * *");

    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn background_tracker_unwraps_escaped_pwsh_wrapper_and_preserves_python_dash_c() {
    use std::io::Write;

    let root = std::env::temp_dir().join(format!("agy-unwrap-test-{}", uuid::Uuid::new_v4()));
    let sid = "unwrap-session";
    let logs = root.join("brain").join(sid).join(".system_generated/logs");
    std::fs::create_dir_all(&logs).unwrap();
    let transcript = logs.join("transcript.jsonl");
    std::fs::write(&transcript, "").unwrap();

    let mut req = base_req(&root, Some("auto"));
    req.session_id = Some(sid.into());
    let mut built = AgyEngine::new().build_command(&req, "fake-agy").unwrap();
    built.command.env("ANTIGRAVITY_APP_DATA_DIR", &root);
    let launch = extract_launch("unwrap-tracker", &req, "fake-agy", built).unwrap();
    let mut tracker = super::support::AgyAcpTaskTracker::new(&launch.profile, sid, Some(0));
    let (core, _, _, _) = make_turn_core("unwrap-tracker", 4_100_000_032);
    let mut state = crate::engine::TurnState::new(Some(sid.into()));

    {
        let mut f = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
        writeln!(
            f,
            "{}",
            json!({
                "type": "GENERIC",
                "status": "RUNNING",
                "content": format!("Tool is running as a background task with task id: {sid}/task-u1\nTask Description: \\\"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe\\\" -NoProfile -Command \\\"python 'C:\\\\Projects\\\\sample-app\\\\scripts\\\\verify.py' --fast\\\"")
            })
        )
        .unwrap();
        writeln!(
            f,
            "{}",
            json!({
                "type": "GENERIC",
                "status": "RUNNING",
                "content": format!("Tool is running as a background task with task id: {sid}/task-u2\nTask Description: \"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe\" -Command \"python 'C:\\\\Projects\\\\sample-app\\\\tests\\\\subagent_check.py' --fast\"")
            })
        )
        .unwrap();
        writeln!(
            f,
            "{}",
            json!({
                "type": "GENERIC",
                "status": "RUNNING",
                "content": format!("Tool is running as a background task with task id: {sid}/task-u3\nTask Description: cmd /c \"bash -lc \\\"cargo test --manifest-path C:\\\\Projects\\\\sample-app\\\\src-tauri\\\\Cargo.toml --lib agy_acp\\\"\"")
            })
        )
        .unwrap();
        writeln!(
            f,
            "{}",
            json!({
                "type": "GENERIC",
                "status": "RUNNING",
                "content": format!("Tool is running as a background task with task id: {sid}/task-u4\nTask Description: python -c \"import sys; print('long diagnostic output for regression test')\"")
            })
        )
        .unwrap();
    }
    tracker.poll(&core, &mut state);

    assert_eq!(state.tasks.len(), 4);
    assert_eq!(state.tasks[0].description, "python verify.py --fast");
    assert_eq!(state.tasks[1].description, "python subagent_check.py --fast");
    assert_eq!(state.tasks[2].description, "cargo test --lib");
    assert_eq!(state.tasks[3].description, "python -c");

    std::fs::remove_dir_all(root).unwrap();
}
