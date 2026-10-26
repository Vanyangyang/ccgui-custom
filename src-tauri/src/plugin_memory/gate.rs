//! A synchronous admission fence; foreground never awaits background inference.
use parking_lot::Mutex;
use std::{
    collections::VecDeque,
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub(crate) static GATE: LazyLock<Arc<Gate>> = LazyLock::new(|| Arc::new(Gate::new()));
pub(crate) struct Gate(Mutex<State>);
struct State {
    epoch: u64,
    foreground: usize,
    quiet_since: Option<Instant>,
    calls: VecDeque<Instant>,
    backoff: Option<Instant>,
    failures: u32,
    stopped: bool,
    active: Option<(u64, String, String, watch::Sender<bool>)>,
    cancelled_requests: VecDeque<(Instant, String, String)>,
}
pub(crate) struct Foreground(Arc<Gate>);
pub(crate) struct Lease {
    gate: Arc<Gate>,
    pub epoch: u64,
    pub cancelled: watch::Receiver<bool>,
}
impl Lease {
    pub async fn run<T>(&mut self, future: impl std::future::Future<Output = T>) -> Result<T, ()> {
        if *self.cancelled.borrow() || !self.gate.valid(self.epoch) {
            return Err(());
        }
        tokio::select! { biased; _=self.cancelled.changed()=>Err(()), value=future=>Ok(value) }
    }
}
impl Gate {
    pub fn new() -> Self {
        Self(Mutex::new(State {
            epoch: 0,
            foreground: 0,
            quiet_since: None,
            calls: VecDeque::new(),
            backoff: None,
            failures: 0,
            stopped: false,
            active: None,
            cancelled_requests: VecDeque::new(),
        }))
    }
    #[cfg(test)]
    pub(crate) fn test_ready() -> Arc<Self> {
        let gate = Arc::new(Self::new());
        gate.0.lock().quiet_since = Some(Instant::now() - Duration::from_secs(31));
        gate
    }
    fn invalidate(s: &mut State) {
        s.epoch = s.epoch.wrapping_add(1);
        s.quiet_since = None;
        if let Some((_, _, _, tx)) = &s.active {
            tx.send_replace(true);
        }
    }
    pub fn foreground(self: &Arc<Self>) -> Foreground {
        let mut s = self.0.lock();
        s.foreground += 1;
        Self::invalidate(&mut s);
        Foreground(self.clone())
    }
    pub fn cancel(&self, owner: Option<(&str, &str)>, shutdown: bool) {
        let mut s = self.0.lock();
        if let Some((plugin, request)) = owner {
            // A dispose/cancel IPC may overtake extract before admission.
            // Bounded tombstones prevent that request from starting afterwards.
            if s.cancelled_requests.len() >= 256 {
                s.cancelled_requests.pop_front();
                s.backoff = Some(Instant::now() + Duration::from_secs(120));
            }
            s.cancelled_requests
                .push_back((Instant::now(), plugin.into(), request.into()));
        }
        if owner.is_none()
            || s.active
                .as_ref()
                .is_some_and(|(_, p, r, _)| owner == Some((p.as_str(), r.as_str())))
        {
            Self::invalidate(&mut s);
        }
        s.stopped |= shutdown;
    }
    #[cfg(test)]
    pub fn epoch(&self) -> u64 {
        self.0.lock().epoch
    }
    pub fn read_epoch(&self, busy: impl FnOnce() -> bool, paused: bool) -> Result<u64, ()> {
        let mut s = self.0.lock();
        if busy() || paused || s.foreground > 0 || s.stopped {
            Self::invalidate(&mut s);
            return Err(());
        }
        if s.active.is_some() {
            return Err(());
        }
        Ok(s.epoch)
    }
    pub fn valid(&self, epoch: u64) -> bool {
        let s = self.0.lock();
        s.epoch == epoch && s.foreground == 0 && !s.stopped
    }
    fn delay(s: &mut State, now: Instant, registry_busy: bool, paused: bool) -> u64 {
        if registry_busy || paused || s.foreground > 0 || s.stopped {
            Self::invalidate(s);
            return 30_000;
        }
        if s.active.is_some() {
            return 30_000;
        }
        let quiet = *s.quiet_since.get_or_insert(now);
        let mut due = quiet + Duration::from_secs(30);
        if let Some(last) = s.calls.back() {
            due = due.max(*last + Duration::from_secs(60));
        }
        while s
            .calls
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= Duration::from_secs(3600))
        {
            s.calls.pop_front();
        }
        if s.calls.len() >= 6 {
            due = due.max(s.calls[0] + Duration::from_secs(3600));
        }
        if let Some(backoff) = s.backoff {
            due = due.max(backoff);
        }
        due.saturating_duration_since(now)
            .as_millis()
            .min(u64::MAX as u128) as u64
    }
    pub fn status(&self, busy: impl FnOnce() -> bool, paused: bool) -> u64 {
        Self::delay(&mut self.0.lock(), Instant::now(), busy(), paused)
    }
    pub fn admit(
        self: &Arc<Self>,
        plugin: &str,
        request: &str,
        busy: impl FnOnce() -> bool,
        paused: bool,
    ) -> Result<Lease, u64> {
        let mut s = self.0.lock();
        let now = Instant::now();
        while s
            .cancelled_requests
            .front()
            .is_some_and(|(t, _, _)| now.saturating_duration_since(*t) >= Duration::from_secs(120))
        {
            s.cancelled_requests.pop_front();
        }
        if s.cancelled_requests
            .iter()
            .any(|(_, p, r)| p == plugin && r == request)
        {
            return Err(120_000);
        }
        let delay = Self::delay(&mut s, now, busy(), paused);
        if delay > 0 {
            return Err(delay);
        }
        let (tx, rx) = watch::channel(false);
        let epoch = s.epoch;
        s.active = Some((epoch, plugin.into(), request.into(), tx));
        // Count admissions conservatively, even when local validation returns empty.
        s.calls.push_back(now);
        Ok(Lease {
            gate: self.clone(),
            epoch,
            cancelled: rx,
        })
    }
    pub fn failure(&self, retry_after: Option<u64>) -> u64 {
        let mut s = self.0.lock();
        s.failures = (s.failures + 1).min(6);
        let jitter = (uuid::Uuid::new_v4().as_u128() % 10_001) as u64;
        let delay = retry_after
            .unwrap_or(30_000u64 << s.failures)
            .clamp(60_000, 3_600_000)
            .saturating_add(jitter)
            .min(3_600_000);
        s.backoff = Some(Instant::now() + Duration::from_millis(delay));
        delay
    }
    pub fn success(&self) {
        let mut s = self.0.lock();
        s.failures = 0;
        s.backoff = None;
    }
}
impl Drop for Foreground {
    fn drop(&mut self) {
        let mut s = self.0 .0.lock();
        s.foreground -= 1;
        s.quiet_since = None;
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut s = self.gate.0.lock();
        if s.active
            .as_ref()
            .is_some_and(|(epoch, _, _, _)| *epoch == self.epoch)
        {
            s.active = None;
            // Timestamp completion, not only admission: slow local preparation
            // must not erase the >=60s spacing between actual HTTP calls.
            if let Some(last) = s.calls.back_mut() {
                *last = Instant::now();
            }
        }
    }
}
pub(crate) fn foreground() -> Foreground {
    GATE.foreground()
}
pub(crate) fn cancel_all(shutdown: bool) {
    GATE.cancel(None, shutdown);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ready() -> Arc<Gate> {
        Gate::test_ready()
    }
    #[test]
    fn foreground_invalidates_before_reservation_and_cannot_admit() {
        let g = ready();
        let lease = g.admit("p", "r", || false, false).unwrap();
        let guard = g.foreground();
        assert!(*lease.cancelled.borrow());
        assert!(!g.valid(lease.epoch));
        assert!(g.admit("p", "s", || false, false).is_err());
        drop(guard);
        drop(lease);
        assert!(g.status(|| false, false) >= 29_000);
    }
    #[test]
    fn registry_reservations_maintenance_and_scoped_cancel() {
        let g = ready();
        assert!(g.admit("p", "r", || true, false).is_err());
        let g = ready();
        let lease = g.admit("p", "r", || false, false).unwrap();
        g.cancel(Some(("other", "r")), false);
        assert!(g.valid(lease.epoch));
        assert!(g.status(|| false, true) > 0);
        assert!(*lease.cancelled.borrow());
        g.cancel(None, true);
        drop(lease);
        assert!(!g.valid(g.epoch()));
    }
    #[test]
    fn singleton_cooldown_hourly_and_retry_limits() {
        let g = ready();
        let a = g.admit("p", "a", || false, false).unwrap();
        assert!(g.admit("p", "b", || false, false).is_err());
        drop(a);
        assert!(g.status(|| false, false) > 59_000);
        {
            let mut s = g.0.lock();
            s.calls = (0..6)
                .map(|i| Instant::now() - Duration::from_secs(100 + i))
                .collect();
        }
        assert!(g.status(|| false, false) > 3_000_000);
        assert!((60_000..=70_000).contains(&g.failure(Some(100))));
        assert_eq!(g.failure(Some(u64::MAX)), 3_600_000);
    }
    #[tokio::test]
    async fn foreground_drops_pending_admission_headers_and_streaming_body() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        for phase in ["admission", "headers", "body"] {
            let g = ready();
            let mut lease = g.admit("p", phase, || false, false).unwrap();
            let started = Arc::new(tokio::sync::Notify::new());
            let dropped = Arc::new(AtomicBool::new(false));
            let inference = async {
                let _drop = Dropped(dropped.clone());
                started.notify_one();
                std::future::pending::<()>().await;
            };
            let epoch = lease.epoch;
            let front = async {
                started.notified().await;
                let _guard = g.foreground();
                assert!(!g.valid(epoch));
            };
            let (result, ()) = tokio::join!(lease.run(inference), front);
            assert!(result.is_err(), "{phase}");
            assert!(dropped.load(Ordering::SeqCst), "{phase}");
        }
    }
    #[tokio::test]
    async fn cancellation_before_poll_prevents_network_and_rejects_late_success() {
        let g = ready();
        let mut lease = g.admit("p", "r", || false, false).unwrap();
        let guard = g.foreground();
        drop(guard);
        assert!(lease
            .run(async {
                panic!("cancelled future must not poll");
            })
            .await
            .is_err());
        assert!(!g.valid(lease.epoch));
    }
    #[test]
    fn cancel_before_admission_is_scoped_and_not_lost() {
        let g = ready();
        g.cancel(Some(("p", "early")), false);
        assert!(g.admit("p", "early", || false, false).is_err());
        assert!(g.admit("other", "early", || false, false).is_ok());
    }
    #[test]
    fn prepare_read_epochs_do_not_consume_quota_or_reset_backoff_and_quiet() {
        let g = ready();
        g.failure(Some(120_000));
        let before = g.0.lock().backoff;
        let quiet = g.0.lock().quiet_since;
        for _ in 0..20 {
            assert!(g.read_epoch(|| false, false).is_ok());
        }
        let state = g.0.lock();
        assert!(state.calls.is_empty());
        assert!(state.active.is_none());
        assert_eq!(state.backoff, before);
        assert_eq!(state.quiet_since, quiet);
        drop(state);
        assert!(g.read_epoch(|| false, true).is_err());
        assert!(g.read_epoch(|| true, false).is_err());
    }
}
