//! The reserved host records establish ownership; UI projections are not history.
use super::{gate::Gate, protocol::*};
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::sync::Arc;

pub struct Loaded {
    pub session: SessionRef,
    pub rows: Vec<Row>,
    pub later_pages: bool,
    pub fence: String,
    pub floor_seq: i64,
}
fn string<'a>(v: &'a Value, field: &str) -> Result<&'a str, String> {
    v.get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "invalid_source_record".into())
}
fn array<'a>(v: &'a Value, field: &str) -> Result<&'a Vec<Value>, String> {
    v.get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| "invalid_source_record".into())
}
fn absent(v: &Value, field: &str) -> bool {
    v.get(field).is_none_or(Value::is_null)
}
fn no_error(v: &Value) -> bool {
    absent(v, "error")
}
fn flag(v: &Value, field: &str) -> bool {
    v.get(field) == Some(&Value::Bool(true))
}
fn same_workspace(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        let key = |path: &str| {
            let value = path.replace('\\', "/");
            value
                .strip_prefix("//?/")
                .unwrap_or(&value)
                .trim_end_matches('/')
                .to_lowercase()
        };
        key(a) == key(b)
    }
    #[cfg(not(windows))]
    {
        a.trim_end_matches('/') == b.trim_end_matches('/')
    }
}
fn same_ref(v: &Value, session: &SessionRef) -> bool {
    serde_json::from_value::<SessionRef>(v.clone()).is_ok_and(|s| s == *session)
}
fn read(db: &crate::db::Db, plugin: &str, key: &str) -> Result<Value, String> {
    // Refuse oversized/corrupt records before allocating a full transcript.
    let conn = db.0.lock();
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2 AND length(value)<=8388608",
            rusqlite::params![plugin, key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "source_storage_unavailable")?;
    serde_json::from_str(&raw.ok_or("source_not_owned_or_oversized")?)
        .map_err(|_| "invalid_source_record".into())
}
pub fn conversation_record(raw: &Value, source: &Source) -> Result<(SessionRef, Vec<Row>), String> {
    let s = &raw["snapshot"];
    let state = &raw["state"];
    if string(s, "threadId")? != source.id
        || string(s, "status")? != "completed"
        || !no_error(s)
        || raw.get("cancelled") != Some(&Value::Bool(false))
        || !absent(raw, "runId")
        || !absent(raw, "pendingUser")
        || state.get("streaming") != Some(&Value::Bool(false))
        || !no_error(state)
        || !absent(state, "runId")
        || !absent(state, "parentSessionId")
        || state.get("mode").is_some_and(|v| v != "read-only")
    {
        return Err("source_not_successfully_completed".into());
    }
    let session: SessionRef =
        serde_json::from_value(s["sessionRef"].clone()).map_err(|_| "invalid_source_session")?;
    if !matches!(session.engine.as_str(), "claude" | "codex")
        || string(state, "sideSessionId")? != session.session_id
        || string(state, "engine")? != session.engine
        || string(state, "workspacePath")? != session.workspace_path
        || string(s, "workspacePath")? != session.workspace_path
        || s.pointer("/selection/engine").and_then(Value::as_str) != Some(session.engine.as_str())
    {
        return Err("source_identity_mismatch".into());
    }
    let rows = array(state, "messages")?
        .iter()
        .map(|r| {
            if flag(r, "streaming") || flag(r, "live") {
                return Err("streaming_source_row".into());
            }
            Ok(Row {
                seq: r["seq"].as_i64().ok_or("invalid_native_seq")?,
                role: string(r, "role")?.into(),
                text: r["text"].as_str().ok_or("invalid_native_text")?.into(),
                display_text: None,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    validate_rows(&rows)?;
    Ok((session, rows))
}
pub fn coordinator_record(
    index: &Value,
    conversations: &Value,
    source: &Source,
) -> Result<SessionRef, String> {
    if index["version"] != 1 || conversations["version"] != 1 {
        return Err("invalid_source_version".into());
    }
    let entries = array(index, "entries")?;
    let owned: Vec<_> = entries
        .iter()
        .filter(|e| e.pointer("/receipt/requestId").and_then(Value::as_str) == Some(&source.id))
        .collect();
    let records = array(conversations, "records")?;
    let matched: Vec<_> = records
        .iter()
        .filter(|r| r["requestId"].as_str() == Some(&source.id))
        .collect();
    if owned.len() != 1 || matched.len() != 1 {
        return Err("source_not_exclusively_owned".into());
    }
    let e = owned[0];
    let r = matched[0];
    let receipt = &e["receipt"];
    if !flag(e, "coordination")
        || e["sessionMode"] != "new"
        || !flag(e, "conversationOwner")
        || !flag(e, "sessionProven")
        || flag(e, "forgotten")
        || flag(e, "identityMismatch")
        || flag(e, "cancelRequested")
        || flag(e, "conversationHolding")
        || !absent(e, "pendingTerminal")
        || string(receipt, "status")? != "completed"
        || !no_error(receipt)
        || r.get("stopping") != Some(&Value::Bool(false))
        || flag(r, "stopped")
        || !absent(r, "ownershipError")
    {
        return Err("source_not_successfully_completed".into());
    }
    let session: SessionRef =
        serde_json::from_value(r["sessionRef"].clone()).map_err(|_| "invalid_source_session")?;
    if !same_ref(&receipt["session"], &session)
        || !same_ref(&e["conversationSession"], &session)
        || string(receipt, "workspacePath")? != session.workspace_path
    {
        return Err("source_identity_mismatch".into());
    }
    if entries
        .iter()
        .filter(|other| {
            flag(other, "conversationOwner") && same_ref(&other["conversationSession"], &session)
        })
        .count()
        != 1
        || records
            .iter()
            .filter(|other| same_ref(&other["sessionRef"], &session))
            .count()
            != 1
    {
        return Err("source_not_exclusively_owned".into());
    }
    for input in array(r, "inputs")? {
        let p = &input["receipt"];
        // The durable inbox can cancel an input before it creates any native
        // row. Such a receipt must not poison an otherwise completed source.
        if p["status"] == "cancelled" && absent(p, "runId") && absent(input, "userRow") && p["delivery"] == "queued" {
            if string(p, "conversationRequestId")? != source.id || !absent(p,"sessionRef") && !same_ref(&p["sessionRef"], &session) { return Err("unsettled_coordinator_input".into()); }
            continue;
        }
        if string(p, "conversationRequestId")? != source.id
            || string(p, "status")? != "completed"
            || !no_error(p)
            || !same_ref(&p["sessionRef"], &session)
            || string(p, "runId").is_err()
        {
            return Err("unsettled_coordinator_input".into());
        }
    }
    if let Some(children) = r.get("children") {
        for child in children.as_array().ok_or("invalid_child_state")? {
            if !matches!(child["state"].as_str(), Some("completed" | "failed" | "stopped" | "reclaimed")) {
                return Err("unsettled_coordinator_child".into());
            }
        }
    }
    Ok(session)
}
fn native_header(path: &std::path::Path, session: &SessionRef) -> Result<(), String> {
    use std::io::{BufRead, Read};
    let reader: Box<dyn BufRead> = if session.engine == "codex" {
        crate::history::codex_rollout::open_reader(path).map_err(|_| "native_header_unavailable")?
    } else if session.engine == "claude" {
        Box::new(std::io::BufReader::new(
            std::fs::File::open(path).map_err(|_| "native_header_unavailable")?,
        ))
    } else {
        return Err("native_header_unsupported".into());
    };
    let mut bounded = reader.take(512 * 1024);
    let mut line = String::new();
    for _ in 0..32 {
        line.clear();
        if bounded
            .read_line(&mut line)
            .map_err(|_| "native_header_unavailable")?
            == 0
        {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let header = if session.engine == "codex" {
            if value["type"] != "session_meta" {
                continue;
            }
            let p = &value["payload"];
            if p.get("source").is_some_and(|v| {
                v.is_object() || v.as_str().is_some_and(|s| s.contains("subagent"))
            }) {
                return Err("child_session_excluded".into());
            }
            (p["id"].as_str(), p["cwd"].as_str())
        } else {
            if value["isSidechain"] == true {
                return Err("child_session_excluded".into());
            }
            if value["sessionId"].as_str().is_none() || value["cwd"].as_str().is_none() {
                continue;
            }
            (value["sessionId"].as_str(), value["cwd"].as_str())
        };
        if header.0 == Some(session.session_id.as_str())
            && header
                .1
                .is_some_and(|cwd| same_workspace(cwd, &session.workspace_path))
        {
            return Ok(());
        }
        return Err("native_header_identity_mismatch".into());
    }
    Err("native_header_identity_unproven".into())
}
fn session_metadata(
    db: &crate::db::Db,
    session: &SessionRef,
    require_history: bool,
) -> Result<String, String> {
    let conn = db.0.lock();
    let archived: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM session_archives WHERE engine=?1 AND session_id=?2)",
            rusqlite::params![session.engine, session.session_id],
            |r| r.get(0),
        )
        .map_err(|_| "session_metadata_unavailable")?;
    if archived {
        return Err("archived_source".into());
    }
    let meta: Option<(String, String)> = conn
        .query_row(
            "SELECT workspace_path,file_path FROM sessions WHERE engine=?1 AND session_id=?2",
            rusqlite::params![session.engine, session.session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| "session_metadata_unavailable")?;
    drop(conn);
    match meta {
        Some((path, file)) if same_workspace(&path, &session.workspace_path) => {
            // Chat's reserved state is original; coordinator must also prove the
            // file header rather than trusting index/sidebar metadata alone.
            if std::path::Path::new(&file).components().any(|c| {
                c.as_os_str()
                    .to_str()
                    .is_some_and(|s| s.eq_ignore_ascii_case("archived_sessions"))
            }) {
                return Err("archived_source".into());
            }
            if require_history {
                native_header(std::path::Path::new(&file), session)?;
            }
            Ok(digest(&serde_json::json!([path, file]).to_string()))
        }
        None if !require_history => Ok("reserved-chat-only".into()),
        _ => Err("native_session_identity_unproven".into()),
    }
}
fn display_for(row: &crate::history::Message, proofs: &[Value]) -> Option<String> {
    if row.role != "user" {
        return None;
    }
    let images = serde_json::json!(row.images);
    let matches: Vec<_> = proofs
        .iter()
        .filter(|p| {
            let r = &p["userRow"];
            let Some(display) = p["displayText"].as_str().filter(|s| !s.trim().is_empty()) else { return false; };
            // Runtime rows are committed before the CLI writes its history, so
            // their seq/timestamps need not be the native history coordinates.
            // Bind the exact delivered prompt and completed request window; a
            // display-only string is never accepted as invented source evidence.
            let prompt_matches = p["prompt"].as_str() == Some(row.text.as_str())
                && r["text"].as_str() == Some(row.text.as_str())
                && r["runId"].as_str().is_some_and(|id| p.pointer("/receipt/runId").and_then(Value::as_str) == Some(id));
            let display_matches = user_text(&row.text).is_ok_and(|text| text == display)
                || flag(p, "coordination") && p["sessionMode"] == "new" && row.text.contains(display);
            if !prompt_matches || !display_matches { return false; }
            let runtime_row = r["seq"].as_i64() == Some(row.seq)
                && r["ts"] == serde_json::json!(row.ts)
                && r.get("images")
                    .unwrap_or(&serde_json::Value::Null)
                    .as_array()
                    .map(|v| serde_json::json!(v))
                    .unwrap_or_else(|| serde_json::json!([]))
                    == images;
            let native_window = row.ts.as_deref().and_then(crate::history::parse_ts_ms_str)
                .zip(r["ts"].as_str().and_then(crate::history::parse_ts_ms_str))
                .zip(p.pointer("/receipt/updatedAt").and_then(Value::as_i64))
                .is_some_and(|((native, submitted), completed)| p.pointer("/receipt/status").and_then(Value::as_str) == Some("completed")
                    && completed >= submitted && native >= submitted.saturating_sub(1000) && native <= completed.saturating_add(1000));
            // Only text is extracted. Native image representations can differ
            // from the local attachment paths; they never become model evidence.
            runtime_row || native_window
        })
        .collect();
    (matches.len() == 1).then(|| matches[0]["displayText"].as_str().unwrap().to_owned())
}
fn native_rows(
    db: &crate::db::Db,
    session: &SessionRef,
    cursor: Option<&Cursor>,
    checkpoint: bool,
    displays: &[Value],
    gate: &Arc<Gate>,
    epoch: u64,
) -> Result<(Vec<Row>, bool), String> {
    let wanted = cursor.map_or(-1, |c| c.seq);
    let mut before = None;
    let mut newer = Vec::new();
    // Retain at most two pages: the cursor page plus its immediate successor.
    // Including that successor is necessary when the cursor is at a page end.
    for page_index in 0..64 {
        if !gate.valid(epoch) {
            return Err("preempted".into());
        }
        let page = crate::history::reader::load_session_page_blocking(
            db,
            &session.engine,
            &session.session_id,
            Some(500),
            before,
        )
        .map_err(|_| "native_history_unavailable")?;
        let mut rows: Vec<_> = page
            .messages
            .into_iter()
            .map(|r| {
                let display_text = display_for(&r, displays);
                let role = if r.role == "user" && !displays.is_empty() && display_text.is_none() { "context".into() } else { r.role };
                Row {
                    seq: r.seq,
                    role,
                    text: r.text,
                    display_text,
                }
            })
            .collect();
        validate_rows(&rows)?;
        if checkpoint || page.next_before.is_none() || rows.first().is_some_and(|r| r.seq <= wanted)
        {
            if !checkpoint {
                rows.extend(newer);
                validate_rows(&rows)?;
            }
            return Ok((rows, !checkpoint && page_index > 1));
        }
        let next = page.next_before.ok_or("invalid_history_page")?;
        if before.is_some_and(|old| next >= old) || rows.is_empty() {
            return Err("invalid_history_page".into());
        }
        before = Some(next);
        newer = rows;
    }
    Err("history_page_bound_exceeded".into())
}
pub fn load(
    db: &crate::db::Db,
    plugin: &str,
    project: &str,
    source: &Source,
    cursor: Option<&Cursor>,
    checkpoint: bool,
    gate: &Arc<Gate>,
    epoch: u64,
) -> Result<Loaded, String> {
    if !valid_id(&source.id)
        || project.trim().is_empty()
        || project.chars().count() > 200
        || project.chars().any(char::is_control)
    {
        return Err("invalid_source_scope".into());
    }
    if !gate.valid(epoch) {
        return Err("preempted".into());
    }
    let mut displays = Vec::new();
    let (session, mut rows, proof, floor_seq) = match source.kind {
        SourceKind::Conversation => {
            let raw = read(
                db,
                plugin,
                &format!("__host_conversations_v1:{}", source.id),
            )?;
            let (session, rows) = conversation_record(&raw, source)?;
            let floor = match raw.get("memoryFloorSeq") {
                Some(value) => value.as_i64().filter(|seq| *seq >= -1 && *seq <= rows.last().map_or(-1, |r| r.seq)).ok_or("invalid_completion_fence")?,
                // Old ledgers prove the latest turn only. Never assume earlier
                // preserved rows all ended successfully before this feature.
                None => rows.iter().rev().find(|r| r.role == "user").map_or_else(|| rows.last().map_or(-1, |r| r.seq), |r| r.seq - 1),
            };
            (session, rows, digest(&raw.to_string()), floor)
        }
        SourceKind::Coordination => {
            let index = read(db, plugin, "__host_tasks_v1:index")?;
            let records = read(db, plugin, "__host_tasks_v1:conversations")?;
            let session = coordinator_record(&index, &records, source)?;
            let entry = array(&index, "entries")?
                .iter()
                .find(|e| {
                    e.pointer("/receipt/requestId").and_then(Value::as_str) == Some(&source.id)
                })
                .ok_or("source_not_owned")?;
            if entry.pointer("/receipt/projectId").and_then(Value::as_str) != Some(project) {
                return Err("source_project_mismatch".into());
            }
            displays.push(entry.clone());
            let record = array(&records, "records")?
                .iter()
                .find(|r| r["requestId"].as_str() == Some(&source.id))
                .ok_or("source_not_owned")?;
            displays.extend(array(record, "inputs")?.iter().cloned());
            (
                session,
                Vec::new(),
                digest(&serde_json::json!([index, records]).to_string()),
                -1,
            )
        }
    };
    if !valid_id(&session.session_id)
        || !matches!(
            session.engine.as_str(),
            "claude" | "codex" | "agy" | "cursor" | "pi" | "omp" | "kimi" | "opencode"
        )
    {
        return Err("invalid_source_session".into());
    }
    if cursor.is_some_and(|c| c.session_id != session.session_id) {
        return Err("cursor_identity_changed".into());
    }
    let identity = crate::workspace_projects::authorize_memory_source(
        &db.0.lock(),
        plugin,
        project,
        &session.workspace_path,
        source.kind == SourceKind::Coordination,
    )?;
    let native = session_metadata(db, &session, source.kind == SourceKind::Coordination)?;
    let mut later_pages = false;
    if source.kind == SourceKind::Coordination {
        (rows, later_pages) =
            native_rows(db, &session, cursor, checkpoint, &displays, gate, epoch)?;
    }
    if !gate.valid(epoch) {
        return Err("preempted".into());
    }
    Ok(Loaded {
        session,
        rows,
        later_pages,
        fence: digest(&format!("{proof}:{identity}:{native}")),
        floor_seq,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn reserved_namespace_cannot_read_foreign_plugin_records() {
        let db = crate::db::Db::open_in_memory().unwrap();
        db.plugin_kv_set(
            "other",
            "__host_conversations_v1:a",
            &json!({"text":"foreign"}),
        )
        .unwrap();
        assert!(read(&db, "example-dashboard", "__host_conversations_v1:a").is_err());
        db.plugin_kv_set(
            "example-dashboard",
            "__host_conversations_v1:a",
            &json!({"marker":"owned"}),
        )
        .unwrap();
        assert_eq!(
            read(&db, "example-dashboard", "__host_conversations_v1:a").unwrap()["marker"],
            "owned"
        );
    }
    #[test]
    fn archive_marker_wins_over_completed_reserved_state() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let session = SessionRef {
            engine: "codex".into(),
            session_id: "archived".into(),
            workspace_path: "/fixture".into(),
        };
        db.0.lock().execute("INSERT INTO session_archives(engine,session_id,workspace_path,snapshot_json,archived_at) VALUES('codex','archived','/fixture','{}',1)",[]).unwrap();
        assert_eq!(
            session_metadata(&db, &session, false).unwrap_err(),
            "archived_source"
        );
    }
    #[test]
    fn original_native_paging_display_binding_and_header_identity() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let root =
            std::env::temp_dir().join(format!("ccgui-memory-source-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("rollout-fixture.jsonl");
        let session = SessionRef {
            engine: "codex".into(),
            session_id: format!("fixture-{}", uuid::Uuid::new_v4()),
            workspace_path: root.to_str().unwrap().into(),
        };
        let header = json!({"type":"session_meta","payload":{"id":session.session_id,"cwd":session.workspace_path,"source":"vscode"}});
        let mut lines = vec![header.to_string()];
        for n in 0..1000 {
            lines.push(json!({"type":"response_item","payload":{"type":"message","role":if n%2==0 {"user"} else {"assistant"},"content":[{"type":if n%2==0 {"input_text"} else {"output_text"},"text":format!("native row {n}")}]}}).to_string());
        }
        std::fs::write(&file, lines.join("\n")).unwrap();
        db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms) VALUES(?1,?2,?3,?4,0,0)",rusqlite::params![session.engine,session.session_id,session.workspace_path,file.to_str().unwrap()]).unwrap();
        assert!(session_metadata(&db, &session, true).is_ok());
        let gate = Arc::new(Gate::new());
        let epoch = gate.epoch();
        let all = crate::history::reader::load_session_page_blocking(
            &db,
            "codex",
            &session.session_id,
            Some(500),
            None,
        )
        .unwrap();
        let first_seq = all.messages[0].seq;
        let previous = crate::history::reader::load_session_page_blocking(
            &db,
            "codex",
            &session.session_id,
            Some(500),
            Some(first_seq),
        )
        .unwrap();
        let boundary = previous.messages.last().unwrap();
        let cursor = Row {
            seq: boundary.seq,
            role: boundary.role.clone(),
            text: boundary.text.clone(),
            display_text: None,
        }
        .cursor(&session.session_id, 0);
        let (rows, more) =
            native_rows(&db, &session, Some(&cursor), false, &[], &gate, epoch).unwrap();
        let selected = select(&rows, &session.session_id, Some(&cursor), more).unwrap();
        assert_eq!(selected.slices[0].seq, first_seq);
        assert!(selected.next.seq > cursor.seq);
        let native = &all.messages[0];
        assert_eq!(native.role, "user");
        let proof = json!({"displayText":native.text,"prompt":native.text,"receipt":{"runId":"r"},"userRow":{"seq":native.seq,"text":native.text,"ts":native.ts,"runId":"r","images":[]}});
        assert_eq!(
            display_for(native, &[proof.clone()]),
            Some(native.text.clone())
        );
        let mut forged = proof.clone();
        forged["userRow"]["text"] = "preview".into();
        assert!(display_for(native, &[forged]).is_none());
        let mut invented = proof.clone(); invented["displayText"] = "not present in the original".into();
        assert!(display_for(native, &[invented]).is_none());
        assert!(display_for(native, &[proof.clone(), proof]).is_none());
        let mut wrong = header.clone();
        wrong["payload"]["cwd"] = "/foreign".into();
        std::fs::write(&file, wrong.to_string()).unwrap();
        assert!(native_header(&file, &session).is_err());
        let mut child = header;
        child["payload"]["source"] = json!({"subagent":{}});
        std::fs::write(&file, child.to_string()).unwrap();
        assert!(native_header(&file, &session).is_err());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    fn chat() -> (Source, Value) {
        (
            Source {
                kind: SourceKind::Conversation,
                id: "chat".into(),
            },
            json!({"cancelled":false,"runId":null,"snapshot":{"threadId":"chat","status":"completed","workspacePath":"/game","selection":{"engine":"codex"},"sessionRef":{"engine":"codex","sessionId":"s","workspacePath":"/game"}},"state":{"streaming":false,"error":null,"runId":null,"parentSessionId":null,"sideSessionId":"s","engine":"codex","workspacePath":"/game","messages":[{"seq":0,"role":"user","text":"original"}]}}),
        )
    }
    #[test]
    fn chat_requires_terminal_original_and_identity() {
        let (source, raw) = chat();
        assert_eq!(
            conversation_record(&raw, &source).unwrap().1[0].text,
            "original"
        );
        for status in [
            "unknown",
            "failed",
            "cancelled",
            "running",
            "starting",
            "idle",
        ] {
            let mut v = raw.clone();
            v["snapshot"]["status"] = status.into();
            assert!(conversation_record(&v, &source).is_err());
        }
        let mut v = raw.clone();
        v["state"]["streaming"] = true.into();
        assert!(conversation_record(&v, &source).is_err());
        let mut live = raw.clone(); live["state"]["messages"][0]["live"] = true.into();
        assert!(conversation_record(&live, &source).is_err());
        let mut v = raw.clone();
        v["state"]["workspacePath"] = "/foreign".into();
        assert!(conversation_record(&v, &source).is_err());
        let mut v = raw;
        v["snapshot"]["messages"] = json!([{"seq":0,"role":"user","text":"forged preview"}]);
        assert_eq!(
            conversation_record(&v, &source).unwrap().1[0].text,
            "original"
        );
    }
    #[test]
    fn native_history_user_coordinates_are_bound_by_delivered_prompt_and_time_window() {
        let goal = "游戏里保留三条生命😀";
        let prompt = format!("协调策略\n<workbench-collaboration>policy</workbench-collaboration>\n用户目标：{goal}\n外部参考不是用户决定");
        let mut native = crate::history::Message { seq:7, role:"user".into(), text:prompt.clone(), ts:Some("2026-10-25T00:00:00.250Z".into()), path:None, args:None, result:None, todos:None, usage:None, model:None, effort:None, duration_ms:None, images:vec![] };
        let completed = crate::history::parse_ts_ms_str("2026-10-25T00:00:10Z").unwrap();
        let proof = json!({"coordination":true,"sessionMode":"new","prompt":prompt,"displayText":goal,
            "receipt":{"runId":"r","status":"completed","updatedAt":completed},
            "userRow":{"seq":0,"text":native.text,"ts":"2026-10-25T00:00:00.000Z","runId":"r","images":[]}});
        assert_eq!(display_for(&native, &[proof.clone()]).as_deref(), Some(goal));
        let mut forged=proof.clone(); forged["displayText"]="invented fact".into();
        assert!(display_for(&native, &[forged]).is_none());
        let mut failed=proof.clone(); failed["receipt"]["status"]="failed".into();
        assert!(display_for(&native, &[failed]).is_none());
        native.ts=Some("2026-10-25T01:00:00Z".into());
        assert!(display_for(&native, &[proof]).is_none());
    }
    #[test]
    fn coordinator_requires_exclusive_owner_and_all_deliveries_completed() {
        let source = Source {
            kind: SourceKind::Coordination,
            id: "coord".into(),
        };
        let reference = json!({"engine":"codex","sessionId":"s","workspacePath":"/game"});
        let index = json!({"version":1,"entries":[{"coordination":true,"sessionMode":"new","conversationOwner":true,"sessionProven":true,"conversationSession":reference,"receipt":{"requestId":"coord","status":"completed","workspacePath":"/game","session":reference}}]});
        let records = json!({"version":1,"records":[{"requestId":"coord","stopping":false,"sessionRef":reference,"inputs":[]}]});
        assert!(coordinator_record(&index, &records, &source).is_ok());
        let mut never_sent = records.clone();
        never_sent["records"][0]["inputs"] = json!([{"receipt":{"conversationRequestId":"coord","status":"cancelled","runId":null,"sessionRef":reference,"delivery":"queued"}}]);
        assert!(coordinator_record(&index, &never_sent, &source).is_ok());
        for flag in [
            "forgotten",
            "identityMismatch",
            "cancelRequested",
            "conversationHolding",
        ] {
            let mut v = index.clone();
            v["entries"][0][flag] = true.into();
            assert!(coordinator_record(&v, &records, &source).is_err());
        }
        for status in [
            "queued",
            "starting",
            "received",
            "unknown",
            "failed",
            "cancelled",
        ] {
            let mut v = records.clone();
            v["records"][0]["inputs"] = json!([{"receipt":{"conversationRequestId":"coord","status":status,"runId":"r","sessionRef":reference}}]);
            assert!(coordinator_record(&index, &v, &source).is_err());
        }
        let mut v = records.clone();
        v["records"][0]["stopping"] = true.into();
        assert!(coordinator_record(&index, &v, &source).is_err());
        let mut v = index.clone();
        v["entries"]
            .as_array_mut()
            .unwrap()
            .push(index["entries"][0].clone());
        assert!(coordinator_record(&v, &records, &source).is_err());
    }
}
