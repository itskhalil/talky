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
