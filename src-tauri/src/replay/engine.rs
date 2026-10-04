use anyhow::Result;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use transcribe_rs::onnx::parakeet::{ParakeetModel, ParakeetParams, TimestampGranularity};
use transcribe_rs::onnx::Quantization;
use transcribe_rs::TranscriptionResult;

#[cfg(target_os = "macos")]
use crate::managers::coreml_asr::{find_sidecar_binary, CoreMlAsr};

/// Total time spent inside the ASR engine, for real-time-factor reporting.
pub static INFER_MICROS: AtomicU64 = AtomicU64::new(0);

pub fn infer_secs() -> f64 {
    INFER_MICROS.load(Ordering::Relaxed) as f64 / 1e6
}

pub enum ReplayEngine {
    Parakeet(ParakeetModel),
    #[cfg(feature = "transcribe-cpp")]
    TranscribeCpp(transcribe_cpp::Session),
    #[cfg(target_os = "macos")]
    ParakeetCoreML(CoreMlAsr),
}

impl ReplayEngine {
    pub fn load_parakeet(model_path: &Path, quantization: &Quantization) -> Result<Self> {
        let engine = ParakeetModel::load(model_path, quantization)
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
                Self::load_parakeet(path, &Quantization::Int8)
            }
            // Full-precision export (`encoder-model.onnx`), for measuring
            // what int8 quantisation costs.
            "parakeet-fp32" => {
                let path = model_path
                    .ok_or_else(|| anyhow::anyhow!("parakeet engine requires a model path"))?;
                Self::load_parakeet(path, &Quantization::FP32)
            }
            // transcribe.cpp on its automatic backend (Metal on Apple
            // Silicon, Vulkan/CPU elsewhere) or strictly on the CPU.
            #[cfg(feature = "transcribe-cpp")]
            "tcpp" | "tcpp-cpu" => {
                let path = model_path
                    .ok_or_else(|| anyhow::anyhow!("tcpp engine requires a .gguf model path"))?;
                let options = transcribe_cpp::ModelOptions {
                    backend: if engine_type == "tcpp-cpu" {
                        transcribe_cpp::Backend::Cpu
                    } else {
                        transcribe_cpp::Backend::Auto
                    },
                    ..Default::default()
                };
                let model = transcribe_cpp::Model::load_with(path, &options)
                    .map_err(|e| anyhow::anyhow!("transcribe.cpp load failed: {e}"))?;
                let session = model
                    .session()
                    .map_err(|e| anyhow::anyhow!("transcribe.cpp session failed: {e}"))?;
                Ok(Self::TranscribeCpp(session))
            }
            #[cfg(target_os = "macos")]
            "coreml" | "coreml-v3" => Self::load_parakeet_coreml("v3"),
            #[cfg(target_os = "macos")]
            "coreml-v2" => Self::load_parakeet_coreml("v2"),
            #[cfg(target_os = "macos")]
            "coreml-ultra" => Self::load_parakeet_coreml("ultra"),
            other => anyhow::bail!(
                "Unknown engine type: '{}'. Use 'parakeet', 'parakeet-fp32', 'coreml', 'coreml-ultra' (macOS) or 'tcpp', 'tcpp-cpu' (feature transcribe-cpp).",
                other
            ),
        }
    }

    pub fn transcribe(&mut self, audio: Vec<f32>) -> Result<String> {
        Ok(self.transcribe_result(&audio)?.text)
    }

    /// Transcribe with whatever timestamps the engine provides, applying the
    /// same text post-processing as the live app.
    pub fn transcribe_result(&mut self, audio: &[f32]) -> Result<TranscriptionResult> {
        if audio.is_empty() {
            return Ok(TranscriptionResult {
                text: String::new(),
                segments: None,
            });
        }

        let started = Instant::now();
        let mut result = match self {
            Self::Parakeet(engine) => {
                let params = ParakeetParams {
                    timestamp_granularity: Some(TimestampGranularity::Segment),
                    ..Default::default()
                };
                engine
                    .transcribe_with(audio, &params)
                    .map_err(|e| anyhow::anyhow!("Parakeet transcription failed: {}", e))?
            }
            #[cfg(target_os = "macos")]
            Self::ParakeetCoreML(asr) => {
                let t = asr.transcribe_timed(audio)?;
                log::info!(
                    "coreml transcribed {} samples ({:.2}s) in {:.1}ms ({:.1}x RT)",
                    audio.len(),
                    audio.len() as f64 / 16000.0,
                    t.infer_ms,
                    (audio.len() as f64 / 16000.0) / (t.infer_ms / 1000.0),
                );
                let segments = t.speech_span.map(|(start, end)| {
                    vec![transcribe_rs::TranscriptionSegment {
                        start: start as f32,
                        end: end as f32,
                        text: t.text.clone(),
                    }]
                });
                TranscriptionResult {
                    text: t.text,
                    segments,
                }
            }
            #[cfg(feature = "transcribe-cpp")]
            Self::TranscribeCpp(session) => {
                let t = session
                    .run(audio, &transcribe_cpp::RunOptions::default())
                    .map_err(|e| anyhow::anyhow!("transcribe.cpp run failed: {e}"))?;
                let segments = t
                    .segments
                    .iter()
                    .map(|s| transcribe_rs::TranscriptionSegment {
                        start: s.t0_ms as f32 / 1000.0,
                        end: s.t1_ms as f32 / 1000.0,
                        text: s.text.clone(),
                    })
                    .collect::<Vec<_>>();
                TranscriptionResult {
                    text: t.text,
                    segments: (!segments.is_empty()).then_some(segments),
                }
            }
        };
        INFER_MICROS.fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);

        // Same post-processing the live app applies in TranscriptionManager.
        let raw = std::mem::take(&mut result.text);
        result.text = crate::audio_toolkit::text::filter_transcription_output(&raw);
        if result.text != raw {
            log::debug!("post-filter changed {:?} -> {:?}", raw, result.text);
        }
        if result.text.is_empty() {
            result.segments = None;
        }
        Ok(result)
    }
}

impl crate::audio_toolkit::session_transcriber::ChunkEngine for ReplayEngine {
    fn transcribe(&mut self, audio: &[f32]) -> Result<TranscriptionResult> {
        self.transcribe_result(audio)
    }
}
