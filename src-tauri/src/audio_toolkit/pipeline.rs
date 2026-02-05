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
        }
    }

    /// Push mic samples into the pipeline.
    /// Preprocesses audio, applies AEC if available, runs VAD, and accumulates.
    pub fn push_mic(&mut self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }

        // Keep raw audio for VAD (preprocessing can affect detection)
        let raw_samples = samples.to_vec();

        // Preprocess mic audio for transcription
        let mut preprocessed = samples.to_vec();
        self.mic_preprocessor.process(&mut preprocessed);

        // Apply AEC if available
        let cleaned = if let Some(ref mut aec) = self.aec {
            // Use accumulated speaker as reference for echo cancellation
            let spk_ref = if self.accumulated_spk.len() >= preprocessed.len() {
                // Use most recent speaker samples as reference
                let start = self.accumulated_spk.len() - preprocessed.len();
                &self.accumulated_spk[start..]
            } else if !self.accumulated_spk.is_empty() {
                // Pad with zeros if speaker buffer is smaller
                &self.accumulated_spk[..]
            } else {
                // No speaker reference available
                &[]
            };

            if !spk_ref.is_empty() {
                match aec.process_streaming(&preprocessed, spk_ref) {
                    Ok(result) => result,
                    Err(e) => {
                        log::warn!("AEC failed: {}", e);
                        preprocessed
                    }
                }
            } else {
                preprocessed
            }
        } else {
            preprocessed
        };

        // Update amplitude tracking
        self.mic_amplitude = Self::amplitude_from_chunk(&cleaned);

        // Process VAD for segmentation using RAW audio (preprocessing affects VAD)
        self.process_vad_samples(&raw_samples);

        // Accumulate preprocessed audio
        self.accumulated_mic.extend_from_slice(&cleaned);
    }

    /// Push speaker samples into the pipeline.
    /// Preprocesses and accumulates for AEC reference.
    pub fn push_spk(&mut self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }

        // Preprocess speaker audio
        let mut preprocessed = samples.to_vec();
        self.spk_preprocessor.process(&mut preprocessed);

        // Update amplitude tracking
        self.spk_amplitude = Self::amplitude_from_chunk(&preprocessed);

        // Accumulate for transcription and AEC reference
        self.accumulated_spk.extend_from_slice(&preprocessed);
    }

    /// Poll for pipeline events.
    /// Returns the current state including whether speech ended.
    pub fn poll_event(&mut self) -> PipelineEvent {
        // Apply smoothing for amplitude
        self.mic_smoothed = (1.0 - Self::SMOOTHING_ALPHA) * self.mic_smoothed
            + Self::SMOOTHING_ALPHA * self.mic_amplitude;
        self.spk_smoothed = (1.0 - Self::SMOOTHING_ALPHA) * self.spk_smoothed
            + Self::SMOOTHING_ALPHA * self.spk_amplitude;

        // Reset amplitude after reading (they'll be updated on next push)
        self.mic_amplitude = 0.0;
        self.spk_amplitude = 0.0;

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
        if let Some(vad) = &mut self.vad {
            vad.reset();
        }
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
