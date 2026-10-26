//! Deterministic deferred queries; no CLI, filesystem, settings, or network access.
use super::*;
use std::{future::Future, pin::Pin, task::Poll};

#[cfg(windows)]
#[tokio::test]
async fn agy_background_catalog_json_and_tsv_fallback_receive_true() {
    use crate::engine::agy::background_tests::Fixture;
    let json = Fixture::new(
        "echo {\"status\":\"SUCCESS\",\"command\":{\"name\":\"models\",\"data\":{\"models\":[{\"id\":\"%AGY_CLI_DISABLE_AUTO_UPDATE%\",\"label\":\"Fixture\"}]}}}",
    );
    let result = agy_catalog(&json.bin()).await;
    assert!(result.authoritative);
    assert_eq!(result.models[0].id, "true");
    assert_eq!(json.calls(), ["--output-format json models"]);

    let tsv = Fixture::new(
        "if \"%1\"==\"--output-format\" exit /b 2\r\necho %AGY_CLI_DISABLE_AUTO_UPDATE%\tFixture",
    );
    let result = agy_catalog(&tsv.bin()).await;
    assert!(result.authoritative);
    assert_eq!(result.models[0].id, "true");
    assert_eq!(tsv.calls(), ["--output-format json models", "models"]);
}

fn key(bin: &str, home: &str) -> CacheKey {
    (bin.into(), home.into())
}

fn catalog(id: &str, authoritative: bool) -> EngineCatalog {
    EngineCatalog {
        models: vec![model(id, "Fixture")],
        authoritative,
        remote: false,
    }
}

async fn assert_pending<T>(mut future: Pin<&mut impl Future<Output = T>>) {
    std::future::poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
}

#[tokio::test]
async fn agy_flight_overlapping_same_key_runs_one_query() {
    let flights = CatalogFlights::default();
    let calls = AtomicU64::new(0);
    let (release, gate) = tokio::sync::oneshot::channel::<()>();
    let mut leader = Box::pin(flights.resolve(key("agy", "home"), async {
        calls.fetch_add(1, Ordering::Relaxed);
        gate.await.unwrap();
        catalog("live", true)
    }));
    assert_pending(leader.as_mut()).await;
    let mut waiter = Box::pin(flights.resolve(key("agy", "home"), async {
        calls.fetch_add(1, Ordering::Relaxed);
        catalog("unexpected", false)
    }));
    assert_pending(waiter.as_mut()).await;
    release.send(()).unwrap();
    assert_eq!(leader.await.models[0].id, "live");
    let result = waiter.await;
    assert_eq!(result.models[0].id, "live");
    assert!(result.authoritative);
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn agy_flight_different_binary_and_home_do_not_block_each_other() {
    let flights = CatalogFlights::default();
    let mut leader = Box::pin(flights.resolve(key("agy", "home"), std::future::pending()));
    assert_pending(leader.as_mut()).await;
    for identity in [key("other", "home"), key("agy", "other")] {
        let result = flights
            .resolve(identity, async { catalog("independent", true) })
            .await;
        assert_eq!(result.models[0].id, "independent");
    }
}

#[tokio::test]
async fn agy_flight_success_and_failure_do_not_cache_independent_refreshes() {
    let flights = CatalogFlights::default();
    let calls = AtomicU64::new(0);
    for authoritative in [true, false, true, false] {
        let result = flights
            .resolve(key("agy", "home"), async {
                let number = calls.fetch_add(1, Ordering::Relaxed);
                catalog(&number.to_string(), authoritative)
            })
            .await;
        assert_eq!(result.authoritative, authoritative);
        assert_eq!(
            result.models[0].id,
            (calls.load(Ordering::Relaxed) - 1).to_string()
        );
    }
    assert_eq!(calls.load(Ordering::Relaxed), 4);
    // Registration prunes dead entries for unrelated keys as well.
    flights
        .resolve(key("new", "home"), async { catalog("new", true) })
        .await;
    assert_eq!(flights.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn agy_flight_cancelled_leader_releases_query_and_waiter_takes_over() {
    let flights = CatalogFlights::default();
    let calls = AtomicU64::new(0);
    let (release, gate) = tokio::sync::oneshot::channel::<()>();
    let mut leader = Box::pin(flights.resolve(key("agy", "home"), async {
        calls.fetch_add(1, Ordering::Relaxed);
        gate.await.unwrap();
        catalog("cancelled", true)
    }));
    assert_pending(leader.as_mut()).await;
    let mut waiter = Box::pin(flights.resolve(key("agy", "home"), async {
        calls.fetch_add(1, Ordering::Relaxed);
        catalog("replacement", true)
    }));
    assert_pending(waiter.as_mut()).await;
    drop(leader);
    assert!(
        release.is_closed(),
        "cancelled query must not survive as an orphan task"
    );
    let result = waiter.await;
    assert_eq!(result.models[0].id, "replacement");
    assert!(result.authoritative);
    assert_eq!(calls.load(Ordering::Relaxed), 2);
}
