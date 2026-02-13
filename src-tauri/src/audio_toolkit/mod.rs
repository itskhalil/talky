pub mod audio;
pub mod constants;
pub mod pipeline;
pub mod preprocessing;
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub mod speaker;
pub mod text;
pub mod utils;
pub mod vad;

pub use audio::{
    list_input_devices, list_output_devices, save_wav_file, AudioRecorder, CpalDeviceInfo,
};
pub use preprocessing::AudioPreprocessor;
pub use text::{
    apply_custom_words, filter_transcription_output, is_hallucination, remove_prefix_overlap,
};
pub use utils::get_cpal_host;
pub use vad::{SileroVad, VadState, VadTransition, VoiceActivityDetector, VAD_CHUNK_SIZE};
