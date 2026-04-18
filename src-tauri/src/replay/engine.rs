use anyhow::Result;
use std::path::Path;
use transcribe_rs::{
    engines::parakeet::{
        ParakeetEngine, ParakeetInferenceParams, ParakeetModelParams, TimestampGranularity,
    },
    TranscriptionEngine,
};

#[cfg(target_os = "macos")]
use crate::managers::coreml_asr::{find_sidecar_binary, CoreMlAsr};

pub enum ReplayEngine {
    Parakeet(ParakeetEngine),
    #[cfg(target_os = "macos")]
    ParakeetCoreML(CoreMlAsr),
}

impl ReplayEngine {
    pub fn load_parakeet(model_path: &Path) -> Result<Self> {
        let mut engine = ParakeetEngine::new();
        engine
            .load_model_with_params(model_path, ParakeetModelParams::int8())
            .map_err(|e| anyhow::anyhow!("Failed to load Parakeet model: {}", e))?;
        Ok(Self::Parakeet(engine))
    }

    #[cfg(target_os = "macos")]
    pub fn load_parakeet_coreml(version: &str) -> Result<Self> {
        let bin = find_sidecar_binary()?;
        let mut asr = CoreMlAsr::spawn(&bin, None)?;
        asr.load(version)?;
        Ok(Self::ParakeetCoreML(asr))
    }

    pub fn load(engine_type: &str, model_path: Option<&Path>) -> Result<Self> {
        match engine_type {
            "parakeet" => {
                let path = model_path
                    .ok_or_else(|| anyhow::anyhow!("parakeet engine requires a model path"))?;
                Self::load_parakeet(path)
            }
            #[cfg(target_os = "macos")]
            "coreml" | "coreml-v3" => Self::load_parakeet_coreml("v3"),
            #[cfg(target_os = "macos")]
            "coreml-v2" => Self::load_parakeet_coreml("v2"),
            other => anyhow::bail!(
                "Unknown engine type: '{}'. Use 'parakeet' or 'coreml' (macOS only).",
                other
            ),
        }
    }

    pub fn transcribe(&mut self, audio: Vec<f32>) -> Result<String> {
        if audio.is_empty() {
            return Ok(String::new());
        }

        let text = match self {
            Self::Parakeet(engine) => {
                let params = ParakeetInferenceParams {
                    timestamp_granularity: TimestampGranularity::Segment,
                };
                let result = engine
                    .transcribe_samples(audio, Some(params))
                    .map_err(|e| anyhow::anyhow!("Parakeet transcription failed: {}", e))?;
                result.text
            }
            #[cfg(target_os = "macos")]
            Self::ParakeetCoreML(asr) => {
                let (text, infer_ms) = asr.transcribe(&audio)?;
                log::info!(
                    "coreml transcribed {} samples ({:.2}s) in {:.1}ms ({:.1}x RT)",
                    audio.len(),
                    audio.len() as f64 / 16000.0,
                    infer_ms,
                    (audio.len() as f64 / 16000.0) / (infer_ms / 1000.0),
                );
                text
            }
        };

        Ok(text)
    }
}
