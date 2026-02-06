use crate::audio_toolkit::{apply_custom_words, filter_transcription_output};
use crate::managers::model::{EngineType, ModelManager};
use crate::settings::{get_settings, ModelUnloadTimeout};
use anyhow::Result;
use log::{debug, error, info, warn};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Clone, Debug, Serialize)]
pub struct ModelStateEvent {
    pub event_type: String,
    pub model_id: Option<String>,
    pub model_name: Option<String>,
    pub error: Option<String>,
}

/// Loaded whisper context with its state
struct WhisperEngine {
    context: WhisperContext,
}

impl WhisperEngine {
    fn new(model_path: &std::path::Path) -> Result<Self> {
        let params = WhisperContextParameters::default();
        let model_path_str = model_path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid model path"))?;
        let context = WhisperContext::new_with_params(model_path_str, params)
            .map_err(|e| anyhow::anyhow!("Failed to create whisper context: {}", e))?;
        Ok(Self { context })
    }

    fn transcribe(
        &self,
        audio: &[f32],
        language: Option<&str>,
        translate: bool,
        initial_prompt: Option<&str>,
    ) -> Result<String> {
        // Create state for this transcription
        let mut state = self
            .context
            .create_state()
            .map_err(|e| anyhow::anyhow!("Failed to create whisper state: {}", e))?;

        // Configure parameters per the plan:
        // Greedy decoding, temp=0.0, single_segment=true
        // entropy_thold=2.4, logprob_thold=-1.0
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

        // Temperature 0 for deterministic decoding
        params.set_temperature(0.0);

        // Single segment mode for lower latency
        params.set_single_segment(true);

        // Quality thresholds to reject hallucinations
        params.set_entropy_thold(2.4);
        params.set_logprob_thold(-1.0);

        // Suppress non-speech tokens
        params.set_suppress_nst(true);

        // Language setting
        if let Some(lang) = language {
            params.set_language(Some(lang));
        } else {
            params.set_language(None); // Auto-detect
        }

        // Translation
        params.set_translate(translate);

        // Initial prompt for context continuity (per the plan)
        if let Some(prompt) = initial_prompt {
            params.set_initial_prompt(prompt);
        }

        // Disable timestamps for lower latency
        params.set_token_timestamps(false);

        // Run transcription
        state
            .full(params, audio)
            .map_err(|e| anyhow::anyhow!("Whisper transcription failed: {}", e))?;

        // Collect segments
        let num_segments = state.full_n_segments();
        let mut text = String::new();
        for i in 0..num_segments {
            if let Some(segment) = state.get_segment(i) {
                // Use to_str_lossy to handle any invalid UTF-8 gracefully
                if let Ok(segment_text) = segment.to_str_lossy() {
                    text.push_str(&segment_text);
                    text.push(' ');
                }
            }
        }

        Ok(text.trim().to_string())
    }
}

enum LoadedEngine {
    Whisper(WhisperEngine),
    // Parakeet support removed per plan - requires parakeet-rs with ort rc.11
    // Moonshine support removed per plan - lowest accuracy, no context mechanism
}

#[derive(Clone)]
pub struct TranscriptionManager {
    engine: Arc<Mutex<Option<LoadedEngine>>>,
    model_manager: Arc<ModelManager>,
    app_handle: AppHandle,
    current_model_id: Arc<Mutex<Option<String>>>,
    last_activity: Arc<AtomicU64>,
    shutdown_signal: Arc<AtomicBool>,
    watcher_handle: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
    is_loading: Arc<Mutex<bool>>,
    loading_condvar: Arc<Condvar>,
}

impl TranscriptionManager {
    pub fn new(app_handle: &AppHandle, model_manager: Arc<ModelManager>) -> Result<Self> {
        let manager = Self {
            engine: Arc::new(Mutex::new(None)),
            model_manager,
            app_handle: app_handle.clone(),
            current_model_id: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(AtomicU64::new(
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
            )),
            shutdown_signal: Arc::new(AtomicBool::new(false)),
            watcher_handle: Arc::new(Mutex::new(None)),
            is_loading: Arc::new(Mutex::new(false)),
            loading_condvar: Arc::new(Condvar::new()),
        };

        // Start the idle watcher
        {
            let app_handle_cloned = app_handle.clone();
            let manager_cloned = manager.clone();
            let shutdown_signal = manager.shutdown_signal.clone();
            let handle = thread::spawn(move || {
                while !shutdown_signal.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_secs(10)); // Check every 10 seconds

                    // Check shutdown signal again after sleep
                    if shutdown_signal.load(Ordering::Relaxed) {
                        break;
                    }

                    let settings = get_settings(&app_handle_cloned);
                    let timeout_seconds = settings.model_unload_timeout.to_seconds();

                    if let Some(limit_seconds) = timeout_seconds {
                        // Skip polling-based unloading for immediate timeout since it's handled directly in transcribe()
                        if settings.model_unload_timeout == ModelUnloadTimeout::Immediately {
                            continue;
                        }

                        let last = manager_cloned.last_activity.load(Ordering::Relaxed);
                        let now_ms = SystemTime::now()
                            .duration_since(SystemTime::UNIX_EPOCH)
                            .unwrap()
                            .as_millis() as u64;

                        if now_ms.saturating_sub(last) > limit_seconds * 1000 {
                            // idle -> unload
                            if manager_cloned.is_model_loaded() {
                                let unload_start = std::time::Instant::now();
                                debug!("Starting to unload model due to inactivity");

                                if let Ok(()) = manager_cloned.unload_model() {
                                    let _ = app_handle_cloned.emit(
                                        "model-state-changed",
                                        ModelStateEvent {
                                            event_type: "unloaded".to_string(),
                                            model_id: None,
                                            model_name: None,
                                            error: None,
                                        },
                                    );
                                    let unload_duration = unload_start.elapsed();
                                    debug!(
                                        "Model unloaded due to inactivity (took {}ms)",
                                        unload_duration.as_millis()
                                    );
                                }
                            }
                        }
                    }
                }
                debug!("Idle watcher thread shutting down gracefully");
            });
            *manager.watcher_handle.lock().unwrap() = Some(handle);
        }

        Ok(manager)
    }

    pub fn is_model_loaded(&self) -> bool {
        let engine = self.engine.lock().unwrap();
        engine.is_some()
    }

    pub fn unload_model(&self) -> Result<()> {
        let unload_start = std::time::Instant::now();
        debug!("Starting to unload model");

        {
            let mut engine = self.engine.lock().unwrap();
            *engine = None; // Drop the engine to free memory
        }
        {
            let mut current_model = self.current_model_id.lock().unwrap();
            *current_model = None;
        }

        // Emit unloaded event
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "unloaded".to_string(),
                model_id: None,
                model_name: None,
                error: None,
            },
        );

        let unload_duration = unload_start.elapsed();
        debug!(
            "Model unloaded manually (took {}ms)",
            unload_duration.as_millis()
        );
        Ok(())
    }

    /// Unloads the model immediately if the setting is enabled and the model is loaded
    pub fn maybe_unload_immediately(&self, context: &str) {
        let settings = get_settings(&self.app_handle);
        if settings.model_unload_timeout == ModelUnloadTimeout::Immediately
            && self.is_model_loaded()
        {
            info!("Immediately unloading model after {}", context);
            if let Err(e) = self.unload_model() {
                warn!("Failed to immediately unload model: {}", e);
            }
        }
    }

    pub fn load_model(&self, model_id: &str) -> Result<()> {
        let load_start = std::time::Instant::now();
        debug!("Starting to load model: {}", model_id);

        // Emit loading started event
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "loading_started".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: None,
                error: None,
            },
        );

        let model_info = self
            .model_manager
            .get_model_info(model_id)
            .ok_or_else(|| anyhow::anyhow!("Model not found: {}", model_id))?;

        if !model_info.is_downloaded {
            let error_msg = "Model not downloaded";
            let _ = self.app_handle.emit(
                "model-state-changed",
                ModelStateEvent {
                    event_type: "loading_failed".to_string(),
                    model_id: Some(model_id.to_string()),
                    model_name: Some(model_info.name.clone()),
                    error: Some(error_msg.to_string()),
                },
            );
            return Err(anyhow::anyhow!(error_msg));
        }

        let model_path = self.model_manager.get_model_path(model_id)?;

        // Create appropriate engine based on model type
        let loaded_engine = match model_info.engine_type {
            EngineType::Whisper => {
                let engine = WhisperEngine::new(&model_path).map_err(|e| {
                    let error_msg = format!("Failed to load whisper model {}: {}", model_id, e);
                    let _ = self.app_handle.emit(
                        "model-state-changed",
                        ModelStateEvent {
                            event_type: "loading_failed".to_string(),
                            model_id: Some(model_id.to_string()),
                            model_name: Some(model_info.name.clone()),
                            error: Some(error_msg.clone()),
                        },
                    );
                    anyhow::anyhow!(error_msg)
                })?;
                LoadedEngine::Whisper(engine)
            }
            EngineType::Parakeet => {
                let error_msg = "Parakeet models temporarily unavailable - use Whisper models";
                let _ = self.app_handle.emit(
                    "model-state-changed",
                    ModelStateEvent {
                        event_type: "loading_failed".to_string(),
                        model_id: Some(model_id.to_string()),
                        model_name: Some(model_info.name.clone()),
                        error: Some(error_msg.to_string()),
                    },
                );
                return Err(anyhow::anyhow!(error_msg));
            }
            EngineType::Moonshine => {
                let error_msg = "Moonshine models no longer supported - use Whisper models";
                let _ = self.app_handle.emit(
                    "model-state-changed",
                    ModelStateEvent {
                        event_type: "loading_failed".to_string(),
                        model_id: Some(model_id.to_string()),
                        model_name: Some(model_info.name.clone()),
                        error: Some(error_msg.to_string()),
                    },
                );
                return Err(anyhow::anyhow!(error_msg));
            }
        };

        // Update the current engine and model ID
        {
            let mut engine = self.engine.lock().unwrap();
            *engine = Some(loaded_engine);
        }
        {
            let mut current_model = self.current_model_id.lock().unwrap();
            *current_model = Some(model_id.to_string());
        }

        // Emit loading completed event
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "loading_completed".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: Some(model_info.name.clone()),
                error: None,
            },
        );

        let load_duration = load_start.elapsed();
        debug!(
            "Successfully loaded transcription model: {} (took {}ms)",
            model_id,
            load_duration.as_millis()
        );
        Ok(())
    }

    /// Kicks off the model loading in a background thread if it's not already loaded
    pub fn initiate_model_load(&self) {
        let mut is_loading = self.is_loading.lock().unwrap();
        if *is_loading || self.is_model_loaded() {
            return;
        }

        *is_loading = true;
        let self_clone = self.clone();
        thread::spawn(move || {
            let settings = get_settings(&self_clone.app_handle);
            if let Err(e) = self_clone.load_model(&settings.selected_model) {
                error!("Failed to load model: {}", e);
            }
            let mut is_loading = self_clone.is_loading.lock().unwrap();
            *is_loading = false;
            self_clone.loading_condvar.notify_all();
        });
    }

    pub fn get_current_model(&self) -> Option<String> {
        let current_model = self.current_model_id.lock().unwrap();
        current_model.clone()
    }

    pub fn transcribe_chunk(&self, audio: Vec<f32>) -> Result<String> {
        info!(
            "transcribe_chunk called with {} samples ({:.2}s)",
            audio.len(),
            audio.len() as f32 / 16000.0
        );

        self.last_activity.store(
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
            Ordering::Relaxed,
        );

        if audio.is_empty() {
            debug!("transcribe_chunk: empty audio, returning empty string");
            return Ok(String::new());
        }

        {
            let mut is_loading = self.is_loading.lock().unwrap();
            if *is_loading {
                debug!("transcribe_chunk: waiting for model to load...");
            }
            while *is_loading {
                is_loading = self.loading_condvar.wait(is_loading).unwrap();
            }

            let engine_guard = self.engine.lock().unwrap();
            if engine_guard.is_none() {
                error!("transcribe_chunk: Model is not loaded!");
                return Err(anyhow::anyhow!(
                    "Model is not loaded for chunk transcription."
                ));
            }
            debug!("transcribe_chunk: model is loaded, proceeding");
        }

        let settings = get_settings(&self.app_handle);

        let result = {
            let engine_guard = self.engine.lock().unwrap();
            let engine = engine_guard
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Model not available for chunk transcription."))?;

            match engine {
                LoadedEngine::Whisper(whisper_engine) => {
                    let whisper_language = if settings.selected_language == "auto" {
                        None
                    } else {
                        let normalized = if settings.selected_language == "zh-Hans"
                            || settings.selected_language == "zh-Hant"
                        {
                            "zh".to_string()
                        } else {
                            settings.selected_language.clone()
                        };
                        Some(normalized)
                    };

                    debug!(
                        "Calling whisper.transcribe: {} samples, lang={:?}, translate={}",
                        audio.len(),
                        whisper_language,
                        settings.translate_to_english
                    );

                    let start = std::time::Instant::now();
                    let result = whisper_engine.transcribe(
                        &audio,
                        whisper_language.as_deref(),
                        settings.translate_to_english,
                        None,
                    )?;
                    info!(
                        "Whisper transcription completed in {:?}: '{}' ({} chars)",
                        start.elapsed(),
                        if result.len() > 80 {
                            &result[..80]
                        } else {
                            &result
                        },
                        result.len()
                    );
                    result
                }
            }
        };

        // Apply word correction if custom words are configured
        let corrected = if !settings.custom_words.is_empty() {
            apply_custom_words(
                &result,
                &settings.custom_words,
                settings.word_correction_threshold,
            )
        } else {
            result
        };

        let text = filter_transcription_output(&corrected);

        if !text.is_empty() {
            debug!("Chunk transcribed: {}", text);
        }

        Ok(text)
    }
}

impl Drop for TranscriptionManager {
    fn drop(&mut self) {
        debug!("Shutting down TranscriptionManager");

        // Signal the watcher thread to shutdown
        self.shutdown_signal.store(true, Ordering::Relaxed);

        // Wait for the thread to finish gracefully
        if let Some(handle) = self.watcher_handle.lock().unwrap().take() {
            if let Err(e) = handle.join() {
                warn!("Failed to join idle watcher thread: {:?}", e);
            } else {
                debug!("Idle watcher thread joined successfully");
            }
        }
    }
}
