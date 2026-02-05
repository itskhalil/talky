use anyhow::Result;

/// Represents a transition in voice activity state
#[derive(Clone, Debug, PartialEq)]
pub enum VadTransition {
    /// Speech has started - contains samples leading up to and including speech onset
    SpeechStart,
    /// Speech has ended - contains the final speech samples
    SpeechEnd,
    /// No transition occurred
    None,
}

/// Voice activity state for tracking speech segments
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum VadState {
    Silence,
    Speech,
}

/// Trait for voice activity detection with transition-based API
pub trait VoiceActivityDetector: Send + Sync {
    /// Process a frame of audio and check for speech/silence transitions.
    /// Returns the transition type if a state change occurred.
    ///
    /// Unlike the old API, this does NOT modify or filter the audio -
    /// it only detects transitions for segmentation purposes.
    fn process_frame(&mut self, frame: &[f32]) -> Result<VadTransition>;

    /// Get the current VAD state (speaking or silent)
    fn state(&self) -> VadState;

    /// Get the current speech probability (0.0-1.0)
    fn probability(&self) -> f32;

    /// Check if currently in speech state
    fn is_speaking(&self) -> bool {
        self.state() == VadState::Speech
    }

    /// Reset the detector state
    fn reset(&mut self);
}

mod silero;

pub use silero::{SileroVad, VAD_CHUNK_SIZE};
