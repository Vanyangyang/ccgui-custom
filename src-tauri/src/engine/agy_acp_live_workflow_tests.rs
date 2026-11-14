//! Opt-in smoke tests against an authenticated, installed AGY CLI. These use the
//! production driver and an isolated broker/profile, never the desktop's pool.
use super::*;

struct LivePool(Arc<AgyAcpState>);
impl Drop for LivePool { fn drop(&mut self) { self.0.kill_spawned(); } }

fn marker(root: &Path, name: &str) -> PathBuf { root.join(format!("{name}.json")) }
fn read_marker(root: &Path, name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(marker(root, name)).unwrap()).unwrap()
}

async fn live_turn(root: &Path, bin: &str, service: Arc<AgyAcpState>, case: &str, cancel: bool) -> Vec<Value> {
    let mut req = base_req(root, Some("bypass"));
    let script = root.join(format!("{case}.py"));
    req.prompt = format!("This is an explicitly authorized bounded runtime integration test. Call native run_workflow exactly once with ScriptPath={}, Description=\"CCGUI live {case}\", WaitMsBeforeAsync={}. Do not change the script, investigate files, delegate other work, or retry. If required, read only the builtin run-workflow skill. After a background receipt, briefly report started and end your output, waiting for the real notification. Never poll manage_task. A deliberate failure is expected, do not repair it. The host will cancel the cancel test after both heartbeats start.", serde_json::to_string(&script.to_string_lossy()).unwrap(), if case == "sync-failure" {10000} else {0});
    req.prompt = format!("[ccgui:agy-runtime-probe:v1]\n{}\n[/ccgui:agy-runtime-probe:v1]", req.prompt);
    let built = AgyEngine::new().build_command(&req, bin).unwrap();
    let (core, _, emitter, killed) = make_turn_core(&format!("live-{case}"), 4_210_000_000);
    let sink = core.sink.clone();
    let cancel_watch = if cancel {
        let root = root.to_path_buf();
        let stop = killed.clone();
        let events = emitter.clone();
        Some(tokio::spawn(async move {
            for _ in 0..3000 {
                let waiting = events.0.lock().unwrap().iter().any(|e| e["kind"] == "activity" && e["data"]["state"] == "waiting");
                if waiting && marker(&root, "alpha-heartbeat").exists() && marker(&root, "beta-heartbeat").exists() {
                    std::fs::write(marker(&root, "stop-requested"), json!({"at":crate::engine::events::now_epoch_ms()}).to_string()).unwrap();
                    stop.store(true, Ordering::SeqCst);
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            stop.store(true, Ordering::SeqCst);
            panic!("real workflow never reached two active children plus background waiting");
        }))
    } else { None };
    let result = tokio::time::timeout(Duration::from_secs(360), run_acp_turn(core, req, bin.into(), built, service, killed, 4_210_000_000)).await;
    sink.flush();
    let events = emitter.0.lock().unwrap().clone();
    let evidence: Vec<_> = events.iter().filter(|e| !matches!(e["kind"].as_str(), Some("thinking" | "throughput"))).collect();
    std::fs::write(root.join(format!("{case}-events.json")), serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    result.expect("live turn exceeded six minutes");
    if let Some(watch) = cancel_watch { watch.await.unwrap(); }
    assert!(!events.iter().any(|e| e["kind"] == "error"), "{case}: {:?}", events.iter().filter(|e| e["kind"] == "error").collect::<Vec<_>>());
    assert!(events.iter().any(|e| e["kind"] == "done"), "{case} missing terminal Done");
    events
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit CCGUI_AGY_LIVE_BIN/ROOT and consumes model quota"]
async fn agy_live_workflow_cancellation_and_failures() {
    let bin = std::env::var("CCGUI_AGY_LIVE_BIN").expect("explicit installed CLI path required");
    let root = PathBuf::from(std::env::var("CCGUI_AGY_LIVE_ROOT").expect("explicit NEW evidence directory required"));
    assert!(!root.exists(), "use a new directory so old markers cannot pass the test");
    std::fs::create_dir_all(&root).unwrap();
    let root = dunce::canonicalize(root).unwrap();
    let worker = root.join("child.py");
    std::fs::write(&worker, r#"import json, os, pathlib, sys, time
root = pathlib.Path(__file__).parent
label = sys.argv[1]
start = time.time()
def stamp(kind):
    (root / (label + '-' + kind + '.json')).write_text(json.dumps({'pid':os.getpid(),'at':time.time(),'start':start}),encoding='utf-8')
stamp('started')
print(label + ' started',flush=True)
while time.time()-start < 120:
    stamp('heartbeat')
    time.sleep(0.2)
stamp('finished')
print(label + ' finished',flush=True)
"#).unwrap();
    let header = format!("import asyncio, pathlib, sys\nroot=pathlib.Path({})\nworker={}\n", serde_json::to_string(&root.to_string_lossy()).unwrap(), serde_json::to_string(&worker.to_string_lossy()).unwrap());
    let child = r#"
def child(label):
    command = f'& "{sys.executable}" "{worker}" {label}'
    return agent(prompt=f'Authorized runtime test. Run exactly this command with native run_command and WaitMsBeforeAsync=10000: {command}. Only test marker files are written. If backgrounded, end your output and wait for the real completion notice. Only then call finish with the label {label}. No other commands, no reading, no retry, no delegation.',schema={'type':'string'},role=label,model='flash')
"#;
    std::fs::write(root.join("cancel.py"), format!("{header}{child}\nphase('two-active-agents')\nawait parallel(['alpha','beta'],child)\nprint('UNEXPECTED_AFTER_CANCEL')\n")).unwrap();
    std::fs::write(root.join("branch-failure.py"), format!("{header}{child}\nphase('branch-failure')\nasync def branch(kind):\n    if kind == 'agent':\n        return await child('sibling')\n    for _ in range(120):\n        if (root / 'sibling-started.json').exists():\n            await asyncio.sleep(2)\n            raise RuntimeError('CCGUI_EXPECTED_BRANCH_FAILURE')\n        await asyncio.sleep(1)\n    raise RuntimeError('SIBLING_NOT_STARTED')\nawait parallel(['agent','fail'],branch)\n")).unwrap();
    std::fs::write(root.join("sync-failure.py"), "raise RuntimeError('CCGUI_EXPECTED_SYNC_FAILURE')\n").unwrap();

    let pool_root = root.join("broker");
    let owner = Arc::new(AgyAcpState::with_root(pool_root.clone()));
    let _cleanup = LivePool(owner.clone());
    owner.start_broker().await.unwrap();
    let client = Arc::new(AgyAcpState::with_root(pool_root));
    eprintln!("LIVE evidence={}", root.display());
    let cancel = live_turn(&root, &bin, client.clone(), "cancel", true).await;
    let stopped = cancel.iter().rev().find(|e| e["kind"] == "tasks").unwrap();
    assert!(stopped["data"]["tasks"].as_array().unwrap().iter().all(|t| t["status"] == "stopped"));
    assert!(owner.inner.lock().unwrap().idle.is_empty(), "cancelled real ACP worker must be retired");
    for label in ["alpha","beta"] {
        let pid = read_marker(&root, &format!("{label}-started"))["pid"].as_u64().unwrap() as u32;
        assert!(crate::task_worker::process_identity(pid).is_err(), "{label} PID {pid} survived cancellation");
        let before = std::fs::read(marker(&root, &format!("{label}-heartbeat"))).unwrap();
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(std::fs::read(marker(&root, &format!("{label}-heartbeat"))).unwrap(), before);
        assert!(!marker(&root, &format!("{label}-finished")).exists());
    }
    eprintln!("LIVE cancellation PASS: both child PIDs exited, heartbeats stopped, no finished marker");
    let failed = live_turn(&root, &bin, client.clone(), "branch-failure", false).await;
    let tasks = &failed.iter().rev().find(|e| e["kind"] == "tasks").expect("real background task event")["data"]["tasks"];
    assert!(tasks.as_array().unwrap().iter().any(|t| t["status"] == "failed"), "{tasks}");
    let sibling_pid = read_marker(&root, "sibling-started")["pid"].as_u64().unwrap() as u32;
    assert!(crate::task_worker::process_identity(sibling_pid).is_err());
    assert!(!marker(&root,"sibling-finished").exists());
    eprintln!("LIVE branch failure PASS: native task failed and sibling PID exited");
    let sync = live_turn(&root, &bin, client, "sync-failure", false).await;
    assert!(sync.iter().any(|e| e["kind"] == "message" && e["data"]["result"]["isError"] == true), "missing failed tool result");
    eprintln!("LIVE synchronous failure PASS: failed tool result retained");
}
