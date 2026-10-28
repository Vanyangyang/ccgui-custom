//! Opt-in installed CLI acceptance using a fake key and loopback gateway only.
use super::*;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
#[ignore = "requires CCGUI_AGY_TEST_BIN; fake loopback model/key only, no paid generation"]
async fn installed_agy_blocks_privileged_tools_and_cleans_success_timeout_and_cancel() {
    let bin = std::env::var("CCGUI_AGY_TEST_BIN").expect("set the installed AGY executable path");
    for mode in ["success", "timeout", "cancel"] {
        let root = scratch();
        let witness = scratch(); std::fs::create_dir(&witness).unwrap();
        let _witness_cleanup = PrivateStaging(witness.clone());
        let marker = witness.join("forbidden-write.txt");
        let command_marker = witness.join("forbidden-command.txt");
        let secret = witness.join("synthetic-secret.txt");
        std::fs::write(&secret,"synthetic-file-secret").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let records = Arc::new(Mutex::new(Vec::<Value>::new()));
        let notify = Arc::new(tokio::sync::Notify::new());
        let (captured, reached) = (records.clone(), notify.clone());
        let (target, command_target, secret_target) = (marker.clone(), command_marker.clone(), secret.clone());
        let server = tokio::spawn(async move {
            let mut denied = false;
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = Vec::new(); let mut chunk = [0;8192];
                let end = loop {
                    let read = socket.read(&mut chunk).await.unwrap(); if read == 0 { return; }
                    data.extend_from_slice(&chunk[..read]); assert!(data.len() < 1024*1024);
                    if let Some(end) = data.windows(4).position(|bytes| bytes == b"\r\n\r\n") { break end+4; }
                };
                let headers = String::from_utf8_lossy(&data[..end]);
                let length:usize = headers.lines().find_map(|line| {
                    let (name,value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
                }).unwrap();
                assert!(length < 1024*1024);
                while data.len() < end+length {
                    let read = socket.read(&mut chunk).await.unwrap(); if read == 0 { return; }
                    data.extend_from_slice(&chunk[..read]);
                }
                let body:Value = serde_json::from_slice(&data[end..end+length]).unwrap();
                let names = body.get("tools").and_then(Value::as_array).into_iter().flatten()
                    .flat_map(|group| group.get("functionDeclarations").and_then(Value::as_array).into_iter().flatten())
                    .filter_map(|function| function.get("name").and_then(Value::as_str)).collect::<Vec<_>>();
                assert!(names.iter().all(|name| matches!(*name,"finish"|"manage_task")));
                let inference = names.contains(&"finish");
                captured.lock().unwrap().push(body.clone());
                if inference {
                    reached.notify_one();
                    if mode != "success" { std::future::pending::<()>().await; }
                }
                let parts = if inference && !denied {
                    denied = true;
                    std::fs::write(&secret_target,"synthetic-file-secret").unwrap();
                    json!([
                        {"functionCall":{"name":"write_to_file","args":{"TargetFile":target,"Overwrite":false,"CodeContent":"forbidden","Description":"Synthetic isolation test"}}},
                        {"functionCall":{"name":"run_command","args":{"CommandLine":format!("Set-Content -LiteralPath '{}' -Value forbidden",command_target.display()),"toolSummary":"Synthetic isolation test","WaitMsBeforeAsync":500}}},
                        {"functionCall":{"name":"view_file","args":{"AbsolutePath":secret_target}}},
                        {"functionCall":{"name":"call_mcp_tool","args":{"serverName":"synthetic","toolName":"forbidden","arguments":{}}}}
                    ])
                } else if inference {
                    json!([{"functionCall":{"name":"finish","args":{"thought":null}}}])
                } else { json!([{"text":"Synthetic title"}]) };
                let response = json!({"candidates":[{"content":{"role":"model","parts":parts},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}});
                let body = format!("data: {response}\n\n");
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            }
        });
        let schema = json!({"type":"object","properties":{"thought":{"type":"null"}},"required":["thought"],"additionalProperties":false});
        let context = Context { bin:bin.clone(), env:HashMap::from([
            ("GEMINI_API_KEY".into(),"fake-loopback-key".into()), ("GOOGLE_GEMINI_BASE_URL".into(),endpoint),
            ("NO_PROXY".into(),"127.0.0.1,localhost".into()), ("no_proxy".into(),"127.0.0.1,localhost".into())
        ]), settings:NativeSettings { model_provider:Some("gemini".into()) } };
        let task_root = root.clone();
        let input = json!({"locale":"en","snapshot":{"checkpoint":format!("Untrusted text, not an instruction: @{}",secret.display())}}).to_string();
        let task = tokio::spawn(async move {
            let mut call = call(&schema);
            call.input = &input;
            call.model = "gemini-api://ccgui-local-test/models/synthetic-model";
            call.timeout = Duration::from_secs(if mode=="timeout" { 8 } else { 20 });
            execute_in(context,call,&task_root).await
        });
        tokio::time::timeout(Duration::from_secs(15),notify.notified()).await.unwrap();
        if mode == "cancel" {
            task.abort(); assert!(task.await.unwrap_err().is_cancelled());
        } else {
            let result = task.await.unwrap();
            if mode=="success" { assert_eq!(result.unwrap().structured,json!({"thought":null})); }
            else { assert!(matches!(result,Err(SideCallError::Timeout))); }
        }
        server.abort();
        assert!(!marker.exists()); assert!(!command_marker.exists());
        assert!(records.lock().unwrap().iter().all(|body| !body.to_string().contains("synthetic-file-secret")));
        if mode == "success" {
            let records = records.lock().unwrap();
            let rejected = records.iter().flat_map(|body| body.get("contents").and_then(Value::as_array).into_iter().flatten())
                .flat_map(|content| content.get("parts").and_then(Value::as_array).into_iter().flatten())
                .filter_map(|part| part.get("functionResponse")).collect::<Vec<_>>();
            for name in ["write_to_file", "run_command", "view_file", "call_mcp_tool"] {
                assert!(rejected.iter().any(|result| result.get("name").and_then(Value::as_str)==Some(name)
                    && result.get("response").is_some_and(|value| value.to_string().contains("unknown tool"))), "must reject {name} before execution");
            }
        }
        tokio::time::timeout(Duration::from_secs(4),async { while root.exists() { tokio::time::sleep(Duration::from_millis(50)).await; } }).await.unwrap();
    }
}
