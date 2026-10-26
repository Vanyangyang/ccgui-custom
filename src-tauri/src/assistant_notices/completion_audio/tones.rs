//! Fixed per-engine completion chimes rendered locally as 16-bit mono WAV.
//! Each engine owns a distinct timbre and motif so completions are
//! recognisable by ear; only the engine index selects a recipe.

pub(super) const SAMPLE_RATE: u32 = 24_000;
const ATTACK_SECONDS: f32 = 0.004;
const TAIL_SECONDS: f32 = 0.42;
const RELEASE_SECONDS: f32 = 0.015;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Timbre {
    Glass,
    Marimba,
    Pluck,
    Keys,
}

/// (frequency ratio, relative amplitude, decay per second)
fn partials(timbre: Timbre) -> &'static [(f32, f32, f32)] {
    match timbre {
        Timbre::Glass => &[
            (1.0, 1.0, 6.0),
            (2.0, 0.45, 9.0),
            (3.0, 0.2, 14.0),
            (4.16, 0.12, 20.0),
        ],
        Timbre::Marimba => &[(1.0, 1.0, 9.0), (3.93, 0.5, 18.0), (9.2, 0.12, 35.0)],
        Timbre::Pluck => &[
            (1.0, 1.0, 7.0),
            (2.0, 0.6, 11.0),
            (3.0, 0.4, 15.0),
            (4.0, 0.25, 20.0),
            (5.0, 0.15, 26.0),
        ],
        Timbre::Keys => &[
            (1.0, 1.0, 5.0),
            (2.0, 0.3, 8.0),
            (3.0, 0.35, 12.0),
            (5.0, 0.1, 18.0),
        ],
    }
}

#[derive(PartialEq, Debug)]
struct Motif {
    timbre: Timbre,
    root_hz: f32,
    semitones: &'static [i8],
    gap_ms: u32,
}

const fn motif(timbre: Timbre, root_hz: f32, semitones: &'static [i8], gap_ms: u32) -> Motif {
    Motif {
        timbre,
        root_hz,
        semitones,
        gap_ms,
    }
}

/// Indexed like `ENGINES`; the final entry is the unknown-engine fallback.
/// Claude, Codex, Antigravity and Cursor use four different timbres.
const MOTIFS: [Motif; 13] = [
    motif(Timbre::Glass, 880.0, &[0, 4, 7], 90),     // claude
    motif(Timbre::Marimba, 1175.0, &[0, 7], 120),    // codex
    motif(Timbre::Marimba, 880.0, &[7, 0], 120),     // grok
    motif(Timbre::Glass, 1047.0, &[0, 12], 110),     // kimi
    motif(Timbre::Marimba, 1047.0, &[0, 0], 110),    // pi
    motif(Timbre::Pluck, 880.0, &[0, 3, 7], 90),     // omp
    motif(Timbre::Keys, 932.0, &[0, 5], 120),        // dsh
    motif(Timbre::Keys, 1047.0, &[0, 4, 7, 12], 70), // agy
    motif(Timbre::Pluck, 988.0, &[0, 7, 12], 85),    // cursor
    motif(Timbre::Glass, 1319.0, &[0, 5], 110),      // opencode
    motif(Timbre::Keys, 988.0, &[0, 7, 4], 95),      // qoder
    motif(Timbre::Keys, 988.0, &[0, 4, 7], 95),      // qoder-cn
    motif(Timbre::Glass, 1175.0, &[0], 0),           // unknown
];

fn render_samples(index: usize, peak_level: f32) -> Vec<i16> {
    let motif = &MOTIFS[index.min(MOTIFS.len() - 1)];
    let rate = SAMPLE_RATE as f32;
    let gap = (motif.gap_ms as f32 / 1000.0 * rate) as usize;
    let tail = (TAIL_SECONDS * rate) as usize;
    let mut mix = vec![0f32; gap * (motif.semitones.len() - 1) + tail];
    let attack = ATTACK_SECONDS * rate;
    for (note, semitone) in motif.semitones.iter().enumerate() {
        let frequency = motif.root_hz * 2f32.powf(f32::from(*semitone) / 12.0);
        let start = note * gap;
        for i in 0..tail {
            let t = i as f32 / rate;
            let onset = (i as f32 / attack).min(1.0);
            let mut sample = 0.0;
            for (ratio, amplitude, decay) in partials(motif.timbre) {
                let hz = frequency * ratio;
                // Partials above Nyquist would alias into harsh tones.
                if hz < rate * 0.45 {
                    sample +=
                        amplitude * (-decay * t).exp() * (std::f32::consts::TAU * hz * t).sin();
                }
            }
            mix[start + i] += onset * sample;
        }
    }
    let release = (RELEASE_SECONDS * rate) as usize;
    let length = mix.len();
    for (i, sample) in mix.iter_mut().enumerate().skip(length - release) {
        *sample *= (length - i) as f32 / release as f32;
    }
    let peak = mix.iter().fold(0f32, |peak, value| peak.max(value.abs()));
    let scale = if peak > 0.0 {
        peak_level.clamp(0.0, 0.95) / peak
    } else {
        0.0
    };
    mix.iter()
        .map(|value| (value * scale * f32::from(i16::MAX)) as i16)
        .collect()
}

/// `peak_level` is the chime's peak as a fraction of full scale.
pub(super) fn render_wav(index: usize, peak_level: f32) -> Vec<u8> {
    let samples = render_samples(index, peak_level);
    let bytes = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + bytes as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&bytes.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEAK: f32 = 0.36;
    const OLD_PURE_TONES_HZ: [f32; 13] = [
        523.0, 659.0, 784.0, 587.0, 698.0, 880.0, 622.0, 740.0, 831.0, 932.0, 988.0, 1047.0, 554.0,
    ];

    fn rms(values: impl Iterator<Item = f32>) -> f32 {
        let (sum, count) = values.fold((0f32, 0usize), |(sum, count), v| (sum + v * v, count + 1));
        (sum / count.max(1) as f32).sqrt()
    }

    #[test]
    fn chime_volume_scales_the_peak_and_zero_is_silent() {
        let loud = render_samples(0, 0.8);
        let quiet = render_samples(0, 0.2);
        let peak = |s: &[i16]| s.iter().map(|v| v.unsigned_abs()).max().unwrap();
        assert!((peak(&loud) as f32 / f32::from(i16::MAX) - 0.8).abs() < 0.01);
        assert!((peak(&quiet) as f32 / f32::from(i16::MAX) - 0.2).abs() < 0.01);
        assert_eq!(peak(&render_samples(0, 0.0)), 0);
        assert!(peak(&render_samples(0, 5.0)) <= (0.95 * f32::from(i16::MAX)) as u16 + 1);
    }

    #[test]
    fn every_recipe_is_unique_and_the_main_engines_differ_in_timbre() {
        for (index, left) in MOTIFS.iter().enumerate() {
            for right in &MOTIFS[index + 1..] {
                assert_ne!(left, right);
            }
        }
        // claude, codex, agy, cursor
        let main = [0, 1, 7, 8].map(|index| MOTIFS[index].timbre);
        for (index, timbre) in main.iter().enumerate() {
            assert!(!main[index + 1..].contains(timbre));
        }
    }

    #[test]
    fn chimes_start_crisply_and_stay_bright_without_clipping() {
        for index in 0..MOTIFS.len() {
            let samples = render_samples(index, PEAK);
            let wav = render_wav(index, PEAK);
            assert_eq!(&wav[..4], b"RIFF");
            assert_eq!(wav.len(), 44 + samples.len() * 2);
            let peak = samples.iter().map(|s| s.unsigned_abs()).max().unwrap();
            assert!(peak <= (PEAK * f32::from(i16::MAX)) as u16 + 1);
            let duration = samples.len() as f32 / SAMPLE_RATE as f32;
            assert!(
                (0.4..=0.8).contains(&duration),
                "engine {index}: {duration}s"
            );
            // The old half-sine envelope needed ~75 ms to reach full level,
            // which blurred the onset; a struck chime reaches most of its first
            // note's level within 10 ms.
            let onset = (0.010 * SAMPLE_RATE as f32) as usize;
            let first_note = (0.060 * SAMPLE_RATE as f32) as usize;
            let level = |end: usize| {
                samples[..end]
                    .iter()
                    .map(|s| u32::from(s.unsigned_abs()))
                    .max()
                    .unwrap()
            };
            assert!(
                level(onset) * 10 >= level(first_note) * 7,
                "engine {index}: soft onset"
            );
            // RMS(derivative)/RMS(signal) ≈ 2πf/rate for a sine, so this is an
            // effective-frequency brightness proxy. The old pure tones sat at
            // 523–1047 Hz; harmonics and higher roots lift every chime above them.
            let signal = rms(samples.iter().map(|s| f32::from(*s)));
            let slope = rms(samples
                .windows(2)
                .map(|w| f32::from(w[1]) - f32::from(w[0])));
            let effective_hz = slope / signal * SAMPLE_RATE as f32 / std::f32::consts::TAU;
            assert!(
                effective_hz > 1300.0 && effective_hz > 1.4 * OLD_PURE_TONES_HZ[index],
                "engine {index}: {effective_hz} Hz"
            );
            let last = *samples.last().unwrap();
            assert!(last.unsigned_abs() < 64, "engine {index}: click at end");
        }
    }
}
