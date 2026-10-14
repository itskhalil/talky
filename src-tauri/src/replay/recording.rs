use anyhow::{Context, Result};
use std::path::Path;

use super::types::ReplaySegment;
use crate::debug_recording::RecordingMetadata;

pub struct DebugRecording {
    pub metadata: RecordingMetadata,
    pub mic_samples: Vec<f32>,
    pub spk_samples: Vec<f32>,
    pub golden: Option<Vec<ReplaySegment>>,
}

impl DebugRecording {
    pub fn load(dir: &Path) -> Result<Self> {
        let metadata_path = dir.join("metadata.json");
        let metadata_str =
            std::fs::read_to_string(&metadata_path).context("Failed to read metadata.json")?;
        let metadata: RecordingMetadata =
            serde_json::from_str(&metadata_str).context("Failed to parse metadata.json")?;

        let mic_samples =
            load_wav(&dir.join("raw_mic.wav")).context("Failed to load raw_mic.wav")?;
        let spk_samples =
            load_wav(&dir.join("raw_spk.wav")).context("Failed to load raw_spk.wav")?;

        let golden = load_golden(dir)?;

        Ok(Self {
            metadata,
            mic_samples,
            spk_samples,
            golden,
        })
    }
}

fn load_wav(path: &Path) -> Result<Vec<f32>> {
    let reader = hound::WavReader::open(path)
        .with_context(|| format!("Failed to open {}", path.display()))?;

    let spec = reader.spec();
    if spec.sample_rate != 16000 || spec.channels != 1 || spec.bits_per_sample != 16 {
        anyhow::bail!(
            "Expected 16kHz mono 16-bit WAV, got {}Hz {}ch {}bit",
            spec.sample_rate,
            spec.channels,
            spec.bits_per_sample
        );
    }

    let samples: Vec<f32> = reader
        .into_samples::<i16>()
        .map(|s| s.map(|v| v as f32 / i16::MAX as f32))
        .collect::<Result<Vec<f32>, _>>()
        .context("Failed to read WAV samples")?;

    Ok(samples)
}

fn load_golden(dir: &Path) -> Result<Option<Vec<ReplaySegment>>> {
    let golden_path = dir.join("golden.json");
    if !golden_path.exists() {
        return Ok(None);
    }
    let golden_str = std::fs::read_to_string(&golden_path).context("Failed to read golden.json")?;
    let segments: Vec<ReplaySegment> =
        serde_json::from_str(&golden_str).context("Failed to parse golden.json")?;
    Ok(Some(segments))
}

const FRAME: usize = 160; // 10 ms at 16 kHz
/// Echo delays this small are what a live session sees anyway (the echo
/// canceller's re-anchoring tolerance); only larger offsets are misalignment.
const ALIGN_TOLERANCE_MS: i64 = 150;
/// Acoustic delay left in place after aligning, so the echo still follows
/// its reference as it does live.
const RESIDUAL_DELAY_MS: i64 = 50;

/// How far the echo of the system audio trails it in the mic, by sample
/// position, if the mic carries a clear echo. Cross-correlates the two
/// channels' 10 ms log-energy envelopes over ±3 s and accepts the peak only
/// when it stands well clear of the rest (with headphones there is no echo
/// and no clear peak).
pub fn echo_lag_ms(mic: &[f32], spk: &[f32]) -> Option<i64> {
    fn envelope(x: &[f32]) -> Vec<f32> {
        let mut e: Vec<f32> = x
            .as_chunks::<FRAME>()
            .0
            .iter()
            .map(|f| ((f.iter().map(|v| v * v).sum::<f32>() / FRAME as f32).sqrt() + 1e-5).ln())
            .collect();
        let mean = e.iter().sum::<f32>() / e.len().max(1) as f32;
        e.iter_mut().for_each(|v| *v -= mean);
        e
    }
    const MAX_LAG: isize = 300;
    let (a, b) = (envelope(mic), envelope(spk));
    let n = a.len().min(b.len());
    if n < 10 * MAX_LAG as usize {
        return None;
    }
    let (a, b) = (&a[..n], &b[..n]);
    // corr[k] compares mic[t] with spk[t - lag], lag = k - MAX_LAG frames.
    let corr: Vec<f32> = (-MAX_LAG..=MAX_LAG)
        .map(|lag| {
            let l = lag.unsigned_abs();
            let (m, s) = if lag >= 0 {
                (&a[l..], &b[..n - l])
            } else {
                (&a[..n - l], &b[l..])
            };
            m.iter().zip(s).map(|(x, y)| x * y).sum::<f32>() / m.len() as f32
        })
        .collect();
    let (best, peak) = corr
        .iter()
        .copied()
        .enumerate()
        .max_by(|x, y| x.1.total_cmp(&y.1))?;
    let mut sorted = corr.clone();
    sorted.sort_by(f32::total_cmp);
    let median = sorted[sorted.len() / 2];
    let mean = corr.iter().sum::<f32>() / corr.len() as f32;
    let std = (corr.iter().map(|c| (c - mean).powi(2)).sum::<f32>() / corr.len() as f32).sqrt();
    let z = (peak - median) / std.max(1e-9);
    (z >= 3.5).then_some((best as i64 - MAX_LAG as i64) * 10)
}

impl DebugRecording {
    /// Line the system audio up with its echo in the mic. Recordings made
    /// before the debug recorder padded a late system-audio tap start it up
    /// to a couple of seconds early by sample position, further than the echo
    /// canceller searches. Returns the shift applied to the system audio in
    /// ms (positive: delayed).
    pub fn align_echo_reference(&mut self) -> i64 {
        let Some(lag) = echo_lag_ms(&self.mic_samples, &self.spk_samples) else {
            return 0;
        };
        if lag.abs() <= ALIGN_TOLERANCE_MS {
            return 0;
        }
        let shift = lag - RESIDUAL_DELAY_MS * lag.signum();
        let samples = (shift.unsigned_abs() as usize) * 16;
        if shift > 0 {
            let mut padded = vec![0.0; samples];
            padded.extend_from_slice(&self.spk_samples);
            self.spk_samples = padded;
        } else {
            self.spk_samples
                .drain(..samples.min(self.spk_samples.len()));
        }
        shift
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Noise bursts switched on and off at random 100 ms boundaries, so the
    /// envelope has structure to match.
    fn speechy(n: usize, seed: u32) -> Vec<f32> {
        let mut s = seed;
        let mut next = move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (s >> 8) as f32 / (1u32 << 24) as f32
        };
        let mut on = false;
        (0..n)
            .map(|i| {
                if i % 1600 == 0 {
                    on = next() < 0.6;
                }
                let v = (next() - 0.5) * 0.2;
                if on {
                    v
                } else {
                    0.0
                }
            })
            .collect()
    }

    #[test]
    fn finds_a_late_echo_and_ignores_headphones() {
        let n = 16000 * 60;
        let far = speechy(n, 1);
        let me = speechy(n, 5);
        let delay = 16000 * 1400 / 1000;
        let echo: Vec<f32> = (0..n)
            .map(|i| {
                me[i] * 0.5
                    + if i >= delay {
                        far[i - delay] * 0.3
                    } else {
                        0.0
                    }
            })
            .collect();
        let lag = echo_lag_ms(&echo, &far).expect("echo found");
        assert!((lag - 1400).abs() <= 20, "lag {lag}");
        // Headphones: the mic only has the user.
        assert_eq!(echo_lag_ms(&me, &far), None);
    }
}
