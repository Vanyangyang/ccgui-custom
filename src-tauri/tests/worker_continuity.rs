//! Actual worker and fake CLI processes; no GUI, model endpoint, or real profile.
//! cargo test --features test-harness --test worker_continuity -- --nocapture
#![cfg(feature = "test-harness")]

use ccgui_next_lib::{
    db::Db,
    paths,
    test_harness::{worker_process_support::*, TestHarness},
};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

const WORKER: &str = "continuity-worker";
const RUN: &str = "continuity-run";
const START: &str = "continuity-start";

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn isolated_environment(command: &mut ProcessCommand, root: &Path) {
    command.env_clear();
    let mut search = vec![root.join("bin")];
    #[cfg(windows)]
    {
        let system =
            std::env::var_os("SystemRoot").expect("SystemRoot required by fixture wrappers");
        let system32 = PathBuf::from(&system).join("System32");
        search.push(system32.clone());
        search.push(system32.join("WindowsPowerShell/v1.0"));
        command.env("SystemRoot", &system).env("WINDIR", &system);
    }
    #[cfg(unix)]
    search.push(PathBuf::from("/bin"));
    command.env("PATH", std::env::join_paths(search).unwrap());
    for (key, relative) in [
        ("HOME", ""),
        ("USERPROFILE", ""),
        ("APPDATA", "appdata"),
        ("LOCALAPPDATA", "localappdata"),
        ("TEMP", "tmp"),
        ("TMP", "tmp"),
        ("CLAUDE_CONFIG_DIR", ".claude"),
        ("CODEX_HOME", ".codex"),
    ] {
        command.env(key, root.join(relative));
    }
}

fn start_args(root: &Path) -> StartArgs {
    StartArgs {
        engine: "claude".into(),
        workspace_path: root.join("ws").to_string_lossy().into_owned(),
        session_id: None,
        prompt: "fixture initial task".into(),
        image_paths: None,
        model: None,
        effort: None,
        permission: Some("manual".into()),
        provider_id: None,
        computer_use: Some(false),
        claude_ultracode: Some(false),
        claude_haiku_assist: Some(false),
        require_host_chat: true,
        require_leader: false,
    }
}

fn write_cli(fixture: &TestHarness) -> PathBuf {
    // A bounded 1 MiB follow-up cannot fit in the CLI stdin pipe while this gate
    // is closed. This creates a real accepted-but-not-completed command, without
    // inserting an execution barrier into production worker code.
    let initial = json!({"type":"system","subtype":"init","session_id":"continuity-session"});
    let delta = json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"before 中文😀"}}});
    let next = json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" after 中文😀"}}});
    #[cfg(windows)]
    let (path, script) = (fixture.root().join("bin/claude.ps1"), format!(
        "[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\r\n[IO.File]::AppendAllText('launches.txt', 'launch' + [Environment]::NewLine)\r\n[IO.File]::WriteAllText('fake.pid', [string]$PID)\r\n$null = [Console]::In.ReadLine()\r\n[Console]::Out.WriteLine('{initial}')\r\n[Console]::Out.WriteLine('{delta}')\r\n[Console]::Out.Flush()\r\nwhile (!(Test-Path 'read-release')) {{ Start-Sleep -Milliseconds 10 }}\r\nwhile ($null -ne ($line = [Console]::In.ReadLine())) {{\r\n[IO.File]::AppendAllText('followups.txt', 'followup' + [Environment]::NewLine)\r\n[Console]::Out.WriteLine('{next}')\r\n[Console]::Out.Flush()\r\n}}\r\n"));
    #[cfg(unix)]
    let (path, script) = (fixture.root().join("bin/claude"), format!(
        "#!/bin/sh\nprintf 'launch\\n' >> launches.txt\nprintf '%s' $$ > fake.pid\nIFS= read -r initial\nprintf '%s\\n' '{initial}' '{delta}'\nwhile [ ! -f read-release ]; do sleep 0.01; done\nwhile IFS= read -r line; do\nprintf 'followup\\n' >> followups.txt\nprintf '%s\\n' '{next}'\ndone\n"));
    #[cfg(windows)]
    let script = format!("\u{feff}{script}"); // Windows PowerShell 5 reads UTF-8 scripts with BOM.
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    fixture.register_cli("claude", &path).unwrap();
    dunce::canonicalize(path).unwrap()
}

fn manifest(root: &Path) -> WorkerManifest {
    let path = root
        .join("profile/runtime/task-workers")
        .join(WORKER)
        .join("manifest.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn process(pid: u32) -> Option<(PathBuf, u64)> {
    let id = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[id]),
        true,
        sysinfo::ProcessRefreshKind::everything(),
    );
    let process = system.process(id)?;
    if process.status() == sysinfo::ProcessStatus::Zombie {
        return None;
    }
    Some((
        dunce::canonicalize(process.exe()?).ok()?,
        process.start_time(),
    ))
}

fn fake_pid(root: &Path) -> Option<u32> {
    std::fs::read_to_string(root.join("ws/fake.pid"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// On assertion failure, kill only fixture-owned processes, after checking the
/// manifest identity or the fake CLI's command line against this unique root.
struct Cleanup {
    root: PathBuf,
    executable: PathBuf,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        let worker_path = self.root.join("profile/runtime/task-workers").join(WORKER);
        let worker: Option<WorkerManifest> = ["manifest.json", "manifest.retired.json"]
            .iter()
            .find_map(|name| {
                serde_json::from_slice(&std::fs::read(worker_path.join(name)).ok()?).ok()
            });
        let mut system = sysinfo::System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::everything(),
        );
        if let Some(pid) = fake_pid(&self.root) {
            if let Some(child) = system.process(sysinfo::Pid::from_u32(pid)) {
                let fake = self.root.join(if cfg!(windows) {
                    "bin/claude.ps1"
                } else {
                    "bin/claude"
                });
                if child
                    .cmd()
                    .iter()
                    .any(|part| dunce::canonicalize(part).ok().as_ref() == Some(&fake))
                {
                    child.kill();
                }
            }
        }
        if let Some(worker) = worker {
            if worker.worker_id == WORKER
                && worker.run_id == RUN
                && worker.profile == self.root.join("profile")
            {
                if let Some(child) = system.process(sysinfo::Pid::from_u32(worker.pid)) {
                    if child.start_time() == worker.process_start_time
                        && child
                            .exe()
                            .and_then(|path| dunce::canonicalize(path).ok())
                            .as_ref()
                            == Some(&self.executable)
                    {
                        child.kill();
                    }
                }
            }
        }
    }
}

async fn until(description: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {description}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

struct HelperChild(std::process::Child);
impl Drop for HelperChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

/// Invoked only by the outer fixture through this test executable. The helper
/// completely exits while its actual ccgui-next worker and native CLI continue.
#[test]
#[ignore = "subprocess entry point; outer continuity test invokes it explicitly"]
fn launcher_helper() {
    let root = PathBuf::from(
        std::env::var_os("CCGUI_CONTINUITY_ROOT").expect("fixture-only launcher root"),
    );
    let executable =
        PathBuf::from(std::env::var_os("CCGUI_CONTINUITY_BINARY").expect("fixture-only binary"));
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("ccgui-send-fixture-"));
    let profile = root.join("profile");
    let mut command = ProcessCommand::new(&executable);
    isolated_environment(&mut command, &root);
    command
        .args(["--task-worker", "--dev-profile"])
        .arg(&profile)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(
            std::fs::File::create(root.join("worker.stderr")).unwrap(),
        ));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000 | 0x0100_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut worker = command.spawn().expect("spawn actual task worker binary");
    let config = std::fs::read(root.join("worker-config.json")).unwrap();
    let mut input = worker.stdin.take().unwrap();
    input.write_all(&config).unwrap();
    input.write_all(b"\n").unwrap();
    drop(input);
    let mut ready = String::new();
    BufReader::new(worker.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    let ready: Value = serde_json::from_str(&ready).unwrap_or_else(|error| {
        panic!(
            "actual worker readiness frame: {error}; {}",
            std::fs::read_to_string(root.join("worker.stderr")).unwrap_or_default()
        )
    });
    assert_eq!(ready["workerId"], WORKER);
    let manifest = manifest(&root);
    assert_eq!(manifest.pid, worker.id());
    let request = Request {
        protocol: PROTOCOL,
        worker_id: WORKER.into(),
        token: manifest.token.clone(),
        id: START.into(),
        command: Command::Start {
            args: start_args(&root),
        },
    };
    let mut stream =
        std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, manifest.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    serde_json::to_writer(&mut stream, &request).unwrap();
    stream.write_all(b"\n").unwrap();
    let mut response = String::new();
    BufReader::new(stream)
        .take(16 * 1024 * 1024)
        .read_line(&mut response)
        .unwrap();
    let response: Response = serde_json::from_str(&response).unwrap();
    assert!(
        response.outcome.is_ok(),
        "worker Start failed: {:?}",
        response.outcome
    );
    std::fs::write(
        root.join("start-outcome.json"),
        serde_json::to_vec(&response.outcome).unwrap(),
    )
    .unwrap();
    runtime().block_on(until("fake CLI PID", || fake_pid(&root).is_some()));
    assert!(worker.try_wait().unwrap().is_none());
    // std::process::Child drop neither waits nor terminates the child.
    drop(worker);
}

#[test]
fn independent_worker_survives_parent_and_recovers_exact_receipts_and_events() {
    let fixture = TestHarness::new().unwrap();
    let root = dunce::canonicalize(fixture.root()).unwrap();
    let profile = root.join("profile");
    fixture.use_profile(&profile).unwrap();
    paths::ensure_dirs().unwrap();
    let db = Db::open_at(&paths::db_path()).unwrap();
    initialize_worker_schema(&db).unwrap();
    drop(db);
    let fake = write_cli(&fixture);
    std::fs::write(
        paths::settings_path(),
        serde_json::to_vec(&json!({"claudeBin":fake,"autoTitleEnabled":false})).unwrap(),
    )
    .unwrap();
    std::fs::write(paths::config_path(), b"{}").unwrap();
    let executable = dunce::canonicalize(env!("CARGO_BIN_EXE_ccgui-next"))
        .expect("cargo-built actual ccgui-next binary");
    let _cleanup = Cleanup {
        root: root.clone(),
        executable: executable.clone(),
    };
    // This socket reserves a fixture-only host-chat URL. The fake CLI never
    // executes MCP tools; protocol/config validation is covered, relay semantics
    // deliberately are not claimed by this ordinary-worker process test.
    let host_chat = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let config: WorkerConfig = serde_json::from_value(json!({
        "protocol":PROTOCOL,"workerId":WORKER,"runId":RUN,"profile":profile,
        "token":"a".repeat(64),"schemaHash":schema_hash(),
        "hostContext":{"profile":profile,"runId":RUN,"engine":"claude","sessionId":null,
            "workspacePath":root.join("ws"),"serverConfig":{"command":executable,
                "args":["--host-chat-mcp","--dev-profile",profile],
                "env":{"CCGUI_HOST_CHAT_URL":format!("http://127.0.0.1:{}/host-chat",host_chat.local_addr().unwrap().port()),"CCGUI_HOST_CHAT_TOKEN":uuid::Uuid::new_v4().to_string()}}}
    })).unwrap();
    std::fs::write(
        root.join("worker-config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let mut helper = ProcessCommand::new(std::env::current_exe().unwrap());
    isolated_environment(&mut helper, &root);
    helper
        .args(["--exact", "launcher_helper", "--ignored", "--nocapture"])
        .env("CCGUI_CONTINUITY_ROOT", &root)
        .env("CCGUI_CONTINUITY_BINARY", &executable)
        .stdout(Stdio::null())
        .stderr(Stdio::from(
            std::fs::File::create(root.join("launcher.stderr")).unwrap(),
        ));
    let mut helper = HelperChild(helper.spawn().unwrap());
    let helper_pid = helper.0.id();
    runtime().block_on(async {
        until("launcher helper to exit", || {
            helper.0.try_wait().unwrap().is_some()
        })
        .await;
        assert!(
            helper.0.wait().unwrap().success(),
            "launcher failed: {}",
            std::fs::read_to_string(root.join("launcher.stderr")).unwrap_or_default()
        );
        assert!(
            process(helper_pid).is_none(),
            "launcher parent must be fully gone"
        );
        let manifest = manifest(&root);
        let native_pid = fake_pid(&root).unwrap();
        assert!(
            process(manifest.pid).is_some(),
            "worker died with its launcher"
        );
        assert!(
            process(native_pid).is_some(),
            "native CLI died with the launcher"
        );
        let first_client = WorkerClient::new(manifest.clone());
        let original: Outcome =
            serde_json::from_slice(&std::fs::read(root.join("start-outcome.json")).unwrap())
                .unwrap();
        assert_eq!(
            first_client
                .request(
                    START,
                    Command::Start {
                        args: start_args(&root)
                    }
                )
                .await,
            original
        );
        assert_eq!(
            std::fs::read_to_string(root.join("ws/launches.txt"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        let deadline = Instant::now() + Duration::from_secs(15);
        let first_page = loop {
            let page = first_client.events_after(0, 512).await.unwrap();
            if page.events.iter().any(|event| {
                event.payload.as_array().is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item["kind"] == "delta" && item["data"] == "before 中文😀")
                })
            }) {
                break page;
            }
            assert!(
                Instant::now() < deadline,
                "initial fake CLI text was not journaled"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let checkpoint = first_page.through;

        let request = Request {
            protocol: PROTOCOL,
            worker_id: WORKER.into(),
            token: manifest.token.clone(),
            id: "disconnected-followup".into(),
            command: Command::Followup {
                prompt: "x".repeat(1024 * 1024),
                image_paths: None,
            },
        };
        let mut socket =
            tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, manifest.port))
                .await
                .unwrap();
        let mut bytes = serde_json::to_vec(&request).unwrap();
        bytes.push(b'\n');
        socket.write_all(&bytes).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let receipt = first_client
                .request(
                    "check-accepted",
                    Command::Receipt {
                        request_id: request.id.clone(),
                    },
                )
                .await
                .unwrap();
            if receipt["phase"] == "accepted" {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "never observed accepted blocked follow-up: {receipt}"
            );
            assert_ne!(
                receipt["phase"], "completed",
                "pipe gate did not produce an in-flight command"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        drop(socket);
        drop(first_client);
        std::fs::write(root.join("ws/read-release"), []).unwrap();
        // A newly created client recovers the stable receipt after disconnection.
        let next_client = WorkerClient::new(manifest.clone());
        let completed = next_client
            .request(&request.id, request.command.clone())
            .await
            .unwrap();
        assert_eq!(completed, json!(true));
        assert_eq!(
            next_client
                .request(&request.id, request.command.clone())
                .await
                .unwrap(),
            completed
        );
        until("one fake follow-up", || {
            std::fs::read_to_string(root.join("ws/followups.txt"))
                .map(|text| text.lines().count() == 1)
                .unwrap_or(false)
        })
        .await;
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let page = next_client.events_after(checkpoint, 512).await.unwrap();
            if page.events.iter().any(|event| {
                event.payload.as_array().is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item["kind"] == "delta" && item["data"] == " after 中文😀")
                })
            }) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "follow-up fake CLI text was not journaled"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(process(native_pid).is_some());
        assert!(next_client
            .request("explicit-interrupt", Command::Interrupt)
            .await
            .unwrap()
            .as_bool()
            .unwrap());
        let deadline = Instant::now() + Duration::from_secs(30);
        let head = loop {
            let status = next_client
                .request("check-physical", Command::Status)
                .await
                .unwrap();
            if status["physicalComplete"] == true {
                break status["head"].as_u64().unwrap();
            }
            assert!(
                Instant::now() < deadline,
                "reader/process did not retire: {status}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        until("native process exit", || process(native_pid).is_none()).await;
        let second_page = next_client.events_after(checkpoint, 512).await.unwrap();
        assert_eq!(second_page.through, head);
        let all: Vec<_> = first_page
            .events
            .into_iter()
            .chain(second_page.events)
            .collect();
        assert_eq!(
            all.iter().map(|event| event.seq).collect::<Vec<_>>(),
            (1..=head).collect::<Vec<_>>()
        );
        assert!(all.iter().all(|event| event.stream_id == WORKER));
        let text: String = all
            .iter()
            .filter(|event| event.name == "engine://event")
            .flat_map(|event| event.payload.as_array().into_iter().flatten())
            .filter(|event| event["kind"] == "delta")
            .filter_map(|event| event["data"].as_str())
            .collect();
        assert_eq!(text, "before 中文😀 after 中文😀");
        next_client
            .request(
                "retire-confirmed",
                Command::Retire {
                    stream_id: WORKER.into(),
                    through: head,
                },
            )
            .await
            .unwrap();
        until("worker exit after retirement", || {
            process(manifest.pid).is_none()
        })
        .await;
        let archive = open_archive(&profile, WORKER).unwrap();
        assert_eq!(archive.head(), head);
        assert_eq!(archive.replay(0, 512).unwrap().events, all);
        assert_eq!(
            archive.receipt("disconnected-followup").unwrap(),
            Some(Ok(completed))
        );
        assert_eq!(archive.receipt(START).unwrap(), Some(original));
    });
}
