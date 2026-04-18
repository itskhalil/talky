use crate::settings::{get_settings, write_settings};
use crate::utils::MutexExt;
use anyhow::Result;
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tar::Archive;
use tauri::{AppHandle, Emitter, Manager};

pub const ONNX_MODEL_ID: &str = "parakeet-tdt-0.6b-v3";
pub const CORE_ML_MODEL_ID: &str = "parakeet-tdt-0.6b-v3-coreml";

/// Recursively sum the on-disk byte size of `path`. Used for polling
/// FluidAudio's cache dir to derive Core ML download progress. Returns 0 if
/// the dir doesn't exist (download hasn't started) or on any I/O error.
fn dir_size_bytes(path: &Path) -> u64 {
    fn walk(p: &Path) -> u64 {
        let Ok(meta) = std::fs::symlink_metadata(p) else {
            return 0;
        };
        if meta.is_file() {
            return meta.len();
        }
        if meta.is_dir() {
            let Ok(entries) = std::fs::read_dir(p) else {
                return 0;
            };
            let mut sum = 0u64;
            for entry in entries.flatten() {
                sum = sum.saturating_add(walk(&entry.path()));
            }
            return sum;
        }
        0
    }
    walk(path)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum EngineType {
    Parakeet,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub filename: String,
    pub url: Option<String>,
    pub size_mb: u64,
    pub is_downloaded: bool,
    pub is_downloading: bool,
    pub partial_size: u64,
    pub is_directory: bool,
    pub engine_type: EngineType,
    pub accuracy_score: f32, // 0.0 to 1.0, higher is more accurate
    pub speed_score: f32,    // 0.0 to 1.0, higher is faster
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DownloadProgress {
    pub model_id: String,
    pub downloaded: u64,
    pub total: u64,
    pub percentage: f64,
}

pub struct ModelManager {
    app_handle: AppHandle,
    models_dir: PathBuf,
    available_models: Mutex<HashMap<String, ModelInfo>>,
}

impl ModelManager {
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        // Create models directory in app data
        let models_dir = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| anyhow::anyhow!("Failed to get app data dir: {}", e))?
            .join("models");

        info!("ModelManager: models_dir = {:?}", models_dir);
        info!("ModelManager: models_dir exists = {}", models_dir.exists());

        // Log directory contents for debugging (helps diagnose onboarding issues)
        if models_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&models_dir) {
                for entry in entries.flatten() {
                    info!("ModelManager: found entry: {:?}", entry.path());
                }
            }
        }

        if !models_dir.exists() {
            fs::create_dir_all(&models_dir)?;
        }

        let mut available_models = HashMap::new();

        available_models.insert(
            ONNX_MODEL_ID.to_string(),
            ModelInfo {
                id: ONNX_MODEL_ID.to_string(),
                name: "Parakeet V3".to_string(),
                description: "Fast and accurate".to_string(),
                filename: "parakeet-tdt-0.6b-v3-int8".to_string(), // Directory name
                url: Some("https://blob.handy.computer/parakeet-v3-int8.tar.gz".to_string()),
                size_mb: 478, // Approximate size for int8 quantized model
                is_downloaded: false,
                is_downloading: false,
                partial_size: 0,
                is_directory: true,
                engine_type: EngineType::Parakeet,
                accuracy_score: 0.80,
                speed_score: 0.85,
            },
        );

        // Core ML sibling of Parakeet v3. Storage lives in FluidAudio's cache
        // dir (~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3/),
        // not Talky's models dir. download/is_downloaded/delete/get_model_path
        // all branch on the `-coreml` id suffix.
        #[cfg(target_os = "macos")]
        available_models.insert(
            CORE_ML_MODEL_ID.to_string(),
            ModelInfo {
                id: CORE_ML_MODEL_ID.to_string(),
                name: "Parakeet V3 — Accelerated".to_string(),
                description: "Very fast and accurate".to_string(),
                filename: ONNX_MODEL_ID.to_string(), // FluidAudio cache subdir
                url: None,
                size_mb: 469,
                is_downloaded: false,
                is_downloading: false,
                partial_size: 0,
                is_directory: true,
                engine_type: EngineType::Parakeet,
                accuracy_score: 0.80,
                speed_score: 1.0,
            },
        );

        let manager = Self {
            app_handle: app_handle.clone(),
            models_dir,
            available_models: Mutex::new(available_models),
        };

        // Migrate any bundled models to user directory
        manager.migrate_bundled_models()?;

        // Check which models are already downloaded
        manager.update_download_status()?;

        // Auto-select a model if none is currently selected
        manager.auto_select_model_if_needed()?;

        Ok(manager)
    }

    pub fn get_available_models(&self) -> Vec<ModelInfo> {
        let models = self.available_models.lock_or_recover();
        models.values().cloned().collect()
    }

    pub fn get_model_info(&self, model_id: &str) -> Option<ModelInfo> {
        let models = self.available_models.lock_or_recover();
        models.get(model_id).cloned()
    }

    fn migrate_bundled_models(&self) -> Result<()> {
        // Check for bundled models and copy them to user directory
        let bundled_models: [&str; 0] = []; // No bundled models currently

        for filename in &bundled_models {
            let bundled_path = self.app_handle.path().resolve(
                format!("resources/models/{}", filename),
                tauri::path::BaseDirectory::Resource,
            );

            if let Ok(bundled_path) = bundled_path {
                if bundled_path.exists() {
                    let user_path = self.models_dir.join(filename);

                    // Only copy if user doesn't already have the model
                    if !user_path.exists() {
                        info!("Migrating bundled model {} to user directory", filename);
                        fs::copy(&bundled_path, &user_path)?;
                        info!("Successfully migrated {}", filename);
                    }
                }
            }
        }

        Ok(())
    }

    /// FluidAudio cache dir for a Core ML model — must match the sidecar's
    /// hardcoded cache location.
    #[cfg(target_os = "macos")]
    fn coreml_cache_path(model_filename: &str) -> Option<PathBuf> {
        let base = std::env::var_os("HOME").map(PathBuf::from)?;
        Some(
            base.join("Library/Application Support/FluidAudio/Models")
                .join(model_filename),
        )
    }

    /// Fast probe: the cache is considered populated when the four expected
    /// `.mlmodelc` bundles exist. Cheap enough to run on every
    /// `update_download_status`.
    #[cfg(target_os = "macos")]
    fn coreml_is_downloaded(model_filename: &str) -> bool {
        let Some(dir) = Self::coreml_cache_path(model_filename) else {
            return false;
        };
        let required = [
            "Encoder.mlmodelc",
            "Preprocessor.mlmodelc",
            "Decoder.mlmodelc",
            "JointDecision.mlmodelc",
        ];
        required.iter().all(|name| dir.join(name).exists())
    }

    fn update_download_status(&self) -> Result<()> {
        let mut models = self.available_models.lock_or_recover();

        for model in models.values_mut() {
            // Core ML entry lives in the FluidAudio cache, not Talky's dir.
            #[cfg(target_os = "macos")]
            if model.id.ends_with("-coreml") {
                model.is_downloaded = Self::coreml_is_downloaded(&model.filename);
                model.is_downloading = false;
                model.partial_size = 0;
                continue;
            }
            if model.is_directory {
                // For directory-based models, check if the directory exists
                let model_path = self.models_dir.join(&model.filename);
                let partial_path = self.models_dir.join(format!("{}.partial", &model.filename));
                let extracting_path = self
                    .models_dir
                    .join(format!("{}.extracting", &model.filename));

                // Clean up any leftover .extracting directories from interrupted extractions
                if extracting_path.exists() {
                    warn!("Cleaning up interrupted extraction for model: {}", model.id);
                    let _ = fs::remove_dir_all(&extracting_path);
                }

                let exists = model_path.exists();
                let is_dir = exists && model_path.is_dir();
                model.is_downloaded = is_dir;
                model.is_downloading = false;

                // Log model check for debugging onboarding issues
                info!(
                    "ModelManager: checking model '{}': path={:?}, exists={}, is_dir={}, is_downloaded={}",
                    model.id, model_path, exists, is_dir, model.is_downloaded
                );

                // Get partial file size if it exists (for the .tar.gz being downloaded)
                if partial_path.exists() {
                    model.partial_size = partial_path.metadata().map(|m| m.len()).unwrap_or(0);
                } else {
                    model.partial_size = 0;
                }
            } else {
                // For file-based models (existing logic)
                let model_path = self.models_dir.join(&model.filename);
                let partial_path = self.models_dir.join(format!("{}.partial", &model.filename));

                model.is_downloaded = model_path.exists();
                model.is_downloading = false;

                // Get partial file size if it exists
                if partial_path.exists() {
                    model.partial_size = partial_path.metadata().map(|m| m.len()).unwrap_or(0);
                } else {
                    model.partial_size = 0;
                }
            }
        }

        Ok(())
    }

    fn auto_select_model_if_needed(&self) -> Result<()> {
        // Check if we have a selected model in settings
        let settings = get_settings(&self.app_handle);

        // If no model is selected or selected model is empty
        if settings.selected_model.is_empty() {
            // Find the first available (downloaded) model
            let models = self.available_models.lock_or_recover();
            if let Some(available_model) = models.values().find(|model| model.is_downloaded) {
                info!(
                    "Auto-selecting model: {} ({})",
                    available_model.id, available_model.name
                );

                // Update settings with the selected model
                let mut updated_settings = settings;
                updated_settings.selected_model = available_model.id.clone();
                write_settings(&self.app_handle, updated_settings);

                info!("Successfully auto-selected model: {}", available_model.id);
            }
        }

        Ok(())
    }

    pub async fn download_model(&self, model_id: &str) -> Result<()> {
        let model_info = {
            let models = self.available_models.lock_or_recover();
            models.get(model_id).cloned()
        };

        let model_info =
            model_info.ok_or_else(|| anyhow::anyhow!("Model not found: {}", model_id))?;

        // Core ML entries don't have a URL — they're pulled by the sidecar
        // from Hugging Face via FluidAudio. Route through the sidecar while
        // emitting the standard `model-download-progress` event.
        #[cfg(target_os = "macos")]
        if model_id.ends_with("-coreml") {
            return self.download_coreml_model(&model_info).await;
        }

        let url = model_info
            .url
            .ok_or_else(|| anyhow::anyhow!("No download URL for model"))?;
        let model_path = self.models_dir.join(&model_info.filename);
        let partial_path = self
            .models_dir
            .join(format!("{}.partial", &model_info.filename));

        // Don't download if complete version already exists
        if model_path.exists() {
            // Clean up any partial file that might exist
            if partial_path.exists() {
                let _ = fs::remove_file(&partial_path);
            }
            self.update_download_status()?;
            return Ok(());
        }

        // Check if we have a partial download to resume
        let mut resume_from = if partial_path.exists() {
            let size = partial_path.metadata()?.len();
            info!("Resuming download of model {} from byte {}", model_id, size);
            size
        } else {
            info!("Starting fresh download of model {} from {}", model_id, url);
            0
        };

        // Mark as downloading
        {
            let mut models = self.available_models.lock_or_recover();
            if let Some(model) = models.get_mut(model_id) {
                model.is_downloading = true;
            }
        }

        // Create HTTP client with range request for resuming
        let client = reqwest::Client::new();
        let mut request = client.get(&url);

        if resume_from > 0 {
            request = request.header("Range", format!("bytes={}-", resume_from));
        }

        let mut response = request.send().await?;

        // If we tried to resume but server returned 200 (not 206 Partial Content),
        // the server doesn't support range requests. Delete partial file and restart
        // fresh to avoid file corruption (appending full file to partial).
        // Also handle 416 Range Not Satisfiable - partial file is larger than server file.
        if resume_from > 0
            && (response.status() == reqwest::StatusCode::OK
                || response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE)
        {
            warn!(
                "Range request failed for model {} (status {}), restarting download",
                model_id,
                response.status()
            );
            drop(response);
            let _ = fs::remove_file(&partial_path);

            // Reset resume_from since we're starting fresh
            resume_from = 0;

            // Restart download without range header
            response = client.get(&url).send().await?;
        }

        // Check for success or partial content status
        if !response.status().is_success()
            && response.status() != reqwest::StatusCode::PARTIAL_CONTENT
        {
            // Mark as not downloading on error
            {
                let mut models = self.available_models.lock_or_recover();
                if let Some(model) = models.get_mut(model_id) {
                    model.is_downloading = false;
                }
            }
            return Err(anyhow::anyhow!(
                "Failed to download model: HTTP {}",
                response.status()
            ));
        }

        let total_size = if resume_from > 0 {
            // For resumed downloads, add the resume point to content length
            resume_from + response.content_length().unwrap_or(0)
        } else {
            response.content_length().unwrap_or(0)
        };

        let mut downloaded = resume_from;
        let mut stream = response.bytes_stream();

        // Open file for appending if resuming, or create new if starting fresh
        let mut file = if resume_from > 0 {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&partial_path)?
        } else {
            std::fs::File::create(&partial_path)?
        };

        // Emit initial progress
        let initial_progress = DownloadProgress {
            model_id: model_id.to_string(),
            downloaded,
            total: total_size,
            percentage: if total_size > 0 {
                (downloaded as f64 / total_size as f64) * 100.0
            } else {
                0.0
            },
        };
        let _ = self
            .app_handle
            .emit("model-download-progress", &initial_progress);

        // Download with progress (throttled to avoid UI flooding)
        let mut last_progress_time = std::time::Instant::now();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.inspect_err(|_e| {
                // Mark as not downloading on error
                let mut models = self.available_models.lock_or_recover();
                if let Some(model) = models.get_mut(model_id) {
                    model.is_downloading = false;
                }
            })?;

            file.write_all(&chunk)?;
            downloaded += chunk.len() as u64;

            // Throttle progress events to emit at most once per 100ms
            // This prevents overwhelming the UI with ~60,000 events for large files
            let should_emit =
                last_progress_time.elapsed().as_millis() >= 100 || downloaded == total_size;

            if should_emit {
                let percentage = if total_size > 0 {
                    (downloaded as f64 / total_size as f64) * 100.0
                } else {
                    0.0
                };

                let progress = DownloadProgress {
                    model_id: model_id.to_string(),
                    downloaded,
                    total: total_size,
                    percentage,
                };

                let _ = self.app_handle.emit("model-download-progress", &progress);
                last_progress_time = std::time::Instant::now();
            }
        }

        file.flush()?;
        drop(file); // Ensure file is closed before moving

        // Verify downloaded file size matches expected size
        if total_size > 0 {
            let actual_size = partial_path.metadata()?.len();
            if actual_size != total_size {
                // Download is incomplete/corrupted - delete partial and return error
                let _ = fs::remove_file(&partial_path);
                {
                    let mut models = self.available_models.lock_or_recover();
                    if let Some(model) = models.get_mut(model_id) {
                        model.is_downloading = false;
                    }
                }
                return Err(anyhow::anyhow!(
                    "Download incomplete: expected {} bytes, got {} bytes",
                    total_size,
                    actual_size
                ));
            }
        }

        // Handle directory-based models (extract tar.gz) vs file-based models
        if model_info.is_directory {
            // Emit extraction started event
            let _ = self.app_handle.emit("model-extraction-started", model_id);
            info!("Extracting archive for directory-based model: {}", model_id);

            // Use a temporary extraction directory to ensure atomic operations
            let temp_extract_dir = self
                .models_dir
                .join(format!("{}.extracting", &model_info.filename));
            let final_model_dir = self.models_dir.join(&model_info.filename);

            // Clean up any previous incomplete extraction
            if temp_extract_dir.exists() {
                let _ = fs::remove_dir_all(&temp_extract_dir);
            }

            // Create temporary extraction directory
            fs::create_dir_all(&temp_extract_dir)?;

            // Open the downloaded tar.gz file
            let tar_gz = File::open(&partial_path)?;
            let tar = GzDecoder::new(tar_gz);
            let mut archive = Archive::new(tar);

            // Extract to the temporary directory first
            archive.unpack(&temp_extract_dir).map_err(|e| {
                let error_msg = format!("Failed to extract archive: {}", e);
                // Clean up failed extraction
                let _ = fs::remove_dir_all(&temp_extract_dir);
                let _ = self.app_handle.emit(
                    "model-extraction-failed",
                    &serde_json::json!({
                        "model_id": model_id,
                        "error": error_msg
                    }),
                );
                anyhow::anyhow!(error_msg)
            })?;

            // Find the actual extracted directory (archive might have a nested structure)
            let extracted_dirs: Vec<_> = fs::read_dir(&temp_extract_dir)?
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
                .collect();

            if extracted_dirs.len() == 1 {
                // Single directory extracted, move it to the final location
                let source_dir = extracted_dirs[0].path();
                if final_model_dir.exists() {
                    fs::remove_dir_all(&final_model_dir)?;
                }
                fs::rename(&source_dir, &final_model_dir)?;
                // Clean up temp directory
                let _ = fs::remove_dir_all(&temp_extract_dir);
            } else {
                // Multiple items or no directories, rename the temp directory itself
                if final_model_dir.exists() {
                    fs::remove_dir_all(&final_model_dir)?;
                }
                fs::rename(&temp_extract_dir, &final_model_dir)?;
            }

            info!("Successfully extracted archive for model: {}", model_id);
            // Emit extraction completed event
            let _ = self.app_handle.emit("model-extraction-completed", model_id);

            // Remove the downloaded tar.gz file
            let _ = fs::remove_file(&partial_path);
        } else {
            // Move partial file to final location for file-based models
            fs::rename(&partial_path, &model_path)?;
        }

        // Update download status
        {
            let mut models = self.available_models.lock_or_recover();
            if let Some(model) = models.get_mut(model_id) {
                model.is_downloading = false;
                model.is_downloaded = true;
                model.partial_size = 0;
            }
        }

        // Emit completion event
        let _ = self.app_handle.emit("model-download-complete", model_id);

        info!(
            "Successfully downloaded model {} to {:?}",
            model_id, model_path
        );

        Ok(())
    }

    /// Drive the sidecar's `load_streaming` as a one-shot download. Progress
    /// is driven by a Rust-side polling task that measures the FluidAudio
    /// cache directory size every 500ms and emits `model-download-progress`.
    /// We don't rely on FluidAudio's own progressHandler: empirically, its
    /// ticks don't make it through the Swift→Rust bridge (logged zero ticks
    /// across 25s+ downloads). Cache-size polling is independent of that and
    /// gives smooth progress regardless.
    ///
    /// The continuous emission (every 500ms) also sidesteps the listener-
    /// timing problem — subscribers that mount partway through the download
    /// pick up the next tick within a half-second.
    #[cfg(target_os = "macos")]
    async fn download_coreml_model(&self, model_info: &ModelInfo) -> Result<()> {
        use crate::managers::coreml_asr::{find_sidecar_binary, CoreMlAsr, CoreMlDownloadProgress};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;

        // Already populated: nothing to do.
        if Self::coreml_is_downloaded(&model_info.filename) {
            self.update_download_status()?;
            return Ok(());
        }

        {
            let mut models = self.available_models.lock_or_recover();
            if let Some(m) = models.get_mut(&model_info.id) {
                m.is_downloading = true;
            }
        }

        let app_handle = self.app_handle.clone();
        let model_id_owned = model_info.id.clone();
        let total_bytes = model_info.size_mb.saturating_mul(1024 * 1024);
        let cache_path =
            Self::coreml_cache_path(&model_info.filename).ok_or_else(|| anyhow::anyhow!("$HOME unavailable"))?;

        // Primary signal: FluidAudio's progressHandler, invoked per HTTP
        // chunk during download (0-50% of the fraction range) and once per
        // model during compilation (50-100%). Byte-accurate when it's
        // firing.
        //
        // Safety net: a low-frequency disk poller (every 2s). If the Swift→
        // Rust bridge drops ticks, or FluidAudio goes quiet during the gap
        // between downloading and compiling, at least the bar creeps up
        // based on cache-dir size. We only emit from the poller if the
        // disk-derived percentage exceeds the last FluidAudio-reported
        // percentage — never regress.
        use std::sync::atomic::AtomicU64;
        let last_fluid_pct = Arc::new(AtomicU64::new(0));
        let poller_done = Arc::new(AtomicBool::new(false));
        let poller_done_clone = poller_done.clone();
        let last_fluid_pct_for_poll = last_fluid_pct.clone();
        let app_for_poll = app_handle.clone();
        let model_id_for_poll = model_id_owned.clone();
        let cache_path_for_poll = cache_path.clone();
        let poller = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(2000)).await;
                if poller_done_clone.load(Ordering::Acquire) {
                    break;
                }
                let downloaded = dir_size_bytes(&cache_path_for_poll);
                let disk_pct = if total_bytes > 0 {
                    ((downloaded as f64 / total_bytes as f64) * 100.0).clamp(0.0, 99.0)
                } else {
                    0.0
                };
                // `last_fluid_pct` stores percentage * 100 as u64 for atomic
                // integer ordering. 99.5% is 9950.
                let last = last_fluid_pct_for_poll.load(Ordering::Acquire) as f64 / 100.0;
                if disk_pct <= last {
                    continue;
                }
                let _ = app_for_poll.emit(
                    "model-download-progress",
                    DownloadProgress {
                        model_id: model_id_for_poll.clone(),
                        downloaded,
                        total: total_bytes,
                        percentage: disk_pct,
                    },
                );
            }
        });

        let app_for_blocking = app_handle.clone();
        let model_id_for_blocking = model_id_owned.clone();
        let last_fluid_pct_for_blocking = last_fluid_pct.clone();
        let result = tokio::task::spawn_blocking(move || -> Result<()> {
            let bin = find_sidecar_binary()?;
            let mut asr = CoreMlAsr::spawn(&bin, None)?;
            asr.load_streaming("v3", |p: CoreMlDownloadProgress| {
                log::debug!(
                    "[coreml-download] fluid tick: fraction={:.3} phase={} files={:?}/{:?}",
                    p.fraction,
                    p.phase,
                    p.completed_files,
                    p.total_files
                );
                let percentage = (p.fraction * 100.0).clamp(0.0, 99.0);
                last_fluid_pct_for_blocking
                    .store((percentage * 100.0) as u64, Ordering::Release);
                let downloaded = ((p.fraction.clamp(0.0, 1.0)) * total_bytes as f64) as u64;
                let _ = app_for_blocking.emit(
                    "model-download-progress",
                    DownloadProgress {
                        model_id: model_id_for_blocking.clone(),
                        downloaded,
                        total: total_bytes,
                        percentage,
                    },
                );
            })?;
            Ok(())
        })
        .await
        .map_err(|e| anyhow::anyhow!("coreml download task join: {}", e))?;

        poller_done.store(true, Ordering::Release);
        let _ = poller.await;

        {
            let mut models = self.available_models.lock_or_recover();
            if let Some(m) = models.get_mut(&model_info.id) {
                m.is_downloading = false;
            }
        }

        result?;

        // Mark coreml_model_ready so the migration-promotion check can fire on
        // next launch without re-probing the FluidAudio cache.
        let mut settings = get_settings(&self.app_handle);
        settings.coreml_model_ready = true;
        write_settings(&self.app_handle, settings);

        self.update_download_status()?;

        // Final 100% emit, then the complete event.
        let _ = app_handle.emit(
            "model-download-progress",
            DownloadProgress {
                model_id: model_id_owned.clone(),
                downloaded: total_bytes,
                total: total_bytes,
                percentage: 100.0,
            },
        );
        let _ = app_handle.emit("model-download-complete", &model_info.id);
        log::info!("[coreml-download] complete: {}", model_info.id);

        Ok(())
    }

    pub fn delete_model(&self, model_id: &str) -> Result<()> {
        debug!("ModelManager: delete_model called for: {}", model_id);

        let model_info = {
            let models = self.available_models.lock_or_recover();
            models.get(model_id).cloned()
        };

        let model_info =
            model_info.ok_or_else(|| anyhow::anyhow!("Model not found: {}", model_id))?;

        debug!("ModelManager: Found model info: {:?}", model_info);

        // Core ML: wipe the FluidAudio cache subdir.
        #[cfg(target_os = "macos")]
        if model_id.ends_with("-coreml") {
            if let Some(cache) = Self::coreml_cache_path(&model_info.filename) {
                if cache.exists() {
                    info!("Deleting Core ML cache at: {:?}", cache);
                    fs::remove_dir_all(&cache)?;
                }
            }
            let mut settings = get_settings(&self.app_handle);
            settings.coreml_model_ready = false;
            write_settings(&self.app_handle, settings);
            self.update_download_status()?;
            return Ok(());
        }

        let model_path = self.models_dir.join(&model_info.filename);
        let partial_path = self
            .models_dir
            .join(format!("{}.partial", &model_info.filename));
        debug!("ModelManager: Model path: {:?}", model_path);
        debug!("ModelManager: Partial path: {:?}", partial_path);

        let mut deleted_something = false;

        if model_info.is_directory {
            // Delete complete model directory if it exists
            if model_path.exists() && model_path.is_dir() {
                info!("Deleting model directory at: {:?}", model_path);
                fs::remove_dir_all(&model_path)?;
                info!("Model directory deleted successfully");
                deleted_something = true;
            }
        } else {
            // Delete complete model file if it exists
            if model_path.exists() {
                info!("Deleting model file at: {:?}", model_path);
                fs::remove_file(&model_path)?;
                info!("Model file deleted successfully");
                deleted_something = true;
            }
        }

        // Delete partial file if it exists (same for both types)
        if partial_path.exists() {
            info!("Deleting partial file at: {:?}", partial_path);
            fs::remove_file(&partial_path)?;
            info!("Partial file deleted successfully");
            deleted_something = true;
        }

        if !deleted_something {
            return Err(anyhow::anyhow!("No model files found to delete"));
        }

        // Update download status
        self.update_download_status()?;
        debug!("ModelManager: download status updated");

        Ok(())
    }

    pub fn get_model_path(&self, model_id: &str) -> Result<PathBuf> {
        let model_info = self
            .get_model_info(model_id)
            .ok_or_else(|| anyhow::anyhow!("Model not found: {}", model_id))?;

        // Core ML lives in the FluidAudio cache, not Talky's models dir.
        // The sidecar path uses its own internal probe; this method exists
        // mostly for symmetry with the other entries.
        #[cfg(target_os = "macos")]
        if model_id.ends_with("-coreml") {
            let cache = Self::coreml_cache_path(&model_info.filename)
                .ok_or_else(|| anyhow::anyhow!("$HOME unavailable"))?;
            if !cache.exists() {
                return Err(anyhow::anyhow!("Core ML cache not populated"));
            }
            return Ok(cache);
        }

        if !model_info.is_downloaded {
            return Err(anyhow::anyhow!("Model not available: {}", model_id));
        }

        // Ensure we don't return partial files/directories
        if model_info.is_downloading {
            return Err(anyhow::anyhow!(
                "Model is currently downloading: {}",
                model_id
            ));
        }

        let model_path = self.models_dir.join(&model_info.filename);
        let partial_path = self
            .models_dir
            .join(format!("{}.partial", &model_info.filename));

        if model_info.is_directory {
            // For directory-based models, ensure the directory exists and is complete
            if model_path.exists() && model_path.is_dir() && !partial_path.exists() {
                Ok(model_path)
            } else {
                Err(anyhow::anyhow!(
                    "Complete model directory not found: {}",
                    model_id
                ))
            }
        } else {
            // For file-based models (existing logic)
            if model_path.exists() && !partial_path.exists() {
                Ok(model_path)
            } else {
                Err(anyhow::anyhow!(
                    "Complete model file not found: {}",
                    model_id
                ))
            }
        }
    }

    pub fn cancel_download(&self, model_id: &str) -> Result<()> {
        debug!("ModelManager: cancel_download called for: {}", model_id);

        let _model_info = {
            let models = self.available_models.lock_or_recover();
            models.get(model_id).cloned()
        };

        let _model_info =
            _model_info.ok_or_else(|| anyhow::anyhow!("Model not found: {}", model_id))?;

        // Mark as not downloading
        {
            let mut models = self.available_models.lock_or_recover();
            if let Some(model) = models.get_mut(model_id) {
                model.is_downloading = false;
            }
        }

        // Note: The actual download cancellation would need to be handled
        // by the download task itself. This just updates the state.
        // The partial file is kept so the download can be resumed later.

        // Update download status to reflect current state
        self.update_download_status()?;

        info!("Download cancelled for: {}", model_id);
        Ok(())
    }
}
