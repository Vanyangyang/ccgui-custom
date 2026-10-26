use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Debug)]
struct FakeSession(Arc<AtomicUsize>);

impl Drop for FakeSession {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

type FakeRegistry = Arc<Mutex<HashMap<String, Arc<FakeSession>>>>;

fn blocked_open(
    registry: FakeRegistry,
    dropped: Arc<AtomicUsize>,
) -> (
    std::thread::JoinHandle<Result<bool, String>>,
    mpsc::Receiver<()>,
    mpsc::Sender<()>,
) {
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime
            .block_on(open_registered_session(&registry, "tab", || {
                started_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok((Arc::new(FakeSession(dropped)), ()))
            }))
            .map(|created| created.is_some())
    });
    (thread, started_rx, release_tx)
}

#[tokio::test]
async fn close_waits_for_creation_and_removes_the_new_session() {
    let registry = FakeRegistry::default();
    let dropped = Arc::new(AtomicUsize::new(0));
    let (opening, started, release) = blocked_open(Arc::clone(&registry), Arc::clone(&dropped));
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    let close = async { registry.lock().await.remove("tab") };
    tokio::pin!(close);
    assert!(tokio::time::timeout(Duration::from_millis(20), &mut close)
        .await
        .is_err());
    release.send(()).unwrap();
    drop(close.await);
    assert!(opening.join().unwrap().unwrap());
    assert!(registry.lock().await.is_empty());
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn shutdown_drain_waits_for_creation_and_includes_the_new_session() {
    let registry = FakeRegistry::default();
    let dropped = Arc::new(AtomicUsize::new(0));
    let (opening, started, release) = blocked_open(Arc::clone(&registry), Arc::clone(&dropped));
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    // kill_all takes this same lock before draining the native registry.
    let shutdown = async { registry.lock().await.drain().collect::<Vec<_>>() };
    tokio::pin!(shutdown);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut shutdown)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    let drained = shutdown.await;
    assert_eq!(drained.len(), 1);
    drop(drained);
    assert!(opening.join().unwrap().unwrap());
    assert!(registry.lock().await.is_empty());
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn duplicate_open_waits_and_never_calls_a_second_factory() {
    let registry = FakeRegistry::default();
    let dropped = Arc::new(AtomicUsize::new(0));
    let (opening, started, release) = blocked_open(Arc::clone(&registry), Arc::clone(&dropped));
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    let duplicate = open_registered_session(&registry, "tab", || {
        panic!("duplicate open must not create another shell");
        #[allow(unreachable_code)]
        Ok((Arc::new(FakeSession(Arc::clone(&dropped))), ()))
    });
    tokio::pin!(duplicate);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut duplicate)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    assert!(duplicate.await.unwrap().is_none());
    assert!(opening.join().unwrap().unwrap());
    assert_eq!(registry.lock().await.len(), 1);
    registry.lock().await.clear();
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn capacity_is_checked_after_an_in_progress_creation_is_registered() {
    let registry = FakeRegistry::default();
    let dropped = Arc::new(AtomicUsize::new(0));
    for id in 0..MAX_TERMINAL_SESSIONS - 1 {
        registry
            .lock()
            .await
            .insert(id.to_string(), Arc::new(FakeSession(Arc::clone(&dropped))));
    }
    let (opening, started, release) = blocked_open(Arc::clone(&registry), Arc::clone(&dropped));
    started.recv_timeout(Duration::from_secs(5)).unwrap();
    let overflow = open_registered_session(&registry, "overflow", || {
        panic!("capacity rejection must precede creating a shell");
        #[allow(unreachable_code)]
        Ok((Arc::new(FakeSession(Arc::clone(&dropped))), ()))
    });
    tokio::pin!(overflow);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut overflow)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    assert!(overflow
        .await
        .unwrap_err()
        .contains("terminal session limit"));
    assert!(opening.join().unwrap().unwrap());
    assert_eq!(registry.lock().await.len(), MAX_TERMINAL_SESSIONS);
}

#[tokio::test]
async fn failed_creation_releases_the_lock_and_does_not_register_a_session() {
    let registry = FakeRegistry::default();
    let dropped = Arc::new(AtomicUsize::new(0));
    let failed = open_registered_session::<FakeSession, ()>(&registry, "tab", || {
        // Model fallible preparation: its resources are dropped on failure.
        let _prepared = FakeSession(Arc::clone(&dropped));
        Err("failed to prepare pty".into())
    })
    .await;
    assert!(failed.is_err());
    assert!(registry.lock().await.is_empty());
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(open_registered_session(&registry, "tab", || {
        Ok((Arc::new(FakeSession(Arc::clone(&dropped))), ()))
    })
    .await
    .unwrap()
    .is_some());
    registry.lock().await.clear();
    assert_eq!(dropped.load(Ordering::SeqCst), 2);
}
