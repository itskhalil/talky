use std::time::{Duration, Instant};

use crate::audio_toolkit::preprocessing::AudioPreprocessor;

const AMPLITUDE_THROTTLE: Duration = Duration::from_millis(100);

pub struct AmplitudeInfo {
    pub mic_level: f32,
    pub spk_level: f32,
}

/// Smoothed mic and system-audio levels for the recording waveform.
pub struct LevelMeter {
    // Levels are measured on preprocessed audio so the display is consistent
    // across quiet and loud inputs.
    mic_preprocessor: AudioPreprocessor,
    spk_preprocessor: AudioPreprocessor,
    mic_amplitude: f32,
    spk_amplitude: f32,
    mic_smoothed: f32,
    spk_smoothed: f32,
    // System audio is bursty; only smooth when new samples arrived so the
    // level doesn't decay to zero between batches.
    mic_has_new_samples: bool,
    spk_has_new_samples: bool,
    last_emit: Instant,
}

impl Default for LevelMeter {
    fn default() -> Self {
        Self::new()
    }
}

impl LevelMeter {
    const SMOOTHING_ALPHA: f32 = 0.7;
    const MIN_DB: f32 = -40.0;
    const MAX_DB: f32 = 0.0;

    pub fn new() -> Self {
        Self {
            mic_preprocessor: AudioPreprocessor::new(16000),
            spk_preprocessor: AudioPreprocessor::new(16000),
            mic_amplitude: 0.0,
            spk_amplitude: 0.0,
            mic_smoothed: 0.0,
            spk_smoothed: 0.0,
            mic_has_new_samples: false,
            spk_has_new_samples: false,
            last_emit: Instant::now() - AMPLITUDE_THROTTLE,
        }
    }

    pub fn push(&mut self, mic: &[f32], spk: &[f32]) {
        if !mic.is_empty() {
            let mut samples = mic.to_vec();
            self.mic_preprocessor.process(&mut samples);
            self.mic_amplitude = amplitude_from_chunk(&samples);
            self.mic_has_new_samples = true;
        }
        if !spk.is_empty() {
            let mut samples = spk.to_vec();
            self.spk_preprocessor.process(&mut samples);
            self.spk_amplitude = amplitude_from_chunk(&samples);
            self.spk_has_new_samples = true;
        }
        if self.mic_has_new_samples {
            self.mic_smoothed = (1.0 - Self::SMOOTHING_ALPHA) * self.mic_smoothed
                + Self::SMOOTHING_ALPHA * self.mic_amplitude;
            self.mic_has_new_samples = false;
        }
        if self.spk_has_new_samples {
            self.spk_smoothed = (1.0 - Self::SMOOTHING_ALPHA) * self.spk_smoothed
                + Self::SMOOTHING_ALPHA * self.spk_amplitude;
            self.spk_has_new_samples = false;
        }
    }

    /// Current levels, at most every 100 ms.
    pub fn poll(&mut self) -> Option<AmplitudeInfo> {
        if self.last_emit.elapsed() < AMPLITUDE_THROTTLE {
            return None;
        }
        self.last_emit = Instant::now();
        Some(AmplitudeInfo {
            mic_level: self.mic_smoothed,
            spk_level: self.spk_smoothed,
        })
    }
}

fn amplitude_from_chunk(chunk: &[f32]) -> f32 {
    let (sum_squares, count) = chunk
        .iter()
        .filter(|x| x.is_finite())
        .fold((0.0f32, 0usize), |(sum, n), &x| (sum + x * x, n + 1));
    if count == 0 {
        return 0.0;
    }
    let rms = (sum_squares / count as f32).sqrt();
    let db = if rms > 0.0 {
        20.0 * rms.log10()
    } else {
        LevelMeter::MIN_DB
    };
    ((db - LevelMeter::MIN_DB) / (LevelMeter::MAX_DB - LevelMeter::MIN_DB)).clamp(0.0, 1.0)
}
