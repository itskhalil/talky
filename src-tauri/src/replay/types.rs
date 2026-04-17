use crate::debug_recording::PipelineConfig;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReplayConfig {
    pub vad_threshold: f32,
    pub vad_onset_frames: u32,
    pub vad_hangover_frames: u32,
    pub aec_enabled: bool,
    pub speaker_energy_threshold: f32,
    pub mic_energy_threshold: f32,
    pub skip_mic_on_speaker_energy: bool,
    pub dedup_similarity_threshold: f64,
    pub dedup_time_overlap_ms: i64,
    pub min_chunk_samples: usize,
    pub max_chunk_samples: usize,
    pub overlap_samples: usize,
    pub prefix_overlap_min_words: usize,
    pub spk_silence_flush_polls: u32,
    pub window_ms: usize,
    pub hpf_cutoff: f32,
    pub target_rms: f32,
    pub silence_threshold: f32,
    pub poll_interval_ms: u64,
}

impl ReplayConfig {
    pub fn from_pipeline_config(pc: &PipelineConfig) -> Self {
        Self {
            vad_threshold: pc.vad_threshold,
            vad_onset_frames: pc.vad_onset_frames,
            vad_hangover_frames: pc.vad_hangover_frames,
            aec_enabled: pc.aec_enabled,
            speaker_energy_threshold: pc.speaker_energy_threshold,
            mic_energy_threshold: pc.mic_energy_threshold,
            skip_mic_on_speaker_energy: pc.skip_mic_on_speaker_energy,
            dedup_similarity_threshold: pc.dedup_similarity_threshold,
            dedup_time_overlap_ms: pc.dedup_time_overlap_ms,
            min_chunk_samples: pc.min_chunk_samples,
            max_chunk_samples: pc.max_chunk_samples,
            overlap_samples: 6400,
            prefix_overlap_min_words: 2,
            spk_silence_flush_polls: 4,
            window_ms: 400,
            hpf_cutoff: 80.0,
            target_rms: 0.1,
            silence_threshold: 0.01,
            poll_interval_ms: 250,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReplaySegment {
    pub text: String,
    pub source: String,
    pub start_ms: i64,
    pub end_ms: i64,
}
