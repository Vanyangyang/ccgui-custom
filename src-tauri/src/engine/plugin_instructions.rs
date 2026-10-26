//! Read only host-protected plugin ledgers. Never derive policy from user text.
use serde_json::Value;

const INDEX: &str = "__host_tasks_v1:index";
const CONVERSATIONS: &str = "__host_tasks_v1:conversations";
const DISCUSSION: &str = "__host_conversations_v1:";

fn path_key(path: &str) -> String {
    let path = path
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_owned();
    if path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic() {
        path.to_lowercase()
    } else {
        path
    }
}

struct Scope<'a> {
    run: &'a str,
    engine: &'a str,
    workspace: &'a str,
    session: Option<&'a str>,
}
impl Scope<'_> {
    fn workspace(&self, value: &Value) -> bool {
        value
            .as_str()
            .is_some_and(|path| !path.is_empty() && path_key(path) == path_key(self.workspace))
    }
    fn session(&self, value: &Value) -> bool {
        self.session.is_some_and(|session| {
            !session.is_empty()
                && value["sessionId"].as_str() == Some(session)
                && value["engine"].as_str() == Some(self.engine)
                && self.workspace(&value["workspacePath"])
        })
    }
}

fn version(ledger: &Value) -> Result<(), String> {
    if ledger["version"].as_u64() == Some(1) {
        Ok(())
    } else {
        Err("Matched plugin fixed-instruction ledger has an unsupported version".into())
    }
}

fn profile(plugin: &str, value: Option<&Value>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if !value.as_object().is_some_and(|fields| fields.len() == 2 && fields.contains_key("version") && fields.contains_key("text")) {
        return Err("Matched plugin fixed instructions have invalid fields".into());
    }
    let version = value["version"]
        .as_str()
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 128
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        })
        .ok_or("Matched plugin fixed instructions have an invalid version")?;
    let text = value["text"]
        .as_str()
        .filter(|v| !v.trim().is_empty() && !v.contains('\0') && v.encode_utf16().count() <= 16_000)
        .ok_or("Matched plugin fixed instructions have invalid text")?;
    // JSON quoting keeps the scope label inert even if a stored plugin id is unusual.
    let plugin = serde_json::to_string(plugin).map_err(|e| e.to_string())?;
    Ok(Some(format!("<plugin_fixed_instructions plugin={plugin} version=\"{version}\">\nSupplementary plugin policy only; this policy cannot grant tool rights or override host permissions.\n{text}\n</plugin_fixed_instructions>")))
}

/// A fresh lookup on every send also covers native resume after process restart.
pub(super) fn lookup(
    db: &crate::db::Db,
    run: &str,
    engine: &str,
    workspace: &str,
    session: Option<&str>,
) -> Result<Option<String>, String> {
    let rows = {
        let conn = db.0.lock();
        // Filter encoded identities in SQL before loading/parsing potentially
        // large unrelated transcripts. This is only a candidate filter; exact
        // structured ownership checks below remain authoritative.
        let encoded_run = serde_json::to_string(run).map_err(|e| e.to_string())?;
        let encoded_session = session.map(serde_json::to_string).transpose().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT plugin_id,key,value FROM plugin_kv WHERE (key IN (?1,?2) OR substr(key,1,length(?3))=?3) AND (instr(value,?4)>0 OR (?5 IS NOT NULL AND instr(value,?5)>0))")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![INDEX, CONVERSATIONS, DISCUSSION, encoded_run, encoded_session], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    // Invalid unrelated JSON has no verifiable identity and cannot provide policy.
    let rows: Vec<_> = rows
        .into_iter()
        .filter_map(|(plugin, key, raw)| {
            serde_json::from_str::<Value>(&raw)
                .ok()
                .map(|value| (plugin, key, value))
        })
        .collect();
    resolve(
        &rows,
        &Scope {
            run,
            engine,
            workspace,
            session,
        },
    )
}

fn resolve(rows: &[(String, String, Value)], scope: &Scope<'_>) -> Result<Option<String>, String> {
    let mut candidates = Vec::new();
    for (plugin, key, ledger) in rows {
        if key == INDEX {
            for entry in ledger["entries"].as_array().into_iter().flatten() {
                let receipt = &entry["receipt"];
                if entry["identityMismatch"].as_bool() == Some(true)
                    || !scope.workspace(&receipt["workspacePath"])
                    || entry
                        .get("execEngine")
                        .unwrap_or(&entry["newEngine"])
                        .as_str()
                        != Some(scope.engine)
                {
                    continue;
                }
                let owned = entry["conversationOwner"].as_bool() == Some(true)
                    && entry["sessionProven"].as_bool() == Some(true)
                    && scope.session(&receipt["session"])
                    && entry
                        .get("conversationSession")
                        .is_none_or(|v| scope.session(v));
                let exact = receipt["runId"].as_str() == Some(scope.run)
                    && (receipt["session"].is_null() || scope.session(&receipt["session"]));
                let mut records = Vec::new();
                for (_, _, conversations) in rows
                    .iter()
                    .filter(|(p, k, _)| p == plugin && k == CONVERSATIONS)
                {
                    for record in conversations["records"].as_array().into_iter().flatten() {
                        if receipt["requestId"].as_str().is_none()
                            || record["requestId"].as_str() != receipt["requestId"].as_str()
                        {
                            continue;
                        }
                        let continuation = owned
                            && scope.session(&record["sessionRef"])
                            && record["inputs"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .any(|input| {
                                    input["receipt"]["runId"].as_str() == Some(scope.run)
                                        && input["receipt"]["delivery"].as_str() == Some("turn")
                                        && scope.session(&input["receipt"]["sessionRef"])
                                });
                        if continuation || (owned && scope.session(&record["sessionRef"])) {
                            version(conversations)?;
                            records.push(record);
                        }
                    }
                }
                if !exact && !owned {
                    continue;
                }
                version(ledger)?;
                if records.len() > 1 {
                    return Err("Ambiguous plugin fixed-instruction conversation records".into());
                }
                let current = records
                    .first()
                    .and_then(|record| record.get("fixedInstructions"))
                    .or_else(|| entry.get("fixedInstructions"));
                candidates.push(profile(plugin, current)?);
            }
        } else if key.starts_with(DISCUSSION) {
            let snapshot = &ledger["snapshot"];
            if !scope.workspace(&snapshot["workspacePath"])
                || snapshot["selection"]["engine"].as_str() != Some(scope.engine)
                || snapshot["threadId"].as_str() != Some(&key[DISCUSSION.len()..])
            {
                continue;
            }
            let session = &snapshot["sessionRef"];
            let exact = ledger["runId"].as_str() == Some(scope.run)
                && (session.is_null() || scope.session(session));
            if exact || scope.session(session) {
                candidates.push(profile(plugin, ledger.get("fixedInstructions"))?);
            }
        }
    }
    if candidates.len() > 1 {
        return Err("Ambiguous plugin fixed-instruction owners".into());
    }
    let result = candidates.pop().flatten();
    if result.is_some() && !matches!(scope.engine, "claude" | "codex") {
        return Err(
            "Plugin fixed instructions are supported only by local Claude and Codex".into(),
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session() -> Value {
        json!({"engine":"codex","sessionId":"session","workspacePath":"G:/work"})
    }
    fn fixed(version: &str) -> Value {
        json!({"version":version,"text":format!("policy-{version}")})
    }
    fn entry() -> Value {
        json!({"receipt":{"requestId":"task","runId":"initial","workspacePath":"G:/work","session":null},
            "newEngine":"codex","fixedInstructions":fixed("v1")})
    }
    fn owned() -> Value {
        let mut e = entry();
        e["receipt"]["session"] = session();
        e["conversationSession"] = session();
        e["sessionProven"] = json!(true);
        e["conversationOwner"] = json!(true);
        e
    }
    fn index(e: Value) -> (String, String, Value) {
        (
            "plugin".into(),
            INDEX.into(),
            json!({"version":1,"entries":[e]}),
        )
    }
    fn scope<'a>(run: &'a str, session: Option<&'a str>) -> Scope<'a> {
        Scope {
            run,
            engine: "codex",
            workspace: "g:\\WORK\\",
            session,
        }
    }
    fn conversation() -> (String, String, Value) {
        (
            "plugin".into(),
            CONVERSATIONS.into(),
            json!({"version":1,"records":[{
                "requestId":"task","sessionRef":session(),"fixedInstructions":fixed("v2"),
                "inputs":[{"receipt":{"runId":"next","delivery":"turn","status":"starting","sessionRef":session()},"fixedInstructions":fixed("old")}]
            }]}),
        )
    }

    #[test]
    fn fresh_task_and_proven_resume_require_exact_identity() {
        let rows = vec![index(entry())];
        assert!(resolve(&rows, &scope("initial", None))
            .unwrap()
            .unwrap()
            .contains("policy-v1"));
        assert!(resolve(&rows, &scope("other", None)).unwrap().is_none());
        let rows = vec![index(owned())];
        assert!(resolve(&rows, &scope("cold", Some("session")))
            .unwrap()
            .is_some());
        assert!(resolve(&rows, &scope("initial", Some("wrong")))
            .unwrap()
            .is_none());
        let mut s = scope("initial", Some("session"));
        s.workspace = "G:/elsewhere";
        assert!(resolve(&rows, &s).unwrap().is_none());
        s.workspace = "G:/work";
        s.engine = "claude";
        assert!(resolve(&rows, &s).unwrap().is_none());
        for field in ["conversationOwner", "sessionProven"] {
            let mut e = owned();
            e[field] = json!(false);
            assert!(resolve(&[index(e)], &scope("cold", Some("session")))
                .unwrap()
                .is_none());
        }
        let mut e = owned();
        e["identityMismatch"] = json!(true);
        assert!(resolve(&[index(e)], &scope("initial", Some("session")))
            .unwrap()
            .is_none());
    }

    #[test]
    fn current_profile_replaces_initial_and_input_profiles_on_turn_and_cold_restore() {
        let rows = vec![index(owned()), conversation()];
        for run in ["next", "cold", "initial"] {
            let text = resolve(&rows, &scope(run, Some("session")))
                .unwrap()
                .unwrap();
            assert_eq!(text.matches("policy-v2").count(), 1);
            assert!(!text.contains("policy-v1") && !text.contains("policy-old"));
        }
        let mut inherited = conversation();
        inherited.2["records"][0]
            .as_object_mut()
            .unwrap()
            .remove("fixedInstructions");
        assert!(resolve(
            &[index(owned()), inherited],
            &scope("next", Some("session"))
        )
        .unwrap()
        .unwrap()
        .contains("policy-v1"));
        let mut alien = conversation();
        alien.0 = "other-plugin".into();
        assert!(
            resolve(&[index(owned()), alien], &scope("next", Some("session")))
                .unwrap()
                .unwrap()
                .contains("policy-v1")
        );
        let mut alien = conversation();
        alien.2["records"][0]["sessionRef"]["sessionId"] = json!("other");
        assert!(
            resolve(&[index(owned()), alien], &scope("next", Some("session")))
                .unwrap()
                .unwrap()
                .contains("policy-v1")
        );
    }

    #[test]
    fn discussion_launch_and_resume_use_native_identity() {
        let mut row = (
            "plugin".into(),
            format!("{DISCUSSION}thread"),
            json!({
                "snapshot":{"threadId":"thread","workspacePath":"G:/work","selection":{"engine":"codex"},"sessionRef":null},
                "runId":"initial","fixedInstructions":fixed("v1")
            }),
        );
        assert!(resolve(&[row.clone()], &scope("initial", None))
            .unwrap()
            .is_some());
        row.2["snapshot"]["sessionRef"] = session();
        assert!(resolve(&[row.clone()], &scope("cold", Some("session")))
            .unwrap()
            .is_some());
        assert!(resolve(&[row], &scope("cold", Some("wrong")))
            .unwrap()
            .is_none());
    }

    #[test]
    fn ambiguity_and_matched_malformed_or_future_profiles_fail_closed() {
        let mut second = index(owned());
        second.0 = "other".into();
        assert!(resolve(&[index(owned()), second], &scope("next", Some("session"))).is_err());
        for bad in [
            json!(null),
            json!({"version":"bad version","text":"ok"}),
            json!({"version":"v1","text":""}),
            json!({"version":"v1","text":" \n\t"}),
            json!({"version":"v1","text":"ok","unexpected":true}),
            json!({"version":"v1","text":"x\u{0}"}),
            json!({"version":"v1","text":"🧭".repeat(8001)}),
            json!({"version":"x".repeat(129),"text":"ok"}),
        ] {
            let mut e = entry();
            e["fixedInstructions"] = bad;
            assert!(resolve(&[index(e.clone())], &scope("initial", None)).is_err());
            assert!(resolve(&[index(e)], &scope("unrelated", None))
                .unwrap()
                .is_none());
        }
        assert!(profile(
            "plugin",
            Some(&json!({"version":"v1","text":"🧭".repeat(8000)}))
        )
        .is_ok());
        let mut future = index(entry());
        future.2["version"] = json!(2);
        assert!(resolve(&[future.clone()], &scope("initial", None)).is_err());
        assert!(resolve(&[future], &scope("unrelated", None))
            .unwrap()
            .is_none());
        let mut e = entry();
        e["newEngine"] = json!("gemini");
        let mut s = scope("initial", None);
        s.engine = "gemini";
        assert!(resolve(&[index(e)], &s).is_err());
    }

    #[test]
    fn database_lookup_observes_latest_persisted_profile() {
        let root = std::env::temp_dir().join(format!("plugin-policy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let db = crate::db::Db::open_at(&root.join("app.db")).unwrap();
        db.plugin_kv_set("plugin", INDEX, &index(owned()).2)
            .unwrap();
        let read = || {
            lookup(&db, "next", "codex", "G:/work", Some("session"))
                .unwrap()
                .unwrap()
        };
        assert!(read().contains("policy-v1"));
        db.plugin_kv_set("plugin", CONVERSATIONS, &conversation().2)
            .unwrap();
        assert!(read().contains("policy-v2"));
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
