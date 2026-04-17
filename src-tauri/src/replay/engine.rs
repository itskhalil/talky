use anyhow::Result;
use std::path::Path;
use transcribe_rs::{
    engines::{
        parakeet::{ParakeetEngine, ParakeetInferenceParams, ParakeetModelParams, TimestampGranularity},
        whisper::{WhisperEngine, WhisperInferenceParams},
    },
    TranscriptionEngine,
};

pub enum ReplayEngine {
    Whisper(WhisperEngine),
    Parakeet(ParakeetEngine),
}

impl ReplayEngine {
    pub fn load_whisper(model_path: &Path) -> Result<Self> {
        let mut engine = WhisperEngine::new();
        engine
            .load_model(model_path)
            .map_err(|e| anyhow::anyhow!("Failed to load Whisper model: {}", e))?;
        Ok(Self::Whisper(engine))
    }

    pub fn load_parakeet(model_path: &Path) -> Result<Self> {
        let mut engine = ParakeetEngine::new();
        engine
            .load_model_with_params(model_path, ParakeetModelParams::int8())
            .map_err(|e| anyhow::anyhow!("Failed to load Parakeet model: {}", e))?;
        Ok(Self::Parakeet(engine))
    }

    pub fn load(engine_type: &str, model_path: &Path) -> Result<Self> {
        match engine_type {
            "whisper" => Self::load_whisper(model_path),
            "parakeet" => Self::load_parakeet(model_path),
            other => anyhow::bail!("Unknown engine type: '{}'. Use 'whisper' or 'parakeet'.", other),
        }
    }

    pub fn transcribe(&mut self, audio: Vec<f32>) -> Result<String> {
        if audio.is_empty() {
            return Ok(String::new());
        }

        let text = match self {
            Self::Whisper(engine) => {
                let params = WhisperInferenceParams {
                    language: None,
                    translate: false,
                    ..Default::default()
                };
                let result = engine
                    .transcribe_samples(audio, Some(params))
                    .map_err(|e| anyhow::anyhow!("Whisper transcription failed: {}", e))?;
                result.text
            }
            Self::Parakeet(engine) => {
                let params = ParakeetInferenceParams {
                    timestamp_granularity: TimestampGranularity::Segment,
                    ..Default::default()
                };
                let result = engine
                    .transcribe_samples(audio, Some(params))
                    .map_err(|e| anyhow::anyhow!("Parakeet transcription failed: {}", e))?;
                result.text
            }
        };

        Ok(text)
    }
}
