//! Optional local completion audio. No task content or model calls enter this module.
use parking_lot::Mutex;
use std::{collections::BTreeSet, sync::Arc, time::Duration};

const MERGE_DELAY: Duration = Duration::from_secs(3);
const COOLDOWN_MS: u64 = 90_000;
const ENGINES: [&str; 12] = [
    "claude", "codex", "grok", "kimi", "pi", "omp", "dsh", "agy", "cursor", "opencode", "qoder",
    "qoder-cn",
];

fn engine_index(engine: &str) -> usize {
    ENGINES.iter().position(|id| *id == engine).unwrap_or(12)
}
fn quiet(hour: u16) -> bool {
    !(8..22).contains(&hour)
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}
#[cfg(windows)]
fn local_hour() -> u16 {
    // SYSTEMTIME is eight WORDs; keep this small FFI independent of optional
    // windows crate feature selections.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLocalTime(time: *mut [u16; 8]);
    }
    let mut time = [0u16; 8];
    unsafe {
        GetLocalTime(&mut time);
    }
    time[4]
}
#[cfg(not(windows))]
fn local_hour() -> u16 {
    0
}

struct Policy {
    started_at_ms: u64,
    enabled: bool,
    stopped: bool,
    chinese: bool,
    seen: [u64; 13],
    admitted: [Option<u64>; 13],
    pending: BTreeSet<usize>,
}
impl Policy {
    fn new(started_at_ms: u64) -> Self {
        Self {
            started_at_ms,
            enabled: true,
            stopped: false,
            chinese: false,
            seen: [0; 13],
            admitted: [None; 13],
            pending: BTreeSet::new(),
        }
    }
    fn accept(
        &mut self,
        engine: usize,
        completed: u64,
        now: u64,
        hour: u16,
        capable: bool,
    ) -> bool {
        if completed <= self.started_at_ms || completed <= self.seen[engine] {
            return false;
        }
        // Consume suppressed events as well: enabling later never replays them.
        self.seen[engine] = completed;
        if !capable
            || self.stopped
            || !self.enabled
            || quiet(hour)
            || self.admitted[engine].is_some_and(|last| now.saturating_sub(last) < COOLDOWN_MS)
        {
            return false;
        }
        self.admitted[engine] = Some(now);
        self.pending.insert(engine);
        true
    }
    fn take(&mut self, hour: u16) -> Option<(Vec<usize>, bool)> {
        let tones = std::mem::take(&mut self.pending)
            .into_iter()
            .collect::<Vec<_>>();
        if self.stopped || !self.enabled || quiet(hour) || tones.is_empty() {
            None
        } else {
            Some((tones, self.chinese))
        }
    }
}
struct State {
    policy: Policy,
    generation: u64,
    child: Option<tokio::process::Child>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}
impl State {
    // Caller holds the same lock as configure/stop. Checking eligibility,
    // spawning, and publishing cancellation ownership are one critical section.
    fn start_batch(
        &mut self,
        generation: u64,
        hour: u16,
        spawn: impl FnOnce() -> Result<tokio::process::Child, ()>,
    ) -> Result<bool, ()> {
        if self.generation != generation
            || self.policy.stopped
            || !self.policy.enabled
            || quiet(hour)
        {
            return Ok(false);
        }
        self.child = Some(spawn()?);
        Ok(true)
    }
    fn cancel(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.policy.pending.clear();
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            // kill_on_drop remains the fallback; Tokio reaps dropped children.
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
pub(super) struct AudioService {
    state: Arc<Mutex<State>>,
}
impl AudioService {
    pub(super) fn new(started_at_ms: u64) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                policy: Policy::new(started_at_ms),
                generation: 0,
                child: None,
                task: None,
            })),
        }
    }
    pub(super) fn available() -> bool {
        cfg!(windows)
    }
    pub(super) fn configure(&self, enabled: bool, locale: &str) {
        let mut state = self.state.lock();
        state.policy.enabled = enabled;
        state.policy.chinese = matches!(locale, "zh" | "zh-CN" | "zh-TW" | "zh-HK");
        if !enabled {
            state.cancel();
        }
    }
    pub(super) fn enqueue(&self, engine: &str, completed_at_ms: u64) {
        let mut state = self.state.lock();
        if !state.policy.accept(
            engine_index(engine),
            completed_at_ms,
            now_ms(),
            local_hour(),
            Self::available(),
        ) {
            return;
        }
        if state.task.is_some() {
            return;
        }
        let shared = Arc::clone(&self.state);
        let generation = state.generation;
        state.task = Some(tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(MERGE_DELAY).await;
                let batch = {
                    let mut state = shared.lock();
                    if state.generation != generation {
                        return;
                    }
                    state.policy.take(local_hour())
                };
                if let Some((tones, chinese)) = batch {
                    let started = shared
                        .lock()
                        .start_batch(generation, local_hour(), || spawn_audio(&tones, chinese));
                    let result = match started {
                        Ok(true) => wait_playback(&shared, generation).await,
                        Ok(false) => return,
                        Err(()) => Err(()),
                    };
                    if result.is_err() {
                        eprintln!("[assistant-notices] local completion audio unavailable");
                    }
                }
                let mut state = shared.lock();
                if state.generation != generation {
                    return;
                }
                if state.policy.pending.is_empty() {
                    state.task = None;
                    break;
                }
            }
        }));
    }
    pub(super) fn stop(&self) {
        let mut state = self.state.lock();
        state.policy.stopped = true;
        state.cancel();
    }
}
impl Drop for AudioService {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(windows)]
fn spawn_audio(tones: &[usize], chinese: bool) -> Result<tokio::process::Child, ()> {
    use std::process::Stdio;
    // Only enum-derived integers and a boolean leave Rust. The script never
    // interpolates engine names, locale strings, or task-owned text.
    let tones = tones
        .iter()
        .filter(|index| **index <= 12)
        .map(usize::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("CCGUI_NOTICE_TONES", tones)
        .env("CCGUI_NOTICE_ZH", if chinese { "1" } else { "0" })
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .kill_on_drop(true);
    command.spawn().map_err(|_| ())
}
#[cfg(not(windows))]
fn spawn_audio(_: &[usize], _: bool) -> Result<tokio::process::Child, ()> {
    Err(())
}

async fn wait_playback(shared: &Mutex<State>, generation: u64) -> Result<(), ()> {
    let started = std::time::Instant::now();
    loop {
        {
            let mut state = shared.lock();
            if state.generation != generation {
                return Ok(());
            }
            let Some(child) = state.child.as_mut() else {
                return Ok(());
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    state.child = None;
                    return if status.success() { Ok(()) } else { Err(()) };
                }
                Ok(None) if started.elapsed() < Duration::from_secs(10) => {}
                _ => {
                    let _ = child.start_kill();
                    state.child = None;
                    return Err(());
                }
            }
        }
        // No state lock is held across this wait; close can kill immediately.
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(windows)]
const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Volume = 25
$synth.Rate = -1
$phrase = 'A task is ready.'
if ($env:CCGUI_NOTICE_ZH -eq '1') {
  $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name.StartsWith('zh') } | Select-Object -First 1
  # Without an installed Chinese voice, use the fixed English phrase above.
  if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name); $phrase = [string][char]0x6709 + [char]0x4EFB + [char]0x52A1 + [char]0x5B8C + [char]0x6210 + [char]0x4E86 + [char]0x3002 }
}
$frequencies = @(523,659,784,587,698,880,622,740,831,932,988,1047,554)
try {
  foreach ($raw in $env:CCGUI_NOTICE_TONES.Split(',')) {
    $index = 0
    if (-not [int]::TryParse($raw, [ref]$index) -or $index -lt 0 -or $index -gt 12) { throw 'invalid tone' }
    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)
    $rate = 16000; $samples = 2400; $bytes = $samples * 2
    $writer.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $writer.Write([int](36+$bytes))
    $writer.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt ')); $writer.Write([int]16)
    $writer.Write([int16]1); $writer.Write([int16]1); $writer.Write([int]$rate)
    $writer.Write([int]($rate*2)); $writer.Write([int16]2); $writer.Write([int16]16)
    $writer.Write([Text.Encoding]::ASCII.GetBytes('data')); $writer.Write([int]$bytes)
    for ($i=0; $i -lt $samples; $i++) {
      $envelope = [Math]::Sin([Math]::PI*$i/$samples)
      $wave = [Math]::Sin(2*[Math]::PI*$frequencies[$index]*$i/$rate)
      $writer.Write([int16](8191*$envelope*$wave))
    }
    $writer.Flush(); $stream.Position = 0
    $player = New-Object System.Media.SoundPlayer($stream)
    try { $player.PlaySync() } finally { $player.Dispose(); $writer.Dispose(); $stream.Dispose() }
  }
  $synth.Speak($phrase)
} finally { $synth.SpeakAsyncCancelAll(); $synth.Dispose() }
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closing_between_batch_selection_and_spawn_rejects_stale_helper() {
        for stop in [false, true] {
            let service = AudioService::new(100);
            let generation = {
                let mut state = service.state.lock();
                assert!(state.policy.accept(0, 101, 1000, 12, true));
                assert!(state.policy.take(12).is_some());
                state.generation
            };
            // Simulate preemption precisely after take and before process spawn.
            if stop {
                service.stop();
            } else {
                service.configure(false, "en");
            }
            service.configure(true, "en");
            let mut spawned = false;
            let result = service.state.lock().start_batch(generation, 12, || {
                spawned = true;
                Err(())
            });
            assert_eq!(result, Ok(false));
            assert!(
                !spawned,
                "a cancelled batch must never start a helper, even after re-enable"
            );
        }
    }
    #[test]
    fn spawn_gate_holds_the_cancel_lock_and_rechecks_quiet_hours() {
        let service = AudioService::new(100);
        let mut state = service.state.lock();
        let generation = state.generation;
        assert_eq!(
            state.start_batch(generation, 22, || panic!("quiet hour spawn")),
            Ok(false)
        );
        let mut called = false;
        assert_eq!(
            state.start_batch(generation, 12, || {
                called = true;
                assert!(service.state.try_lock().is_none());
                // A simulated launch failure is sufficient to exercise the sync
                // launch boundary without starting a process or making sound.
                Err(())
            }),
            Err(())
        );
        assert!(called);
    }
    #[tokio::test]
    async fn disabling_aborts_the_worker_and_clears_pending_audio() {
        struct Signal(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Signal {
            fn drop(&mut self) {
                if let Some(sender) = self.0.take() {
                    let _ = sender.send(());
                }
            }
        }
        let service = AudioService::new(100);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let guard = Signal(Some(sender));
        {
            let mut state = service.state.lock();
            assert!(state.policy.accept(0, 101, 1000, 12, true));
            // A fake playback future exercises cancellation without spawning
            // PowerShell or emitting any sound in an ordinary unit test.
            state.task = Some(tauri::async_runtime::spawn(async move {
                let _guard = guard;
                std::future::pending::<()>().await;
            }));
        }
        service.configure(false, "en");
        tokio::time::timeout(Duration::from_secs(1), receiver)
            .await
            .unwrap()
            .unwrap();
        assert!(service.state.lock().task.is_none());
        assert!(service.state.lock().policy.pending.is_empty());
        service.configure(true, "en");
        assert!(!service
            .state
            .lock()
            .policy
            .accept(0, 101, 100_000, 12, true));
        service.stop();
        service.configure(true, "en");
        assert!(!service
            .state
            .lock()
            .policy
            .accept(1, 102, 100_001, 12, true));
    }
    #[test]
    fn policy_merges_deduplicates_and_cools_each_engine_independently() {
        let mut policy = Policy::new(100);
        assert!(!policy.accept(0, 100, 1000, 12, true));
        assert!(policy.accept(0, 101, 1000, 12, true));
        assert!(!policy.accept(0, 101, 91_000, 12, true));
        assert!(!policy.accept(0, 102, 90_999, 12, true));
        assert!(policy.accept(1, 103, 1500, 12, true));
        assert_eq!(policy.take(12).unwrap().0, vec![0, 1]);
        assert!(policy.accept(0, 104, 91_000, 12, true));
    }
    #[test]
    fn suppressed_and_cancelled_events_are_never_replayed() {
        let mut policy = Policy::new(100);
        policy.enabled = false;
        assert!(!policy.accept(0, 101, 1000, 12, true));
        policy.enabled = true;
        assert!(!policy.accept(0, 101, 1001, 12, true));
        assert!(!policy.accept(1, 102, 1001, 22, true));
        assert!(!policy.accept(1, 102, 1002, 8, true));
        assert!(!policy.accept(2, 103, 1002, 12, false));
        assert!(policy.accept(3, 104, 1003, 21, true));
        assert!(policy.take(22).is_none());
        assert!(policy.pending.is_empty());
        policy.stopped = true;
        assert!(!policy.accept(4, 105, 1004, 12, true));
        assert!(!quiet(8));
        assert!(!quiet(21));
        assert!(quiet(22));
        assert!(quiet(7));
    }
    #[test]
    fn every_engine_and_unknown_input_map_to_fixed_bounded_tones() {
        for (index, engine) in ENGINES.iter().enumerate() {
            assert_eq!(engine_index(engine), index);
        }
        assert_eq!(engine_index("'; Invoke-Expression evil"), 12);
        fn send_sync<T: Send + Sync>() {}
        send_sync::<AudioService>();
        let service = AudioService::new(0);
        service.configure(false, "arbitrary shell text");
        assert!(!service.state.lock().policy.chinese);
        service.stop();
        assert!(service.state.lock().policy.stopped);
    }
}
