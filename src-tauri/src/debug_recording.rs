use anyhow::{Context, Result};
use chrono::Utc;
use hound::{WavSpec, WavWriter};
use serde::Serialize;
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Path, PathBuf};

fn wav_spec() -> WavSpec {
    WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    }
}

#[derive(Debug, Serialize)]
pub struct PipelineConfig {
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
}

#[derive(Debug, Serialize)]
pub struct RecordingSegment {
    pub text: String,
    pub source: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Serialize)]
pub struct RecordingMetadata {
    pub version: u32,
    pub session_id: String,
    pub recorded_at: String,
    pub duration_seconds: f64,
    pub pipeline_config: PipelineConfig,
    pub transcript_segments: Vec<RecordingSegment>,
}

pub struct DebugRecordingWriter {
    dir: PathBuf,
    mic_writer: WavWriter<BufWriter<File>>,
    spk_writer: WavWriter<BufWriter<File>>,
    mic_sample_count: usize,
}

impl DebugRecordingWriter {
    pub fn create(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir)
            .with_context(|| format!("Failed to create debug recording dir: {dir:?}"))?;

        let mic_path = dir.join("raw_mic.wav");
        let spk_path = dir.join("raw_spk.wav");

        let mic_writer = WavWriter::create(&mic_path, wav_spec())
            .with_context(|| format!("Failed to create mic WAV: {mic_path:?}"))?;
        let spk_writer = WavWriter::create(&spk_path, wav_spec())
            .with_context(|| format!("Failed to create spk WAV: {spk_path:?}"))?;

        Ok(Self {
            dir,
            mic_writer,
            spk_writer,
            mic_sample_count: 0,
        })
    }

    pub fn write_mic(&mut self, samples: &[f32]) {
        for &sample in samples {
            let s = (sample * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            let _ = self.mic_writer.write_sample(s);
        }
        self.mic_sample_count += samples.len();
    }

    pub fn write_spk(&mut self, samples: &[f32]) {
        for &sample in samples {
            let s = (sample * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            let _ = self.spk_writer.write_sample(s);
        }
    }

    pub fn finalize(self, metadata: RecordingMetadata) -> Result<()> {
        self.mic_writer
            .finalize()
            .context("Failed to finalize mic WAV")?;
        self.spk_writer
            .finalize()
            .context("Failed to finalize spk WAV")?;

        let metadata_path = self.dir.join("metadata.json");
        let json = serde_json::to_string_pretty(&metadata).context("Failed to serialize metadata")?;
        fs::write(&metadata_path, json)
            .with_context(|| format!("Failed to write metadata: {metadata_path:?}"))?;

        log::info!(
            "Debug recording saved: {:?} ({:.1}s, {} mic samples)",
            self.dir,
            metadata.duration_seconds,
            self.mic_sample_count
        );
        Ok(())
    }
}

/// Remove oldest recording directories, keeping at most `max_count`.
pub fn cleanup_old_recordings(recordings_dir: &Path, max_count: usize) -> Result<()> {
    if !recordings_dir.exists() {
        return Ok(());
    }

    let mut entries: Vec<(PathBuf, std::time::SystemTime)> = fs::read_dir(recordings_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((e.path(), mtime))
        })
        .collect();

    if entries.len() <= max_count {
        return Ok(());
    }

    // Sort oldest-first, then delete the excess from the front
    entries.sort_by_key(|(_, mtime)| *mtime);
    let to_delete = entries.len() - max_count;
    for (path, _) in entries.into_iter().take(to_delete) {
        log::debug!("Removing old debug recording: {path:?}");
        let _ = fs::remove_dir_all(&path);
    }

    Ok(())
}

/// Build the recorded_at timestamp string in RFC 3339 format.
pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}
