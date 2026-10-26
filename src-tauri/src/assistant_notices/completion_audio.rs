//! Optional local completion audio. No task content or model calls enter this module.
use parking_lot::Mutex;
use serde::Serialize;
use std::{collections::BTreeSet, path::PathBuf, sync::Arc, time::Duration};
pub(super) mod settings;
mod tones;
pub(super) use settings::AudioSettings;

const MERGE_DELAY: Duration = Duration::from_secs(3);
const COOLDOWN_MS: u64 = 90_000;
const ENGINES: [&str; 12] = [
    "claude", "codex", "grok", "kimi", "pi", "omp", "dsh", "agy", "cursor", "opencode", "qoder",
    "qoder-cn",
];

fn engine_index(engine: &str) -> usize {
    ENGINES.iter().position(|id| *id == engine).unwrap_or(12)
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

/// One helper run: engines in batch order plus the settings snapshot taken
/// with them, so a save during the merge delay applies to the next batch only.
#[derive(Debug, Clone, PartialEq)]
struct Plan {
    tones: Vec<usize>,
    chinese: bool,
    settings: AudioSettings,
}
impl Plan {
    /// Length-prefixed WAV chimes in batch order; a zero length means "no
    /// chime" so the helper can still pair each engine with its announcement.
    fn chime_peak(&self) -> f32 {
        f32::from(self.settings.chime_volume) / 100.0 * 0.9
    }
    fn payload(&self) -> Vec<u8> {
        let peak = self.chime_peak();
        let mut payload = Vec::new();
        for index in &self.tones {
            if self.settings.chimes() {
                let wav = tones::render_wav(self.settings.engine(*index).chime.into(), peak);
                payload.extend_from_slice(&(wav.len() as u32).to_le_bytes());
                payload.extend_from_slice(&wav);
            } else {
                payload.extend_from_slice(&0u32.to_le_bytes());
            }
        }
        payload
    }
    /// Only integers, booleans and validated voice names leave Rust. Spoken
    /// engine names come from the script's fixed table; voice names are
    /// compared as data and never evaluated.
    fn environment(&self) -> Vec<(&'static str, String)> {
        let join = |values: Vec<String>, separator: &str| values.join(separator);
        let per_tone = |f: &dyn Fn(usize) -> String| self.tones.iter().map(|i| f(*i)).collect();
        let voice_peak = if self.settings.speaks() {
            u32::from(self.settings.voice_volume) * 29_490 / 100
        } else {
            0
        };
        vec![
            (
                "CCGUI_NOTICE_TONES",
                join(per_tone(&|i| i.min(12).to_string()), ","),
            ),
            (
                "CCGUI_NOTICE_ZH",
                if self.chinese { "1" } else { "0" }.into(),
            ),
            ("CCGUI_NOTICE_VOICE_PEAK", voice_peak.to_string()),
            (
                "CCGUI_NOTICE_VOICES",
                join(per_tone(&|i| self.settings.engine(i).voice), "|"),
            ),
            (
                "CCGUI_NOTICE_DEFAULT_VOICES",
                join(
                    per_tone(&|i| {
                        let (zh, en, _, _) = settings::VOICE_DEFAULTS[i.min(12)];
                        (if self.chinese { zh } else { en }).to_string()
                    }),
                    "|",
                ),
            ),
            (
                "CCGUI_NOTICE_PITCHES",
                join(
                    per_tone(&|i| self.settings.engine(i).pitch.to_string()),
                    ",",
                ),
            ),
            (
                "CCGUI_NOTICE_RATES",
                join(
                    per_tone(&|i| settings::VOICE_DEFAULTS[i.min(12)].3.to_string()),
                    ",",
                ),
            ),
        ]
    }
}

struct Policy {
    started_at_ms: u64,
    enabled: bool,
    stopped: bool,
    chinese: bool,
    settings: AudioSettings,
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
            settings: AudioSettings::default(),
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
            || self.settings.quiet(hour)
            || self.admitted[engine].is_some_and(|last| now.saturating_sub(last) < COOLDOWN_MS)
        {
            return false;
        }
        self.admitted[engine] = Some(now);
        self.pending.insert(engine);
        true
    }
    fn take(&mut self, hour: u16) -> Option<Plan> {
        let tones = std::mem::take(&mut self.pending)
            .into_iter()
            .collect::<Vec<_>>();
        if self.stopped || !self.enabled || self.settings.quiet(hour) || tones.is_empty() {
            None
        } else {
            Some(Plan {
                tones,
                chinese: self.chinese,
                settings: self.settings.clone(),
            })
        }
    }
}

/// A cancellable helper run. Completion batches and settings previews own
/// separate slots so a preview never discards a pending completion.
#[derive(Default)]
struct Slot {
    generation: u64,
    child: Option<tokio::process::Child>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}
impl Slot {
    fn cancel(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            // kill_on_drop remains the fallback; Tokio reaps dropped children.
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
#[derive(Clone, Copy)]
enum Kind {
    Batch,
    Preview,
}
struct State {
    policy: Policy,
    batch: Slot,
    preview: Slot,
    path: Option<PathBuf>,
    revision: u64,
}
impl State {
    fn slot(&mut self, kind: Kind) -> &mut Slot {
        match kind {
            Kind::Batch => &mut self.batch,
            Kind::Preview => &mut self.preview,
        }
    }
    // Caller holds the same lock as configure/stop. Checking eligibility,
    // spawning, and publishing cancellation ownership are one critical section.
    fn start_batch(
        &mut self,
        generation: u64,
        hour: u16,
        spawn: impl FnOnce() -> Result<tokio::process::Child, ()>,
    ) -> Result<bool, ()> {
        if self.batch.generation != generation
            || self.policy.stopped
            || !self.policy.enabled
            || self.policy.settings.quiet(hour)
        {
            return Ok(false);
        }
        self.batch.child = Some(spawn()?);
        Ok(true)
    }
    fn cancel(&mut self) {
        self.policy.pending.clear();
        self.batch.cancel();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoVoice {
    pub zh: &'static str,
    pub en: &'static str,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioView {
    pub settings: AudioSettings,
    pub revision: u64,
    pub defaults: AudioSettings,
    pub auto_voices: std::collections::BTreeMap<&'static str, AutoVoice>,
    pub chime_count: u8,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub name: String,
    pub language: String,
    pub gender: String,
}

pub(super) struct AudioService {
    state: Arc<Mutex<State>>,
}
impl AudioService {
    pub(super) fn new(started_at_ms: u64) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                policy: Policy::new(started_at_ms),
                batch: Slot::default(),
                preview: Slot::default(),
                path: None,
                revision: 0,
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
    /// Bind persistence. Unreadable files fall back to defaults at revision 0.
    pub(super) fn load(&self, path: PathBuf) {
        let (settings, revision) = settings::load(&path);
        let mut state = self.state.lock();
        state.policy.settings = settings;
        state.revision = revision;
        state.path = Some(path);
    }
    pub(super) fn view(&self) -> AudioView {
        let state = self.state.lock();
        AudioView {
            settings: state.policy.settings.clone(),
            revision: state.revision,
            defaults: AudioSettings::default(),
            auto_voices: ENGINES
                .iter()
                .zip(settings::VOICE_DEFAULTS)
                .map(|(engine, (zh, en, _, _))| (*engine, AutoVoice { zh, en }))
                .collect(),
            chime_count: settings::CHIME_COUNT,
        }
    }
    /// Full replacement guarded by revision, like the notice configuration.
    pub(super) fn save(
        &self,
        next: AudioSettings,
        expected_revision: u64,
    ) -> Result<AudioView, String> {
        next.validate()?;
        {
            let mut state = self.state.lock();
            if state.revision != expected_revision {
                return Err("config_conflict".into());
            }
            let path = state.path.clone().ok_or("storage_unavailable")?;
            let revision = state.revision + 1;
            settings::save(&path, &next, revision)?;
            state.revision = revision;
            state.policy.settings = next;
        }
        Ok(self.view())
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
        if state.batch.task.is_some() {
            return;
        }
        let shared = Arc::clone(&self.state);
        let generation = state.batch.generation;
        state.batch.task = Some(tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(MERGE_DELAY).await;
                let batch = {
                    let mut state = shared.lock();
                    if state.batch.generation != generation {
                        return;
                    }
                    state.policy.take(local_hour())
                };
                if let Some(plan) = batch {
                    let started = shared
                        .lock()
                        .start_batch(generation, local_hour(), || spawn_audio(&plan));
                    let result = match started {
                        Ok(true) => play(&shared, Kind::Batch, generation, &plan).await,
                        Ok(false) => return,
                        Err(()) => Err(()),
                    };
                    if result.is_err() {
                        eprintln!("[assistant-notices] local completion audio unavailable");
                    }
                }
                let mut state = shared.lock();
                if state.batch.generation != generation {
                    return;
                }
                if state.policy.pending.is_empty() {
                    state.batch.task = None;
                    break;
                }
            }
        }));
    }
    /// Play one engine with unsaved settings. An explicit preview ignores the
    /// opt-in, quiet hours and cooldown, and replaces any earlier preview.
    pub(super) fn preview(&self, engine: &str, settings: AudioSettings) -> Result<(), String> {
        settings.validate()?;
        if !ENGINES.contains(&engine) {
            return Err("invalid_engine".into());
        }
        if !Self::available() {
            return Err("voice_unavailable".into());
        }
        let mut state = self.state.lock();
        if state.policy.stopped {
            return Err("voice_unavailable".into());
        }
        state.preview.cancel();
        let plan = Plan {
            tones: vec![engine_index(engine)],
            chinese: state.policy.chinese,
            settings,
        };
        state.preview.child = Some(spawn_audio(&plan).map_err(|_| "voice_unavailable")?);
        let shared = Arc::clone(&self.state);
        let generation = state.preview.generation;
        state.preview.task = Some(tauri::async_runtime::spawn(async move {
            if play(&shared, Kind::Preview, generation, &plan)
                .await
                .is_err()
            {
                eprintln!("[assistant-notices] completion audio preview unavailable");
            }
            let mut state = shared.lock();
            if state.preview.generation == generation {
                state.preview.task = None;
            }
        }));
        Ok(())
    }
    pub(super) fn stop(&self) {
        let mut state = self.state.lock();
        state.policy.stopped = true;
        state.cancel();
        state.preview.cancel();
    }
}
impl Drop for AudioService {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn play(shared: &Mutex<State>, kind: Kind, generation: u64, plan: &Plan) -> Result<(), ()> {
    let limit = playback_limit(plan.tones.len());
    send_chimes(shared, kind, generation, &plan.payload(), limit).await?;
    wait_playback(shared, kind, generation, limit).await
}

#[cfg(windows)]
fn spawn_audio(plan: &Plan) -> Result<tokio::process::Child, ()> {
    use std::process::Stdio;
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .envs(plan.environment())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .kill_on_drop(true);
    command.spawn().map_err(|_| ())
}
#[cfg(not(windows))]
fn spawn_audio(_: &Plan) -> Result<tokio::process::Child, ()> {
    Err(())
}

fn playback_limit(count: usize) -> Duration {
    // Helper startup plus roughly one chime and one short phrase per engine.
    Duration::from_secs(6 + 4 * count as u64)
}
async fn send_chimes(
    shared: &Mutex<State>,
    kind: Kind,
    generation: u64,
    payload: &[u8],
    limit: Duration,
) -> Result<(), ()> {
    use tokio::io::AsyncWriteExt;
    let stdin = {
        let mut state = shared.lock();
        let slot = state.slot(kind);
        if slot.generation != generation {
            return Ok(());
        }
        slot.child.as_mut().and_then(|child| child.stdin.take())
    };
    let Some(mut stdin) = stdin else {
        return Err(());
    };
    // Closing stdin after the write tells the helper no more chimes follow.
    match tokio::time::timeout(limit, stdin.write_all(payload)).await {
        Ok(Ok(())) => Ok(()),
        // A cancelled helper breaks the pipe; that is not a playback failure.
        _ if shared.lock().slot(kind).generation != generation => Ok(()),
        _ => Err(()),
    }
}

async fn wait_playback(
    shared: &Mutex<State>,
    kind: Kind,
    generation: u64,
    limit: Duration,
) -> Result<(), ()> {
    let started = std::time::Instant::now();
    loop {
        {
            let mut state = shared.lock();
            let slot = state.slot(kind);
            if slot.generation != generation {
                return Ok(());
            }
            let Some(child) = slot.child.as_mut() else {
                return Ok(());
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    slot.child = None;
                    return if status.success() { Ok(()) } else { Err(()) };
                }
                Ok(None) if started.elapsed() < limit => {}
                _ => {
                    let _ = child.start_kill();
                    slot.child = None;
                    return Err(());
                }
            }
        }
        // No state lock is held across this wait; close can kill immediately.
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Installed voices for the settings picker: OneCore voices when WinRT is
/// reachable (the same set playback uses), otherwise desktop SAPI voices.
#[cfg(windows)]
pub(super) async fn voices() -> Result<Vec<VoiceInfo>, String> {
    use std::process::Stdio;
    let mut command = tokio::process::Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", VOICES_SCRIPT])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| "voice_unavailable")?
        .map_err(|_| "voice_unavailable")?;
    if !output.status.success() {
        return Err("voice_unavailable".into());
    }
    Ok(parse_voices(&String::from_utf8_lossy(&output.stdout)))
}
#[cfg(not(windows))]
pub(super) async fn voices() -> Result<Vec<VoiceInfo>, String> {
    Err("voice_unavailable".into())
}
fn parse_voices(output: &str) -> Vec<VoiceInfo> {
    let mut voices = Vec::<VoiceInfo>::new();
    for line in output.lines() {
        let mut fields = line.trim_end_matches('\r').split('\t');
        let (Some(name), Some(language), Some(gender), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let language_ok = !language.is_empty()
            && language.len() <= 16
            && language
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-');
        let gender = match gender {
            "Male" => "male",
            "Female" => "female",
            _ => "unknown",
        };
        if !name.is_empty()
            && settings::valid_voice_name(name)
            && language_ok
            && !voices.iter().any(|voice| voice.name == name)
        {
            voices.push(VoiceInfo {
                name: name.into(),
                language: language.into(),
                gender: gender.into(),
            });
        }
        if voices.len() == 64 {
            break;
        }
    }
    voices
}

#[cfg(windows)]
const VOICES_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
  foreach ($voice in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {
    [Console]::Out.WriteLine($voice.DisplayName + "`t" + $voice.Language + "`t" + $voice.Gender)
  }
} catch {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    foreach ($voice in $synth.GetInstalledVoices() | Where-Object { $_.Enabled }) {
      [Console]::Out.WriteLine($voice.VoiceInfo.Name + "`t" + $voice.VoiceInfo.Culture.Name + "`t" + $voice.VoiceInfo.Gender)
    }
  } finally { $synth.Dispose() }
}
"#;

// Spoken engine names are a fixed table indexed like ENGINES; index 12 is the
// unknown-engine fallback. Per-engine voice, pitch and rate arrive as parallel
// lists. OneCore voices are reached through WinRT and fall back to
// System.Speech desktop voices.
#[cfg(windows)]
const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$names = @('Claude','Codex','Grok','Kimi','Pi','O M P','DeepSeek','Antigravity','Cursor','OpenCode','Qoder','Qoder','')
$zh = $env:CCGUI_NOTICE_ZH -eq '1'
$voicePeak = [int]"$env:CCGUI_NOTICE_VOICE_PEAK"
$tones = "$env:CCGUI_NOTICE_TONES".Split(',')
$explicit = "$env:CCGUI_NOTICE_VOICES".Split('|')
$defaults = "$env:CCGUI_NOTICE_DEFAULT_VOICES".Split('|')
$pitches = "$env:CCGUI_NOTICE_PITCHES".Split(',')
$rates = "$env:CCGUI_NOTICE_RATES".Split(',')
foreach ($list in @($explicit, $defaults, $pitches, $rates)) { if ($list.Count -ne $tones.Count) { throw 'invalid plan' } }
$done = [string][char]0x4EFB + [char]0x52A1 + [char]0x5B8C + [char]0x6210 + [char]0x4E86
$winrt = $null
if ($voicePeak -gt 0) {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
    $asTask = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    $winrt = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
    $winrtVoices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
  } catch { $winrt = $null }
}
$desktop = $null
function Play-Wave([byte[]]$bytes) {
  $stream = New-Object System.IO.MemoryStream(,$bytes)
  $player = New-Object System.Media.SoundPlayer($stream)
  try { $player.PlaySync() } finally { $player.Dispose(); $stream.Dispose() }
}
# OneCore voices peak between ~35% and full scale even at maximum volume, so a
# fixed gain either stays quiet or clips; normalise each phrase to the
# requested peak instead.
function Level-Speech([byte[]]$bytes) {
  if ($bytes.Length -lt 12 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'RIFF') { return }
  $offset = 12
  while ($offset + 8 -le $bytes.Length) {
    $size = [BitConverter]::ToInt32($bytes, $offset + 4)
    if ([Text.Encoding]::ASCII.GetString($bytes, $offset, 4) -eq 'data') {
      $end = [Math]::Min($bytes.Length, $offset + 8 + $size) - 1
      $peak = 1
      for ($i = $offset + 8; $i -lt $end; $i += 2) { $peak = [Math]::Max($peak, [Math]::Abs([int][BitConverter]::ToInt16($bytes, $i))) }
      $gain = [Math]::Min(4.0, $voicePeak / $peak)
      for ($i = $offset + 8; $i -lt $end; $i += 2) {
        $v = [int]([BitConverter]::ToInt16($bytes, $i) * $gain)
        if ($v -gt 32767) { $v = 32767 } elseif ($v -lt -32768) { $v = -32768 }
        $bytes[$i] = $v -band 0xFF; $bytes[$i + 1] = ($v -shr 8) -band 0xFF
      }
      return
    }
    $offset += 8 + $size + ($size % 2)
  }
}
function Phrase([int]$index, [bool]$chinese) {
  $name = $names[$index]
  if ($chinese) { if ($name) { return $name + ' ' + $done } else { return [string][char]0x6709 + $done } }
  if ($name) { return $name + ' is done.' } else { return 'A task is ready.' }
}
function Speak-Engine([int]$slot, [int]$index) {
  $want = $explicit[$slot]
  $fallback = $defaults[$slot]
  $chinese = $zh
  if ($winrt) {
    # A chosen voice decides the phrase language; Auto follows the UI language.
    $voice = $null
    if ($want) { $voice = $winrtVoices | Where-Object { $_.DisplayName -eq $want } | Select-Object -First 1 }
    if ($voice) { $chinese = $voice.Language.StartsWith('zh') } else {
      $pool = @($winrtVoices | Where-Object { $_.Language.StartsWith($(if ($chinese) { 'zh-CN' } else { 'en' })) })
      if ($chinese -and $pool.Count -eq 0) { $pool = @($winrtVoices | Where-Object { $_.Language.StartsWith('zh') }) }
      # Without an installed Chinese voice, use the fixed English phrase.
      if ($chinese -and $pool.Count -eq 0) { $chinese = $false; $pool = @($winrtVoices | Where-Object { $_.Language.StartsWith('en') }) }
      $voice = $pool | Where-Object { $_.DisplayName -like "*$fallback*" } | Select-Object -First 1
      if (-not $voice) { $voice = $pool | Select-Object -First 1 }
    }
    if ($voice) { $winrt.Voice = $voice }
    $winrt.Options.AudioVolume = 1.0
    try { $winrt.Options.AudioPitch = [int]$pitches[$slot] / 100.0; $winrt.Options.SpeakingRate = [int]$rates[$slot] / 100.0 } catch {}
    $task = $asTask.Invoke($null, @($winrt.SynthesizeTextToStreamAsync((Phrase $index $chinese))))
    $task.Wait()
    $source = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($task.Result)
    $buffer = New-Object System.IO.MemoryStream
    try { $source.CopyTo($buffer); $speech = $buffer.ToArray(); Level-Speech $speech; Play-Wave $speech } finally { $source.Dispose(); $buffer.Dispose(); $task.Result.Dispose() }
    return
  }
  if (-not $script:desktop) {
    Add-Type -AssemblyName System.Speech
    $script:desktop = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $script:desktop.Rate = -1
  }
  $script:desktop.Volume = [Math]::Min(100, [int]($voicePeak * 100 / 29490))
  $installed = @($script:desktop.GetInstalledVoices() | Where-Object { $_.Enabled })
  $voice = $null
  if ($want) { $voice = $installed | Where-Object { $_.VoiceInfo.Name -eq $want } | Select-Object -First 1 }
  if ($voice) { $chinese = $voice.VoiceInfo.Culture.Name.StartsWith('zh') } else {
    $pool = @($installed | Where-Object { $_.VoiceInfo.Culture.Name.StartsWith($(if ($chinese) { 'zh' } else { 'en' })) })
    if ($chinese -and $pool.Count -eq 0) { $chinese = $false; $pool = @($installed | Where-Object { $_.VoiceInfo.Culture.Name.StartsWith('en') }) }
    $voice = $pool | Where-Object { $_.VoiceInfo.Name -like "*$fallback*" } | Select-Object -First 1
    if (-not $voice) { $voice = $pool | Select-Object -First 1 }
  }
  if ($voice) { $script:desktop.SelectVoice($voice.VoiceInfo.Name) }
  $script:desktop.Speak((Phrase $index $chinese))
}
$reader = New-Object System.IO.BinaryReader([Console]::OpenStandardInput())
try {
  for ($slot = 0; $slot -lt $tones.Count; $slot++) {
    $index = 0
    if (-not [int]::TryParse($tones[$slot], [ref]$index) -or $index -lt 0 -or $index -gt 12) { throw 'invalid tone' }
    $length = $reader.ReadInt32()
    if ($length -ne 0 -and ($length -le 44 -or $length -gt 1048576)) { throw 'invalid chime' }
    if ($length -gt 0) {
      $bytes = $reader.ReadBytes($length)
      if ($bytes.Length -ne $length) { throw 'truncated chime' }
      Play-Wave $bytes
    }
    if ($voicePeak -gt 0) { Speak-Engine $slot $index }
  }
} finally {
  $reader.Dispose()
  if ($winrt) { $winrt.Dispose() }
  if ($script:desktop) { $script:desktop.SpeakAsyncCancelAll(); $script:desktop.Dispose() }
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    fn plan(tones: Vec<usize>, settings: AudioSettings) -> Plan {
        Plan {
            tones,
            chinese: true,
            settings,
        }
    }
    #[test]
    fn closing_between_batch_selection_and_spawn_rejects_stale_helper() {
        for stop in [false, true] {
            let service = AudioService::new(100);
            let generation = {
                let mut state = service.state.lock();
                assert!(state.policy.accept(0, 101, 1000, 12, true));
                assert!(state.policy.take(12).is_some());
                state.batch.generation
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
        let generation = state.batch.generation;
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
        // Quiet hours follow saved settings, including turning them off.
        state.policy.settings.quiet_hours = false;
        assert_eq!(state.start_batch(generation, 22, || Err(())), Err(()));
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
            state.batch.task = Some(tauri::async_runtime::spawn(async move {
                let _guard = guard;
                std::future::pending::<()>().await;
            }));
        }
        service.configure(false, "en");
        tokio::time::timeout(Duration::from_secs(1), receiver)
            .await
            .unwrap()
            .unwrap();
        assert!(service.state.lock().batch.task.is_none());
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
    #[tokio::test]
    async fn previews_cancel_only_themselves_and_stop_with_the_service() {
        let service = AudioService::new(100);
        let fake = || {
            tauri::async_runtime::spawn(async move {
                std::future::pending::<()>().await;
            })
        };
        {
            let mut state = service.state.lock();
            assert!(state.policy.accept(0, 101, 1000, 12, true));
            state.batch.task = Some(fake());
            state.preview.task = Some(fake());
            let batch = state.batch.generation;
            state.preview.cancel();
            assert!(state.preview.task.is_none());
            // A replaced preview leaves pending completions and their worker alone.
            assert_eq!(state.batch.generation, batch);
            assert!(state.batch.task.is_some());
            assert_eq!(state.policy.pending.len(), 1);
            state.preview.task = Some(fake());
        }
        assert_eq!(
            service.preview(
                "claude",
                AudioSettings {
                    chime_volume: 7,
                    ..AudioSettings::default()
                }
            ),
            Err("invalid_audio_settings".into())
        );
        assert_eq!(
            service.preview("'; evil", AudioSettings::default()),
            Err("invalid_engine".into())
        );
        service.stop();
        assert!(service.state.lock().preview.task.is_none());
        assert!(service.state.lock().batch.task.is_none());
        assert!(service.preview("claude", AudioSettings::default()).is_err());
    }
    #[test]
    fn policy_merges_deduplicates_and_cools_each_engine_independently() {
        let mut policy = Policy::new(100);
        assert!(!policy.accept(0, 100, 1000, 12, true));
        assert!(policy.accept(0, 101, 1000, 12, true));
        assert!(!policy.accept(0, 101, 91_000, 12, true));
        assert!(!policy.accept(0, 102, 90_999, 12, true));
        assert!(policy.accept(1, 103, 1500, 12, true));
        assert_eq!(policy.take(12).unwrap().tones, vec![0, 1]);
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
    }
    #[test]
    fn saved_quiet_hours_gate_admission_and_batches_snapshot_settings() {
        let mut policy = Policy::new(100);
        policy.settings.quiet_start = 12;
        policy.settings.quiet_end = 13;
        assert!(!policy.accept(0, 101, 1000, 12, true));
        assert!(policy.accept(1, 102, 1000, 23, true));
        policy.settings.mode = settings::PlaybackMode::VoiceOnly;
        let taken = policy.take(23).unwrap();
        assert_eq!(taken.settings.mode, settings::PlaybackMode::VoiceOnly);
        policy.settings.quiet_hours = false;
        assert!(policy.accept(2, 103, 1000, 12, true));
    }
    #[test]
    fn settings_persist_with_revision_conflicts_and_survive_reload() {
        let dir = std::env::temp_dir().join(format!("completion-audio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("completion-audio.json");
        let service = AudioService::new(0);
        assert_eq!(
            service.save(AudioSettings::default(), 0),
            Err("storage_unavailable".into())
        );
        service.load(path.clone());
        let view = service.view();
        assert_eq!((view.revision, view.chime_count), (0, 13));
        assert_eq!(view.settings, view.defaults);
        assert_eq!(
            view.auto_voices["codex"],
            AutoVoice {
                zh: "Kangkang",
                en: "David"
            }
        );
        let mut next = AudioSettings::default();
        next.voice_volume = 100;
        next.engines.get_mut("cursor").unwrap().voice = "Microsoft Mark".into();
        assert_eq!(service.save(next.clone(), 1), Err("config_conflict".into()));
        let saved = service.save(next.clone(), 0).unwrap();
        assert_eq!((saved.revision, &saved.settings), (1, &next));
        assert_eq!(service.save(next.clone(), 0), Err("config_conflict".into()));
        let mut invalid = next.clone();
        invalid.quiet_end = invalid.quiet_start;
        assert_eq!(
            service.save(invalid, 1),
            Err("invalid_audio_settings".into())
        );
        let reloaded = AudioService::new(0);
        reloaded.load(path);
        assert_eq!(reloaded.view().settings, next);
        assert_eq!(reloaded.view().revision, 1);
        assert_eq!(reloaded.state.lock().policy.settings.voice_volume, 100);
        std::fs::remove_dir_all(dir).unwrap();
    }
    /// Real-speaker acceptance: `cargo test completion_audio_audition -- --ignored`
    /// plays every engine's chime and announcement through the shipped helper.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "plays audible sound"]
    async fn completion_audio_audition() {
        let chinese = std::env::var("CCGUI_AUDITION_LOCALE").map_or(true, |v| v != "en");
        for index in 0..=12 {
            let service = AudioService::new(0);
            let plan = Plan {
                tones: vec![index],
                chinese,
                settings: AudioSettings::default(),
            };
            let generation = {
                let mut state = service.state.lock();
                let generation = state.batch.generation;
                assert_eq!(
                    state.start_batch(generation, 12, || spawn_audio(&plan)),
                    Ok(true)
                );
                generation
            };
            assert_eq!(
                play(&service.state, Kind::Batch, generation, &plan).await,
                Ok(()),
                "engine {index}"
            );
        }
    }
    #[test]
    fn payload_frames_each_engine_with_its_chosen_chime_and_volume() {
        let mut settings = AudioSettings::default();
        settings.engines.get_mut("codex").unwrap().chime = 7;
        let batch = plan(vec![1, 0], settings.clone());
        let payload = batch.payload();
        let peak = batch.chime_peak();
        assert!((peak - 0.36).abs() < 1e-6);
        let first = u32::from_le_bytes(payload[..4].try_into().unwrap()) as usize;
        assert_eq!(&payload[4..8], b"RIFF");
        assert_eq!(payload[4..4 + first], tones::render_wav(7, peak)[..]);
        let second = &payload[4 + first..];
        let length = u32::from_le_bytes(second[..4].try_into().unwrap()) as usize;
        assert_eq!(second[4..], tones::render_wav(0, peak)[..]);
        assert_eq!(second.len(), 4 + length);
        assert!(playback_limit(3) > playback_limit(1));
        for silent in [
            AudioSettings {
                mode: settings::PlaybackMode::VoiceOnly,
                ..settings.clone()
            },
            AudioSettings {
                chime_volume: 0,
                ..settings
            },
        ] {
            assert_eq!(plan(vec![1, 0], silent).payload(), [0u8; 8]);
        }
    }
    #[test]
    fn environment_carries_parallel_per_engine_lists_and_mutes_speech() {
        let mut settings = AudioSettings::default();
        settings.engines.get_mut("cursor").unwrap().voice = "Microsoft Mark".into();
        settings.engines.get_mut("cursor").unwrap().pitch = 135;
        let env = |plan: Plan| {
            plan.environment()
                .into_iter()
                .collect::<std::collections::HashMap<_, _>>()
        };
        let zh = env(plan(vec![8, 1], settings.clone()));
        assert_eq!(zh["CCGUI_NOTICE_TONES"], "8,1");
        assert_eq!(zh["CCGUI_NOTICE_VOICES"], "Microsoft Mark|");
        assert_eq!(zh["CCGUI_NOTICE_DEFAULT_VOICES"], "Kangkang|Kangkang");
        assert_eq!(zh["CCGUI_NOTICE_PITCHES"], "135,100");
        assert_eq!(zh["CCGUI_NOTICE_RATES"], "110,105");
        assert_eq!(zh["CCGUI_NOTICE_VOICE_PEAK"], "23592");
        assert_eq!(zh["CCGUI_NOTICE_ZH"], "1");
        let en = env(Plan {
            chinese: false,
            ..plan(vec![8, 1], settings.clone())
        });
        assert_eq!(en["CCGUI_NOTICE_DEFAULT_VOICES"], "Mark|David");
        let muted = env(plan(
            vec![0],
            AudioSettings {
                mode: settings::PlaybackMode::ChimeOnly,
                ..settings
            },
        ));
        assert_eq!(muted["CCGUI_NOTICE_VOICE_PEAK"], "0");
    }
    #[test]
    fn voice_listing_keeps_only_safe_unique_entries() {
        let voices = parse_voices(
            "Microsoft Huihui\tzh-CN\tFemale\r\nMicrosoft Huihui\tzh-CN\tFemale\nEvil|Name\ten-US\tMale\n\
             Microsoft Mark\ten-US\tMale\nbad\tline\nMicrosoft David\ten US\tMale\n\
             Microsoft Zira\ten-US\tOther\textra\nMicrosoft Zira\ten-US\tOther\n",
        );
        assert_eq!(
            voices,
            vec![
                VoiceInfo {
                    name: "Microsoft Huihui".into(),
                    language: "zh-CN".into(),
                    gender: "female".into()
                },
                VoiceInfo {
                    name: "Microsoft Mark".into(),
                    language: "en-US".into(),
                    gender: "male".into()
                },
                VoiceInfo {
                    name: "Microsoft Zira".into(),
                    language: "en-US".into(),
                    gender: "unknown".into()
                },
            ]
        );
        let many = (0..80)
            .map(|i| format!("Voice {i}\ten-US\tMale\n"))
            .collect::<String>();
        assert_eq!(parse_voices(&many).len(), 64);
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
