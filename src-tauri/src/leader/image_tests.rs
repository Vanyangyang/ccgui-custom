//! Native ledger regression tests; no CLI or model is launched.
use super::*;

#[tokio::test]
async fn stop_invalidates_unlocked_preparation_even_twice_in_the_same_clock_tick() {
    let f = basic();
    let (id, run) = spawn(&f, "preparation-stop");
    settle(&f, &id, &run, "preparation-stop-session");
    let before = branch(&f, &id);
    let first = f.manager.stop(&f.parent, &id).await.unwrap();
    assert_eq!(first.state, "stopped");
    assert!(!same_assignment_source(&first, &before));
    let second = f.manager.stop(&f.parent, &id).await.unwrap();
    assert_eq!(second.state, "stopped");
    assert_eq!(first.run_id, second.run_id);
    assert!(second.updated_at > first.updated_at, "a second explicit stop must invalidate an in-flight read even on a frozen clock");
    assert!(!same_assignment_source(&second, &first));
}
use std::{ffi::OsString, path::PathBuf};

// HOME is process-global. A mutex only serializes writers, not unrelated
// settings readers in other tests, so each profile-changing case runs alone.
fn in_image_test_process(name: &str) -> bool {
    const MARKER: &str = "CCGUI_MANAGED_IMAGE_TEST";
    let name = format!("leader::tests::image_tests::{name}");
    if std::env::var(MARKER).as_deref() == Ok(name.as_str()) { return true; }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([name.as_str(), "--exact", "--nocapture", "--test-threads=1"])
        .env(MARKER, &name).output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success() && stdout.contains("1 passed"),
        "isolated image case {name} failed:\n{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
    false
}

struct ImageHome {
    root: PathBuf,
    workspace: PathBuf,
    home: Option<OsString>,
    profile: Option<OsString>,
    _lock: parking_lot::MutexGuard<'static, ()>,
}

impl ImageHome {
    fn new() -> Self {
        assert!(std::env::var_os("CCGUI_MANAGED_IMAGE_TEST").is_some(), "profile-changing tests must run in their isolated child process");
        let lock = crate::paths::HOME_ENV_LOCK.lock();
        let root =
            std::env::temp_dir().join(format!("leader-image-ledger-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("图片工作区");
        std::fs::create_dir_all(&workspace).unwrap();
        let environment = Self {
            root,
            workspace,
            home: std::env::var_os("HOME"),
            profile: std::env::var_os("USERPROFILE"),
            _lock: lock,
        };
        unsafe {
            std::env::set_var("HOME", &environment.root);
            std::env::set_var("USERPROFILE", &environment.root);
        }
        // Never silently fall back to the real application profile.
        assert!(crate::paths::app_home().starts_with(&environment.root));
        environment
    }

    fn fixture(&self) -> Fixture {
        fixture_with_workspace(
            Arc::new(|_, _, _| Ok(())),
            "claude",
            self.workspace.to_str().unwrap(),
        )
    }

    fn image(&self, name: &str) -> String {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==")
            .unwrap();
        std::fs::write(self.workspace.join(name), bytes).unwrap();
        name.into()
    }
}

impl Drop for ImageHome {
    fn drop(&mut self) {
        unsafe {
            match &self.home {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
            match &self.profile {
                Some(value) => std::env::set_var("USERPROFILE", value),
                None => std::env::remove_var("USERPROFILE"),
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn image_child(f: &Fixture, request_id: &str, images: Vec<String>) -> (String, String) {
    let mut input = args(request_id);
    input.images = images;
    let Reservation::Start(result) = f
        .manager
        .reserve_spawn(
            &f.caller,
            &f.parent,
            "manual",
            &input,
            encoded(&input).unwrap(),
            Some("image-test-model".into()),
            Some("high".into()),
        )
        .unwrap()
    else {
        panic!("unexpected replay");
    };
    result
}

fn hold_image(f: &Fixture, id: &str, request_id: &str, images: Vec<String>) -> SendArgs {
    let input = SendArgs {
        branch_id: id.into(),
        request_id: request_id.into(),
        message: "Preserve every requirement 中文 😀 and inspect the attached original.".into(),
        images,
    };
    let Reservation::Replay(receipt) = f
        .manager
        .reserve_send(
            &f.caller,
            &f.parent,
            "manual",
            &input,
            encoded(&input).unwrap(),
        )
        .unwrap()
    else {
        panic!("cold continuation started before review");
    };
    assert_eq!(receipt["status"], "awaiting_cost_approval");
    assert_eq!(receipt["submitted_to_model"], false);
    assert_eq!(receipt["mayHaveStarted"], false);
    input
}

fn held_image(home: &ImageHome) -> (Fixture, String, SendArgs) {
    let f = home.fixture();
    let (id, run) = image_child(&f, "source", Vec::new());
    settle(&f, &id, &run, "image-source-session");
    let input = hold_image(&f, &id, "held-image", vec![home.image("原图😀.png")]);
    (f, id, input)
}

#[test]
fn image_spawn_and_hot_send_preserve_manifest_then_text_clears_it() {
    if !in_image_test_process("image_spawn_and_hot_send_preserve_manifest_then_text_clears_it") { return; }
    let home = ImageHome::new();
    let f = home.fixture();
    let original = home.image("spawn.png");
    let (id, run) = image_child(&f, "image-spawn", vec![original.clone()]);
    let spawned = branch(&f, &id);
    assert_eq!(spawned.images.len(), 1);
    assert_eq!(spawned.images[0].source, original);
    assert_eq!(spawned.delegation.as_ref().unwrap().images, spawned.images);
    let paths = attachments::paths(&spawned.images).unwrap().unwrap();
    assert_eq!(
        std::fs::read(&paths[0]).unwrap(),
        std::fs::read(home.workspace.join(&original)).unwrap()
    );
    assert!(dunce::canonicalize(&paths[0]).unwrap().starts_with(
        dunce::canonicalize(crate::engine::images::pasted_images_dir()).unwrap()));

    settle(&f, &id, &run, "image-hot-session");
    hot_send_cache(&f, &id);
    let input = SendArgs {
        branch_id: id.clone(),
        request_id: "hot-image".into(),
        message: "Second assignment".into(),
        images: vec![home.image("second.png")],
    };
    let Reservation::Start((sent, run)) = f
        .manager
        .reserve_send(
            &f.caller,
            &f.parent,
            "manual",
            &input,
            encoded(&input).unwrap(),
        )
        .unwrap()
    else {
        panic!("hot image continuation was held");
    };
    assert_eq!(sent.images[0].source, input.images[0]);
    assert_eq!(sent.delegation.as_ref().unwrap().images, sent.images);
    settle(&f, &id, &run, "image-hot-session");
    hot_send_cache(&f, &id);
    let text = SendArgs {
        branch_id: id,
        request_id: "text-after-image".into(),
        message: "Text only".into(),
        images: Vec::new(),
    };
    let Reservation::Start((sent, _)) = f
        .manager
        .reserve_send(
            &f.caller,
            &f.parent,
            "manual",
            &text,
            encoded(&text).unwrap(),
        )
        .unwrap()
    else {
        panic!("hot text continuation was held");
    };
    assert!(sent.images.is_empty());
    assert!(sent.delegation.as_ref().unwrap().images.is_empty());
    assert!(attachments::paths(&sent.images).unwrap().is_none());
}

#[test]
fn held_images_are_reviewed_and_replay_uses_durable_original_after_source_deletion() {
    if !in_image_test_process("held_images_are_reviewed_and_replay_uses_durable_original_after_source_deletion") { return; }
    let home = ImageHome::new();
    let (f, id, input) = held_image(&home);
    let held = branch(&f, &id);
    assert_eq!(held.task, input.message);
    assert_eq!(held.delegation.as_ref().unwrap().images, held.images);
    assert_eq!(
        held.cost_approval.as_ref().unwrap().image_refs,
        attachments::refs(&held.images)
    );
    assert_eq!(
        held.delegation
            .as_ref()
            .unwrap()
            .cost_approval
            .as_ref()
            .unwrap()
            .image_refs,
        attachments::refs(&held.images)
    );
    std::fs::remove_file(home.workspace.join(&input.images[0])).unwrap();
    assert!(matches!(
        f.manager
            .reserve_send(
                &f.caller,
                &f.parent,
                "manual",
                &input,
                encoded(&input).unwrap()
            )
            .unwrap(),
        Reservation::Replay(_)
    ));
    let (approved, _, _) = f
        .manager
        .resolve_cost_approval(
            &f.parent,
            &id,
            &input.request_id,
            true,
            held.model.as_deref(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(approved.images, held.images);
    assert_eq!(approved.task, input.message);
    assert!(attachments::paths(&approved.images).unwrap().is_some());
}

#[test]
fn handoff_keeps_exact_original_images_after_source_changes_and_is_idempotent() {
    if !in_image_test_process("handoff_keeps_exact_original_images_after_source_changes_and_is_idempotent") { return; }
    let home = ImageHome::new();
    for delete in [false, true] {
        let (f, id, input) = held_image(&home);
        let held = branch(&f, &id);
        let bytes = std::fs::read(&held.images[0].path).unwrap();
        if delete {
            std::fs::remove_file(home.workspace.join(&input.images[0])).unwrap();
        } else {
            std::fs::write(home.workspace.join(&input.images[0]), b"changed source").unwrap();
        }
        let (next, run, _, _) = handoff(
            &f,
            &id,
            &input.request_id,
            "image-handoff",
            "Verified summary 中文",
        )
        .unwrap()
        .unwrap();
        assert!(next.task.ends_with(&input.message));
        assert!(next.task.contains("Verified summary 中文"));
        assert_eq!(next.images, held.images);
        assert_eq!(next.delegation.as_ref().unwrap().images, held.images);
        assert_eq!(
            std::fs::read(&attachments::paths(&next.images).unwrap().unwrap()[0]).unwrap(),
            bytes
        );
        assert!(f.manager.processes.get(&run).is_none());
        let rows = content_rows(&f);
        let run_count = f.manager.inner.lock().runs.len();
        assert!(handoff(
            &f,
            &id,
            &input.request_id,
            "image-handoff",
            "Verified summary 中文"
        )
        .unwrap()
        .is_none());
        assert_eq!(content_rows(&f), rows);
        assert_eq!(f.manager.inner.lock().runs.len(), run_count);
    }
}

#[test]
fn held_images_restore_and_approve_without_reading_source_again() {
    if !in_image_test_process("held_images_restore_and_approve_without_reading_source_again") { return; }
    let home = ImageHome::new();
    let (f, id, input) = held_image(&home);
    let held = branch(&f, &id);
    std::fs::remove_file(home.workspace.join(&input.images[0])).unwrap();
    let restored = reload(&f).unwrap();
    let saved = restored.inner.lock().branches[&id].branch.clone();
    assert_eq!(saved.images, held.images);
    assert_eq!(saved.delegation.as_ref().unwrap().images, held.images);
    let (approved, _, _) = restored
        .resolve_cost_approval(
            &f.parent,
            &id,
            &input.request_id,
            true,
            held.model.as_deref(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(approved.images, held.images);
    assert_eq!(approved.task, input.message);
    assert!(attachments::paths(&approved.images).unwrap().is_some());
}

#[test]
fn image_handoff_multihop_alias_and_recovery_preserve_request_identity() {
    if !in_image_test_process("image_handoff_multihop_alias_and_recovery_preserve_request_identity") { return; }
    let home = ImageHome::new();
    let (f, original, first_input) = held_image(&home);
    let (second, run, _, _) = handoff(
        &f,
        &original,
        &first_input.request_id,
        "first-image-hop",
        "First summary",
    )
    .unwrap()
    .unwrap();
    settle(&f, &second.id, &run, "second-image-session");
    let alias = hold_image(&f, &original, "alias-image", vec![home.image("alias.png")]);
    let held = branch(&f, &second.id);
    let receipt =
        f.manager.inner.lock().requests[&(key(&f.parent), alias.request_id.clone())].clone();
    assert_eq!(receipt.branch_id, second.id);
    assert_eq!(
        receipt.requested_branch_id.as_deref(),
        Some(original.as_str())
    );
    assert_eq!(
        receipt.arguments_fingerprint,
        Some(arguments_fingerprint(&encoded(&alias).unwrap()).unwrap())
    );
    std::fs::remove_file(home.workspace.join(&alias.images[0])).unwrap();
    let (third, _, _, _) = handoff(
        &f,
        &second.id,
        &alias.request_id,
        "second-image-hop",
        "Second summary",
    )
    .unwrap()
    .unwrap();
    assert_eq!(third.images, held.images);
    assert!(third.task.ends_with(&alias.message));
    let restored = reload(&f).unwrap();
    let inner = restored.inner.lock();
    assert_eq!(inner.branches[&third.id].branch.images, third.images);
    assert_eq!(
        inner.branches[&third.id]
            .branch
            .delegation
            .as_ref()
            .unwrap()
            .images,
        third.images
    );
    assert_eq!(
        restored
            .resolve_child_id(&inner, &f.parent, &original)
            .unwrap(),
        third.id
    );
    let replay = restored
        .replay(
            &inner,
            &f.parent,
            &first_input.request_id,
            "task_send",
            &encoded(&first_input).unwrap(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(replay["actualBranchId"], third.id);
    assert_eq!(replay["handoffChain"].as_array().unwrap().len(), 2);
    assert!(attachments::paths(&inner.branches[&third.id].branch.images)
        .unwrap()
        .is_some());
}

#[test]
fn unavailable_or_tampered_copy_rejects_handoff_before_mutating_held_request() {
    if !in_image_test_process("unavailable_or_tampered_copy_rejects_handoff_before_mutating_held_request") { return; }
    let home = ImageHome::new();
    for missing in [false, true] {
        let (f, id, input) = held_image(&home);
        let held = branch(&f, &id);
        let original = std::fs::read(&held.images[0].path).unwrap();
        if missing {
            std::fs::remove_file(&held.images[0].path).unwrap();
        } else {
            std::fs::write(&held.images[0].path, b"corrupted durable image").unwrap();
        }
        let before = content_rows(&f);
        let runs = f.manager.inner.lock().runs.len();
        assert!(handoff(&f, &id, &input.request_id, "failed-image-hop", "Summary").is_err());
        assert_eq!(content_rows(&f), before);
        assert_eq!(encoded(&branch(&f, &id)).unwrap(), encoded(&held).unwrap());
        assert_eq!(f.manager.inner.lock().runs.len(), runs);
        assert_eq!(
            f.manager.inner.lock().requests[&(key(&f.parent), input.request_id.clone())].state,
            "awaiting_cost_approval"
        );
        // Restore only this temporary fixture's copy for the next iteration.
        std::fs::write(&held.images[0].path, original).unwrap();
    }
}

#[test]
fn mismatched_review_branch_or_delegation_images_reject_approval_and_handoff() {
    if !in_image_test_process("mismatched_review_branch_or_delegation_images_reject_approval_and_handoff") { return; }
    let home = ImageHome::new();
    for altered in ["review", "branch", "delegation"] {
        let (f, id, input) = held_image(&home);
        let reviewed = branch(&f, &id).model;
        {
            let mut inner = f.manager.inner.lock();
            let held = &mut inner.branches.get_mut(&id).unwrap().branch;
            match altered {
                "review" => {
                    held.cost_approval.as_mut().unwrap().image_refs =
                        vec![format!("task-image:{}", "0".repeat(64))]
                }
                "branch" => held.images.clear(),
                "delegation" => held.delegation.as_mut().unwrap().images.clear(),
                _ => unreachable!(),
            }
        }
        let rows = content_rows(&f);
        assert!(
            handoff(&f, &id, &input.request_id, "mismatched-images", "Summary").is_err(),
            "accepted {altered} mismatch"
        );
        assert!(
            f.manager
                .resolve_cost_approval(&f.parent, &id, &input.request_id, true, reviewed.as_deref())
                .is_err(),
            "approved {altered} mismatch"
        );
        assert_eq!(content_rows(&f), rows);
        assert_eq!(branch(&f, &id).state, "awaiting_cost_approval");
    }
}

#[test]
fn legacy_empty_images_keep_old_encoded_arguments_and_fingerprints() {
    if !in_image_test_process("legacy_empty_images_keep_old_encoded_arguments_and_fingerprints") { return; }
    let send_json =
        json!({"branch_id":"legacy-child", "request_id":"legacy-send", "message":"Continue"});
    let send: SendArgs = serde_json::from_value(send_json.clone()).unwrap();
    assert!(send.images.is_empty());
    assert_eq!(encoded(&send).unwrap(), send_json);
    assert_eq!(
        validate_arguments("task_send", send_json.clone()).unwrap(),
        send_json
    );
    assert_eq!(
        arguments_fingerprint(&encoded(&send).unwrap()).unwrap(),
        arguments_fingerprint(&send_json).unwrap()
    );
    let spawn_json = json!({"request_id":"legacy-spawn", "engine":"codex", "title":"Old child", "task":"Continue", "model":null, "effort":null, "ttl_seconds":60});
    let spawn: SpawnArgs = serde_json::from_value(spawn_json.clone()).unwrap();
    assert!(spawn.images.is_empty());
    assert_eq!(encoded(&spawn).unwrap(), spawn_json);
    assert_eq!(
        validate_arguments("task_spawn", spawn_json.clone()).unwrap(),
        spawn_json
    );
    assert_eq!(
        arguments_fingerprint(&encoded(&spawn).unwrap()).unwrap(),
        arguments_fingerprint(&spawn_json).unwrap()
    );

    let home = ImageHome::new();
    let f = home.fixture();
    let (id, run) = image_child(&f, "legacy-record", Vec::new());
    settle(&f, &id, &run, "legacy-image-session");
    let held = held_send(&f, &id, "legacy-review");
    let value = encoded(&branch(&f, &id)).unwrap();
    assert!(value.get("images").is_none());
    assert!(value["delegation"].get("images").is_none());
    assert!(value["costApproval"].get("imageRefs").is_none());
    let decoded: LeaderBranch = serde_json::from_value(value).unwrap();
    assert!(decoded.images.is_empty());
    assert!(decoded.delegation.as_ref().unwrap().images.is_empty());
    let restored = reload(&f).unwrap();
    assert!(restored
        .resolve_cost_approval(
            &f.parent,
            &id,
            &held.request_id,
            true,
            decoded.model.as_deref()
        )
        .unwrap()
        .is_some());
}
