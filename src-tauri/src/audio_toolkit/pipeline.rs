use std::time::{Duration, Instant};

use crate::audio_toolkit::preprocessing::AudioPreprocessor;
use crate::audio_toolkit::vad::{VadTransition, VAD_CHUNK_SIZE};
use crate::audio_toolkit::VoiceActivityDetector;

const AMPLITUDE_THROTTLE: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ChannelMode {
    MicOnly,
    SpeakerOnly,
    MicAndSpeaker,
}

pub struct AmplitudeInfo {
    pub mic_level: f32,
    pub spk_level: f32,
}

/// Result of processing audio through the pipeline
#[derive(Clone, Debug)]
pub struct PipelineEvent {
    /// Whether speech just ended on the mic channel (trigger transcription)
    pub mic_speech_ended: bool,
    /// Whether the mic is currently speaking
    pub mic_is_speaking: bool,
    /// Current mic VAD probability
    pub mic_vad_prob: f32,
}

pub struct Pipeline {
    mode: ChannelMode,
    vad: Option<Box<dyn VoiceActivityDetector>>,
    aec: Option<crate::aec::AEC>,
    // Audio preprocessors for quality improvement
    mic_preprocessor: AudioPreprocessor,
    spk_preprocessor: AudioPreprocessor,
    // Accumulated audio (raw 16kHz samples)
    accumulated_mic: Vec<f32>,
    accumulated_spk: Vec<f32>,
    // Buffer for VAD frame processing
    vad_buffer: Vec<f32>,
    // Speech state tracking
    speech_ended_flag: bool,
    // Amplitude tracking
    mic_amplitude: f32,
    spk_amplitude: f32,
    // Amplitude smoothing
    mic_smoothed: f32,
    spk_smoothed: f32,
    last_amplitude_emit: Instant,
    // Track whether new samples arrived (for bursty speaker audio)
    mic_has_new_samples: bool,
    spk_has_new_samples: bool,
}

impl Pipeline {
    const SMOOTHING_ALPHA: f32 = 0.7;
    const MIN_DB: f32 = -60.0;
    const MAX_DB: f32 = 0.0;

    pub fn new(
        _mic_sample_rate: u32,
        _spk_sample_rate: u32,
        vad: Option<Box<dyn VoiceActivityDetector>>,
        aec: Option<crate::aec::AEC>,
        mode: ChannelMode,
    ) -> Self {
        // Note: sample rates are ignored now since both streams arrive at 16kHz
        Self {
            mode,
            vad,
            aec,
            mic_preprocessor: AudioPreprocessor::new(16000),
            spk_preprocessor: AudioPreprocessor::new(16000),
            accumulated_mic: Vec::new(),
            accumulated_spk: Vec::new(),
            vad_buffer: Vec::new(),
            speech_ended_flag: false,
            mic_amplitude: 0.0,
            spk_amplitude: 0.0,
            mic_smoothed: 0.0,
            spk_smoothed: 0.0,
            last_amplitude_emit: Instant::now() - AMPLITUDE_THROTTLE,
            mic_has_new_samples: false,
            spk_has_new_samples: false,
        }
    }

    /// Push mic samples into the pipeline.
    /// Accumulates raw audio for AEC processing later. VAD runs on raw audio.
    /// Preprocessing is applied after AEC in apply_aec_to_accumulated().
    pub fn push_mic(&mut self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }

        self.mic_has_new_samples = true;

        // VAD uses raw audio
        self.process_vad_samples(samples);

        // Amplitude tracking uses preprocessed (for consistent display)
        let mut for_amplitude = samples.to_vec();
        self.mic_preprocessor.process(&mut for_amplitude);
        self.mic_amplitude = Self::amplitude_from_chunk(&for_amplitude);

        // Accumulate RAW audio (AEC needs unmodified samples to preserve amplitude relationship)
        self.accumulated_mic.extend_from_slice(samples);
    }

    /// Push speaker samples into the pipeline.
    /// Accumulates raw audio for AEC reference. Preprocessing is applied after AEC.
    pub fn push_spk(&mut self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }

        self.spk_has_new_samples = true;

        // Amplitude tracking uses preprocessed (for consistent display)
        let mut for_amplitude = samples.to_vec();
        self.spk_preprocessor.process(&mut for_amplitude);
        self.spk_amplitude = Self::amplitude_from_chunk(&for_amplitude);

        // Accumulate RAW audio (AEC needs unmodified samples to preserve amplitude relationship)
        self.accumulated_spk.extend_from_slice(samples);
    }

    /// Poll for pipeline events.
    /// Returns the current state including whether speech ended.
    pub fn poll_event(&mut self) -> PipelineEvent {
        // Only apply amplitude smoothing when new samples arrived
        // (speaker audio is bursty, so we don't want to decay to 0 between batches)
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

        let event = PipelineEvent {
            mic_speech_ended: self.speech_ended_flag,
            mic_is_speaking: self.is_speaking(),
            mic_vad_prob: self.vad_probability(),
        };

        // Reset speech ended flag after reading
        self.speech_ended_flag = false;

        event
    }

    /// Process audio samples through VAD for segmentation
    fn process_vad_samples(&mut self, samples: &[f32]) {
        if self.vad.is_none() {
            return;
        }

        // Buffer samples until we have a full VAD frame
        self.vad_buffer.extend_from_slice(samples);

        // Process complete VAD frames
        while self.vad_buffer.len() >= VAD_CHUNK_SIZE {
            let frame: Vec<f32> = self.vad_buffer.drain(..VAD_CHUNK_SIZE).collect();

            if let Some(ref mut vad) = self.vad {
                match vad.process_frame(&frame) {
                    Ok(VadTransition::SpeechEnd) => {
                        log::debug!("Pipeline: VAD speech ended");
                        self.speech_ended_flag = true;
                    }
                    Ok(VadTransition::SpeechStart) => {
                        log::debug!("Pipeline: VAD speech started");
                    }
                    Ok(VadTransition::None) => {}
                    Err(e) => {
                        log::warn!("VAD process_frame error: {}", e);
                    }
                }
            }
        }
    }

    /// Check if currently speaking (based on VAD state)
    pub fn is_speaking(&self) -> bool {
        self.vad.as_ref().map(|v| v.is_speaking()).unwrap_or(false)
    }

    /// Get current VAD probability
    pub fn vad_probability(&self) -> f32 {
        self.vad.as_ref().map(|v| v.probability()).unwrap_or(0.0)
    }

    pub fn get_amplitude(&mut self) -> Option<AmplitudeInfo> {
        if self.last_amplitude_emit.elapsed() < AMPLITUDE_THROTTLE {
            return None;
        }
        self.last_amplitude_emit = Instant::now();
        Some(AmplitudeInfo {
            mic_level: self.mic_smoothed,
            spk_level: self.spk_smoothed,
        })
    }

    pub fn accumulated_mic_len(&self) -> usize {
        self.accumulated_mic.len()
    }

    /// Get RMS energy of accumulated speaker audio
    pub fn accumulated_spk_energy(&self) -> f32 {
        if self.accumulated_spk.is_empty() {
            return 0.0;
        }
        let sum_sq: f32 = self.accumulated_spk.iter().map(|x| x * x).sum();
        (sum_sq / self.accumulated_spk.len() as f32).sqrt()
    }

    pub fn take_accumulated(&mut self, min_samples: usize) -> Option<(Vec<f32>, Vec<f32>)> {
        if self.accumulated_mic.len() >= min_samples {
            let mic = std::mem::take(&mut self.accumulated_mic);
            let spk = std::mem::take(&mut self.accumulated_spk);
            Some((mic, spk))
        } else {
            None
        }
    }

    pub fn take_all_accumulated(&mut self) -> (Vec<f32>, Vec<f32>) {
        let mic = std::mem::take(&mut self.accumulated_mic);
        let spk = std::mem::take(&mut self.accumulated_spk);
        (mic, spk)
    }

    /// Take accumulated audio with overlap for context continuity.
    /// Returns (mic, spk) and leaves `overlap_samples` in the buffer.
    pub fn take_with_overlap(&mut self, overlap_samples: usize) -> (Vec<f32>, Vec<f32>) {
        let mic = std::mem::take(&mut self.accumulated_mic);
        let spk = std::mem::take(&mut self.accumulated_spk);

        // Keep overlap samples for next chunk
        if mic.len() > overlap_samples {
            self.accumulated_mic = mic[mic.len() - overlap_samples..].to_vec();
        }
        if spk.len() > overlap_samples {
            self.accumulated_spk = spk[spk.len() - overlap_samples..].to_vec();
        }

        (mic, spk)
    }

    /// Take mic audio with time-windowed speaker energy filtering.
    /// Divides audio into windows and zeros out mic windows where speaker energy exceeded threshold.
    /// Returns filtered mic audio and clears accumulated buffers (keeping overlap).
    ///
    /// # Arguments
    /// * `threshold` - RMS energy threshold above which speaker is considered active
    /// * `window_ms` - Window size in milliseconds (e.g., 200ms)
    /// * `overlap_samples` - Number of samples to keep for context continuity
    ///
    /// # Returns
    /// Filtered mic audio with speaker-active portions zeroed, and the number of windows zeroed
    pub fn take_filtered_mic(
        &mut self,
        threshold: f32,
        window_ms: usize,
        overlap_samples: usize,
    ) -> (Vec<f32>, usize) {
        const SAMPLE_RATE: usize = 16000;
        let window_samples = (window_ms * SAMPLE_RATE) / 1000;

        let mic = std::mem::take(&mut self.accumulated_mic);
        let spk = std::mem::take(&mut self.accumulated_spk);

        // Keep overlap for next chunk
        if mic.len() > overlap_samples {
            self.accumulated_mic = mic[mic.len() - overlap_samples..].to_vec();
        }
        if spk.len() > overlap_samples {
            self.accumulated_spk = spk[spk.len() - overlap_samples..].to_vec();
        }

        // If no speaker audio, return mic as-is
        if spk.is_empty() {
            return (mic, 0);
        }

        let mut filtered = mic.clone();
        let mut windows_zeroed = 0;
        let num_windows = mic.len().saturating_sub(1) / window_samples + 1;

        for i in 0..num_windows {
            let mic_start = i * window_samples;
            let mic_end = ((i + 1) * window_samples).min(mic.len());

            // Calculate corresponding speaker window
            // Speaker audio may be shorter or longer, so clamp indices
            let spk_start = mic_start.min(spk.len());
            let spk_end = mic_end.min(spk.len());

            if spk_end > spk_start {
                // Calculate RMS energy for this speaker window
                let spk_window = &spk[spk_start..spk_end];
                let sum_sq: f32 = spk_window.iter().map(|x| x * x).sum();
                let rms = (sum_sq / spk_window.len() as f32).sqrt();

                if rms > threshold {
                    // Zero out this mic window (speaker was active)
                    for sample in &mut filtered[mic_start..mic_end] {
                        *sample = 0.0;
                    }
                    windows_zeroed += 1;
                    log::debug!(
                        "Window {}/{}: speaker active (rms={:.4} > {:.4}), zeroing mic",
                        i + 1,
                        num_windows,
                        rms,
                        threshold
                    );
                }
            }
        }

        if windows_zeroed > 0 {
            log::info!(
                "Windowed filtering: zeroed {}/{} windows ({:.0}% of audio)",
                windows_zeroed,
                num_windows,
                (windows_zeroed as f32 / num_windows as f32) * 100.0
            );
        }

        (filtered, windows_zeroed)
    }

    pub fn reset(&mut self) {
        self.mic_preprocessor.reset();
        self.spk_preprocessor.reset();
        self.accumulated_mic.clear();
        self.accumulated_spk.clear();
        self.vad_buffer.clear();
        self.speech_ended_flag = false;
        self.mic_amplitude = 0.0;
        self.spk_amplitude = 0.0;
        self.mic_smoothed = 0.0;
        self.spk_smoothed = 0.0;
        self.mic_has_new_samples = false;
        self.spk_has_new_samples = false;
        if let Some(vad) = &mut self.vad {
            vad.reset();
        }
    }

    /// Apply AEC to accumulated audio before transcription.
    /// This is called once per chunk when both streams are aligned.
    /// After AEC, preprocessing is applied to both mic and speaker audio.
    pub fn apply_aec_to_accumulated(&mut self) {
        let mic_len = self.accumulated_mic.len();
        let spk_len = self.accumulated_spk.len();

        if let Some(ref mut aec) = self.aec {
            log::info!(
                "AEC: mic_samples={} ({:.2}s), spk_samples={} ({:.2}s)",
                mic_len,
                mic_len as f32 / 16000.0,
                spk_len,
                spk_len as f32 / 16000.0
            );

            if spk_len == 0 {
                log::warn!("AEC skipped: no speaker samples available");
                // Still preprocess mic audio even without AEC
                self.mic_preprocessor.process(&mut self.accumulated_mic);
                return;
            }
            if mic_len == 0 {
                // Preprocess speaker audio
                self.spk_preprocessor.process(&mut self.accumulated_spk);
                return;
            }

            // Use whichever is shorter to ensure alignment
            let len = mic_len.min(spk_len);

            // Calculate energy levels for debugging (raw audio, before normalization)
            let mic_energy: f32 = self.accumulated_mic[..len]
                .iter()
                .map(|x| x * x)
                .sum::<f32>()
                / len as f32;
            let spk_energy: f32 = self.accumulated_spk[..len]
                .iter()
                .map(|x| x * x)
                .sum::<f32>()
                / len as f32;

            log::info!(
                "AEC processing {} samples, mic_rms={:.4}, spk_rms={:.4}",
                len,
                mic_energy.sqrt(),
                spk_energy.sqrt()
            );

            match aec.process_streaming(&self.accumulated_mic[..len], &self.accumulated_spk[..len])
            {
                Ok(cleaned) => {
                    // Calculate cleaned energy
                    let cleaned_energy: f32 =
                        cleaned.iter().map(|x| x * x).sum::<f32>() / cleaned.len().max(1) as f32;
                    log::info!(
                        "AEC result: cleaned_rms={:.4}, reduction={:.1}dB",
                        cleaned_energy.sqrt(),
                        if mic_energy > 0.0 && cleaned_energy > 0.0 {
                            10.0 * (mic_energy / cleaned_energy).log10()
                        } else {
                            0.0
                        }
                    );
                    // Replace mic audio with AEC-cleaned version
                    self.accumulated_mic.splice(..len, cleaned);
                }
                Err(e) => {
                    log::warn!("AEC failed: {}", e);
                }
            }
        }

        // After AEC (or if no AEC), preprocess both streams for transcription
        self.mic_preprocessor.process(&mut self.accumulated_mic);
        self.spk_preprocessor.process(&mut self.accumulated_spk);
    }

    /// Get channel mode
    #[allow(dead_code)]
    pub fn mode(&self) -> ChannelMode {
        self.mode
    }

    fn amplitude_from_chunk(chunk: &[f32]) -> f32 {
        if chunk.is_empty() {
            return 0.0;
        }

        let sum_squares: f32 = chunk.iter().filter(|x| x.is_finite()).map(|&x| x * x).sum();
        let count = chunk.iter().filter(|x| x.is_finite()).count();
        if count == 0 {
            return 0.0;
        }
        let rms = (sum_squares / count as f32).sqrt();

        let db = if rms > 0.0 {
            20.0 * rms.log10()
        } else {
            Self::MIN_DB
        };

        ((db - Self::MIN_DB) / (Self::MAX_DB - Self::MIN_DB)).clamp(0.0, 1.0)
    }
}
