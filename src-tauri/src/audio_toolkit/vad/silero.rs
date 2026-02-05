use anyhow::Result;
use std::path::Path;
use vad_rs::Vad;

use super::{VadState, VadTransition, VoiceActivityDetector};

/// Expected frame size: 480 samples for 16kHz (30ms per frame, as required by vad-rs)
pub const VAD_CHUNK_SIZE: usize = 480;

/// Silero VAD wrapper using the vad-rs crate with transition-based API.
/// Unlike the old implementation, this does NOT filter audio - it only
/// detects speech start/end transitions for segmentation purposes.
pub struct SileroVad {
    detector: Vad,
    threshold: f32,
    state: VadState,
    current_prob: f32,
    // Smoothing parameters to avoid spurious transitions
    onset_frames: usize,    // consecutive speech frames needed to trigger speech start
    hangover_frames: usize, // consecutive silence frames needed to trigger speech end
    onset_counter: usize,
    hangover_counter: usize,
}

impl SileroVad {
    /// Create a new Silero VAD instance.
    ///
    /// # Arguments
    /// * `model_path` - Path to the Silero VAD ONNX model
    /// * `threshold` - Speech detection threshold (0.0-1.0), typically 0.5
    pub fn new<P: AsRef<Path>>(model_path: P, threshold: f32) -> Result<Self> {
        if !(0.0..=1.0).contains(&threshold) {
            anyhow::bail!("threshold must be between 0.0 and 1.0");
        }

        let detector = Vad::new(model_path, 16000)
            .map_err(|e| anyhow::anyhow!("Failed to create VAD: {e}"))?;

        Ok(Self {
            detector,
            threshold,
            state: VadState::Silence,
            current_prob: 0.0,
            onset_frames: 2,     // ~60ms of speech to trigger
            hangover_frames: 5,  // ~150ms of silence to end
            onset_counter: 0,
            hangover_counter: 0,
        })
    }

    /// Create a SileroVad with custom onset and hangover parameters
    pub fn with_smoothing(mut self, onset_frames: usize, hangover_frames: usize) -> Self {
        self.onset_frames = onset_frames;
        self.hangover_frames = hangover_frames;
        self
    }

    /// Get the expected chunk size for this VAD
    pub fn chunk_size() -> usize {
        VAD_CHUNK_SIZE
    }
}

impl VoiceActivityDetector for SileroVad {
    fn process_frame(&mut self, frame: &[f32]) -> Result<VadTransition> {
        if frame.len() != VAD_CHUNK_SIZE {
            anyhow::bail!(
                "expected {} samples, got {}",
                VAD_CHUNK_SIZE,
                frame.len()
            );
        }

        // Get probability from detector
        let result = self
            .detector
            .compute(frame)
            .map_err(|e| anyhow::anyhow!("VAD compute failed: {e}"))?;
        self.current_prob = result.prob;

        let is_speech = self.current_prob > self.threshold;

        match (self.state, is_speech) {
            // In silence, seeing speech
            (VadState::Silence, true) => {
                self.onset_counter += 1;
                self.hangover_counter = 0;
                if self.onset_counter >= self.onset_frames {
                    self.state = VadState::Speech;
                    self.onset_counter = 0;
                    log::info!("VAD: SpeechStart (prob={:.2})", self.current_prob);
                    Ok(VadTransition::SpeechStart)
                } else {
                    Ok(VadTransition::None)
                }
            }
            // In silence, still silence
            (VadState::Silence, false) => {
                self.onset_counter = 0;
                Ok(VadTransition::None)
            }
            // In speech, still speech
            (VadState::Speech, true) => {
                self.hangover_counter = 0;
                Ok(VadTransition::None)
            }
            // In speech, seeing silence (potential end)
            (VadState::Speech, false) => {
                self.hangover_counter += 1;
                if self.hangover_counter >= self.hangover_frames {
                    self.state = VadState::Silence;
                    self.hangover_counter = 0;
                    log::info!("VAD: SpeechEnd (prob={:.2})", self.current_prob);
                    Ok(VadTransition::SpeechEnd)
                } else {
                    Ok(VadTransition::None)
                }
            }
        }
    }

    fn state(&self) -> VadState {
        self.state
    }

    fn probability(&self) -> f32 {
        self.current_prob
    }

    fn reset(&mut self) {
        self.state = VadState::Silence;
        self.current_prob = 0.0;
        self.onset_counter = 0;
        self.hangover_counter = 0;
        self.detector.reset();
    }
}
