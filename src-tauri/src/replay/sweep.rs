use anyhow::Result;
use log::info;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use super::engine::ReplayEngine;
use super::runner::{run_replay, ReplayDiagnostics};
use super::scoring::{score, ScoreResult};
use super::types::{ReplayConfig, ReplaySegment};

#[derive(Debug, Deserialize)]
pub struct SweepConfig {
    pub parameters: HashMap<String, Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize)]
pub struct SweepResult {
    pub config: ReplayConfig,
    pub score: ScoreResult,
    pub diagnostics: ReplayDiagnostics,
}

impl SweepConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&content)?)
    }

    /// Generate all parameter combinations (cartesian product).
    fn combinations(&self) -> Vec<Vec<(&str, &serde_json::Value)>> {
        let keys: Vec<&String> = self.parameters.keys().collect();
        let values: Vec<&Vec<serde_json::Value>> =
            keys.iter().map(|k| &self.parameters[*k]).collect();

        let mut result = vec![vec![]];
        for (i, vals) in values.iter().enumerate() {
            let mut new_result = Vec::new();
            for combo in &result {
                for val in *vals {
                    let mut new_combo = combo.clone();
                    new_combo.push((keys[i].as_str(), val));
                    new_result.push(new_combo);
                }
            }
            result = new_result;
        }
        result
    }
}

/// Apply a parameter override to a ReplayConfig.
fn apply_override(config: &mut ReplayConfig, key: &str, value: &serde_json::Value) -> Result<()> {
    match key {
        "vad_threshold" => config.vad_threshold = value.as_f64().unwrap() as f32,
        "vad_onset_frames" => config.vad_onset_frames = value.as_u64().unwrap() as u32,
        "vad_hangover_frames" => config.vad_hangover_frames = value.as_u64().unwrap() as u32,
        "aec_enabled" => config.aec_enabled = value.as_bool().unwrap(),
        "speaker_energy_threshold" => {
            config.speaker_energy_threshold = value.as_f64().unwrap() as f32
        }
        "mic_energy_threshold" => config.mic_energy_threshold = value.as_f64().unwrap() as f32,
        "skip_mic_on_speaker_energy" => {
            config.skip_mic_on_speaker_energy = value.as_bool().unwrap()
        }
        "dedup_similarity_threshold" | "dedup_similarity" => {
            config.dedup_similarity_threshold = value.as_f64().unwrap()
        }
        "dedup_time_overlap_ms" => config.dedup_time_overlap_ms = value.as_i64().unwrap(),
        "min_chunk_samples" => config.min_chunk_samples = value.as_u64().unwrap() as usize,
        "max_chunk_samples" => config.max_chunk_samples = value.as_u64().unwrap() as usize,
        "overlap_samples" => config.overlap_samples = value.as_u64().unwrap() as usize,
        "prefix_overlap_min_words" => {
            config.prefix_overlap_min_words = value.as_u64().unwrap() as usize
        }
        "spk_silence_flush_polls" => {
            config.spk_silence_flush_polls = value.as_u64().unwrap() as u32
        }
        "window_ms" => config.window_ms = value.as_u64().unwrap() as usize,
        "hpf_cutoff" => config.hpf_cutoff = value.as_f64().unwrap() as f32,
        "target_rms" => config.target_rms = value.as_f64().unwrap() as f32,
        "silence_threshold" => config.silence_threshold = value.as_f64().unwrap() as f32,
        "poll_interval_ms" => config.poll_interval_ms = value.as_u64().unwrap(),
        other => anyhow::bail!("Unknown parameter: '{}'", other),
    }
    Ok(())
}

pub fn run_sweep(
    base_config: &ReplayConfig,
    sweep_config: &SweepConfig,
    mic_samples: &[f32],
    spk_samples: &[f32],
    engine: &mut ReplayEngine,
    golden: &[ReplaySegment],
    vad_model_path: &Path,
) -> Result<Vec<SweepResult>> {
    let combinations = sweep_config.combinations();
    let total = combinations.len();
    info!("Running {} parameter combinations...", total);

    let mut results = Vec::with_capacity(total);

    for (i, combo) in combinations.iter().enumerate() {
        let mut config = base_config.clone();
        for (key, value) in combo {
            apply_override(&mut config, key, value)?;
        }

        let param_desc: Vec<String> = combo
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();
        info!("[{}/{}] {}", i + 1, total, param_desc.join(", "));

        let replay_result = run_replay(&config, mic_samples, spk_samples, Some(engine), vad_model_path)?;
        let score_result = score(&replay_result.segments, golden);

        info!(
            "  -> WER: combined={:.1}%, mic={:.1}%, spk={:.1}%",
            score_result.combined_wer * 100.0,
            score_result.mic_wer * 100.0,
            score_result.spk_wer * 100.0
        );

        results.push(SweepResult {
            config,
            score: score_result,
            diagnostics: replay_result.diagnostics,
        });
    }

    // Sort by combined WER
    results.sort_by(|a, b| {
        a.score
            .combined_wer
            .partial_cmp(&b.score.combined_wer)
            .unwrap()
    });

    Ok(results)
}
