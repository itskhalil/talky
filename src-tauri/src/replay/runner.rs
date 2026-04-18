use anyhow::Result;
use log::{debug, info};
use std::path::Path;

use crate::aec::AEC;
use crate::audio_toolkit::pipeline::{ChannelMode, Pipeline};
use crate::audio_toolkit::text::{is_duplicate_segment, remove_prefix_overlap};
use crate::audio_toolkit::vad::SileroVad;

use super::engine::ReplayEngine;
use super::types::{ReplayConfig, ReplaySegment};

/// Returns true if the chunk's RMS energy is below a quiet threshold.
fn is_silence(samples: &[f32], threshold: f32) -> bool {
    if samples.is_empty() {
        return true;
    }
    let sum_sq: f32 = samples.iter().map(|x| x * x).sum();
    let rms = (sum_sq / samples.len() as f32).sqrt();
    rms < threshold
}

pub struct ReplayResult {
    pub segments: Vec<ReplaySegment>,
    pub diagnostics: ReplayDiagnostics,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ReplayDiagnostics {
    pub mic_segments: usize,
    pub spk_segments: usize,
    pub mic_silence_skips: usize,
    pub spk_silence_skips: usize,
    pub mic_dedup_skips: usize,
    pub mic_all_windows_zeroed_skips: usize,
    pub total_ticks: usize,
}

pub fn run_replay(
    config: &ReplayConfig,
    mic_samples: &[f32],
    spk_samples: &[f32],
    mut engine: Option<&mut ReplayEngine>,
    vad_model_path: &Path,
) -> Result<ReplayResult> {
    let dry_run = engine.is_none();

    // Initialize VAD
    let vad: Option<Box<dyn crate::audio_toolkit::VoiceActivityDetector>> =
        match SileroVad::new(vad_model_path, config.vad_threshold) {
            Ok(v) => Some(Box::new(v.with_smoothing(
                config.vad_onset_frames as usize,
                config.vad_hangover_frames as usize,
            ))),
            Err(e) => {
                log::warn!("VAD init failed: {}", e);
                None
            }
        };

    // Initialize AEC
    let aec = if config.aec_enabled {
        match AEC::new() {
            Ok(a) => Some(a),
            Err(e) => {
                log::warn!("AEC init failed: {}", e);
                None
            }
        }
    } else {
        None
    };

    let mut pipeline = Pipeline::new(16000, 16000, vad, aec, ChannelMode::MicAndSpeaker);

    let samples_per_tick = (config.poll_interval_ms as usize * 16000) / 1000;
    let total_samples = mic_samples.len().max(spk_samples.len());
    let total_ticks = total_samples.div_ceil(samples_per_tick);

    let mut segments: Vec<ReplaySegment> = Vec::new();
    let mut pending_spk_samples: Vec<f32> = Vec::new();
    let mut spk_silent_polls: u32 = 0;
    let mut mic_chunk_start_ms: i64 = 0;
    let mut spk_chunk_start_ms: i64 = 0;
    let mut mic_has_samples = false;
    let mut previous_mic_text = String::new();

    let mut diag = ReplayDiagnostics {
        mic_segments: 0,
        spk_segments: 0,
        mic_silence_skips: 0,
        spk_silence_skips: 0,
        mic_dedup_skips: 0,
        mic_all_windows_zeroed_skips: 0,
        total_ticks,
    };

    for tick in 0..total_ticks {
        let offset = tick * samples_per_tick;
        let current_time_ms = tick as i64 * config.poll_interval_ms as i64;

        // Get mic chunk for this tick
        let mic_start = offset.min(mic_samples.len());
        let mic_end = (offset + samples_per_tick).min(mic_samples.len());
        let mic_chunk = &mic_samples[mic_start..mic_end];

        // Get spk chunk for this tick
        let spk_start = offset.min(spk_samples.len());
        let spk_end = (offset + samples_per_tick).min(spk_samples.len());
        let spk_chunk = &spk_samples[spk_start..spk_end];

        // Push mic into pipeline
        if !mic_chunk.is_empty() {
            if !mic_has_samples {
                mic_chunk_start_ms = current_time_ms;
            }
            mic_has_samples = true;
            pipeline.push_mic(mic_chunk);
        }

        // Push spk into pipeline and pending buffer
        if !spk_chunk.is_empty() {
            if pending_spk_samples.is_empty() {
                spk_chunk_start_ms = current_time_ms;
            }
            pipeline.push_spk(spk_chunk);
            pending_spk_samples.extend_from_slice(spk_chunk);

            if is_silence(spk_chunk, config.silence_threshold) {
                spk_silent_polls += 1;
            } else {
                spk_silent_polls = 0;
            }
        } else {
            spk_silent_polls += 1;
        }

        // Poll pipeline
        let pipeline_event = pipeline.poll_event();

        // Check mic transcription trigger
        let accumulated = pipeline.accumulated_mic_len();
        let force_flush = accumulated >= config.max_chunk_samples;
        let vad_trigger =
            accumulated >= config.min_chunk_samples && pipeline_event.mic_speech_ended;
        let mic_should_transcribe = mic_has_samples && (force_flush || vad_trigger);

        if mic_should_transcribe {
            let trigger_reason = if force_flush {
                "15s limit"
            } else {
                "speech ended"
            };
            info!(
                "[{:.1}s] MIC TRANSCRIBE - {:.1}s of audio (reason: {})",
                current_time_ms as f32 / 1000.0,
                accumulated as f32 / 16000.0,
                trigger_reason
            );

            // Pre-flush pending speaker audio for dedup
            if pending_spk_samples.len() >= config.min_chunk_samples / 4 {
                if !is_silence(&pending_spk_samples, config.silence_threshold) {
                    if let Some(ref mut eng) = engine {
                        let spk_audio = std::mem::take(&mut pending_spk_samples);
                        match eng.transcribe(spk_audio) {
                            Ok(text) if !text.is_empty() => {
                                info!("Pre-flushed speaker: '{}'", truncate(&text, 50));
                                segments.push(ReplaySegment {
                                    text,
                                    source: "speaker".to_string(),
                                    start_ms: spk_chunk_start_ms,
                                    end_ms: current_time_ms,
                                });
                                diag.spk_segments += 1;
                            }
                            _ => {}
                        }
                    } else {
                        // dry run — record segment boundary
                        segments.push(ReplaySegment {
                            text: String::new(),
                            source: "speaker".to_string(),
                            start_ms: spk_chunk_start_ms,
                            end_ms: current_time_ms,
                        });
                        diag.spk_segments += 1;
                        pending_spk_samples.clear();
                    }
                } else {
                    pending_spk_samples.clear();
                    diag.spk_silence_skips += 1;
                }
                spk_silent_polls = 0;
                spk_chunk_start_ms = current_time_ms;
            }

            // Apply AEC
            pipeline.apply_aec_to_accumulated();

            // Take mic audio with speaker energy filtering
            let mic_audio = if config.skip_mic_on_speaker_energy {
                let (filtered_mic, windows_zeroed) = pipeline.take_filtered_mic(
                    config.speaker_energy_threshold,
                    config.window_ms,
                    config.overlap_samples,
                );

                let total_windows =
                    (filtered_mic.len().saturating_sub(1) / (config.window_ms * 16) + 1).max(1);
                if windows_zeroed == total_windows && total_windows > 1 {
                    info!(
                        "Skipping mic - all {} windows had speaker activity",
                        total_windows
                    );
                    mic_has_samples = false;
                    mic_chunk_start_ms = current_time_ms;
                    diag.mic_all_windows_zeroed_skips += 1;
                    continue;
                }

                filtered_mic
            } else {
                let (mic, _spk) = pipeline.take_with_overlap(config.overlap_samples);
                mic
            };

            // Silence check
            if is_silence(&mic_audio, config.silence_threshold) {
                info!("Skipping mic - audio is silent");
                mic_has_samples = false;
                mic_chunk_start_ms = current_time_ms;
                diag.mic_silence_skips += 1;
                continue;
            }

            if dry_run {
                // Record segment boundary only
                segments.push(ReplaySegment {
                    text: String::new(),
                    source: "mic".to_string(),
                    start_ms: mic_chunk_start_ms,
                    end_ms: current_time_ms,
                });
                diag.mic_segments += 1;
            } else if let Some(ref mut eng) = engine {
                match eng.transcribe(mic_audio) {
                    Ok(text) if !text.is_empty() => {
                        // Remove prefix overlap
                        let deduped_text = if !previous_mic_text.is_empty() {
                            remove_prefix_overlap(
                                &text,
                                &previous_mic_text,
                                config.prefix_overlap_min_words,
                            )
                        } else {
                            text.clone()
                        };

                        if !deduped_text.is_empty() {
                            // Check dedup against recent speaker segments
                            let is_dup = segments
                                .iter()
                                .filter(|s| {
                                    s.source == "speaker" && s.start_ms > mic_chunk_start_ms - 5000
                                })
                                .any(|seg| {
                                    is_duplicate_segment(
                                        &deduped_text,
                                        mic_chunk_start_ms,
                                        current_time_ms,
                                        &seg.text,
                                        seg.start_ms,
                                        seg.end_ms,
                                        config.dedup_similarity_threshold,
                                        config.dedup_time_overlap_ms,
                                    )
                                });

                            if !is_dup {
                                info!("Mic segment: '{}'", truncate(&deduped_text, 80));
                                segments.push(ReplaySegment {
                                    text: deduped_text.clone(),
                                    source: "mic".to_string(),
                                    start_ms: mic_chunk_start_ms,
                                    end_ms: current_time_ms,
                                });
                                diag.mic_segments += 1;
                                previous_mic_text = text;
                            } else {
                                debug!("Skipping duplicate mic segment");
                                diag.mic_dedup_skips += 1;
                            }
                        }
                    }
                    Ok(_) => {} // empty
                    Err(e) => log::error!("Mic transcription error: {}", e),
                }
            }

            mic_has_samples = false;
            mic_chunk_start_ms = current_time_ms;
        }

        // Check speaker transcription trigger
        let spk_should_transcribe = pending_spk_samples.len() >= config.max_chunk_samples
            || (pending_spk_samples.len() >= config.min_chunk_samples
                && spk_silent_polls >= config.spk_silence_flush_polls);

        if spk_should_transcribe {
            if is_silence(&pending_spk_samples, config.silence_threshold) {
                pending_spk_samples.clear();
                spk_silent_polls = 0;
                diag.spk_silence_skips += 1;
                continue;
            }

            if dry_run {
                segments.push(ReplaySegment {
                    text: String::new(),
                    source: "speaker".to_string(),
                    start_ms: spk_chunk_start_ms,
                    end_ms: current_time_ms,
                });
                diag.spk_segments += 1;
                pending_spk_samples.clear();
            } else if let Some(ref mut eng) = engine {
                match eng.transcribe(std::mem::take(&mut pending_spk_samples)) {
                    Ok(text) if !text.is_empty() => {
                        info!("Speaker segment: '{}'", truncate(&text, 80));
                        segments.push(ReplaySegment {
                            text,
                            source: "speaker".to_string(),
                            start_ms: spk_chunk_start_ms,
                            end_ms: current_time_ms,
                        });
                        diag.spk_segments += 1;
                    }
                    Ok(_) => {}
                    Err(e) => log::error!("Speaker transcription error: {}", e),
                }
            }
            spk_silent_polls = 0;
            spk_chunk_start_ms = current_time_ms;
        }
    }

    // Final flush: remaining speaker audio
    if !pending_spk_samples.is_empty()
        && !is_silence(&pending_spk_samples, config.silence_threshold)
    {
        let end_ms = (total_ticks as i64) * config.poll_interval_ms as i64;
        if dry_run {
            segments.push(ReplaySegment {
                text: String::new(),
                source: "speaker".to_string(),
                start_ms: spk_chunk_start_ms,
                end_ms,
            });
            diag.spk_segments += 1;
        } else if let Some(ref mut eng) = engine {
            match eng.transcribe(std::mem::take(&mut pending_spk_samples)) {
                Ok(text) if !text.is_empty() => {
                    segments.push(ReplaySegment {
                        text,
                        source: "speaker".to_string(),
                        start_ms: spk_chunk_start_ms,
                        end_ms,
                    });
                    diag.spk_segments += 1;
                }
                _ => {}
            }
        }
    }

    // Final flush: remaining mic audio
    pipeline.apply_aec_to_accumulated();
    let (remaining_mic, _remaining_spk) = pipeline.take_all_accumulated();
    if !remaining_mic.is_empty() && !is_silence(&remaining_mic, config.silence_threshold) {
        let end_ms = (total_ticks as i64) * config.poll_interval_ms as i64;
        if dry_run {
            segments.push(ReplaySegment {
                text: String::new(),
                source: "mic".to_string(),
                start_ms: mic_chunk_start_ms,
                end_ms,
            });
            diag.mic_segments += 1;
        } else if let Some(ref mut eng) = engine {
            match eng.transcribe(remaining_mic) {
                Ok(text) if !text.is_empty() => {
                    // Dedup against speaker
                    let is_dup = segments
                        .iter()
                        .filter(|s| s.source == "speaker" && s.start_ms > mic_chunk_start_ms - 5000)
                        .any(|seg| {
                            is_duplicate_segment(
                                &text,
                                mic_chunk_start_ms,
                                end_ms,
                                &seg.text,
                                seg.start_ms,
                                seg.end_ms,
                                config.dedup_similarity_threshold,
                                config.dedup_time_overlap_ms,
                            )
                        });

                    if !is_dup {
                        segments.push(ReplaySegment {
                            text,
                            source: "mic".to_string(),
                            start_ms: mic_chunk_start_ms,
                            end_ms,
                        });
                        diag.mic_segments += 1;
                    }
                }
                _ => {}
            }
        }
    }

    info!(
        "Replay complete: {} mic segments, {} spk segments, {} total",
        diag.mic_segments,
        diag.spk_segments,
        segments.len()
    );

    Ok(ReplayResult {
        segments,
        diagnostics: diag,
    })
}

/// Apply AEC to the mic channel using the speaker channel as reference.
/// Returns a sample-aligned buffer (same length as input mic_samples) so
/// timestamps over the output align with the original recording.
pub fn apply_aec_to_mic(mic_samples: &[f32], spk_samples: &[f32]) -> Result<Vec<f32>> {
    let mut aec = AEC::new().map_err(|e| anyhow::anyhow!("AEC init failed: {}", e))?;
    let mut cleaned = Vec::with_capacity(mic_samples.len());

    let aec_chunk_size = 16000; // 1s chunks for AEC
    for chunk_start in (0..mic_samples.len()).step_by(aec_chunk_size) {
        let chunk_end = (chunk_start + aec_chunk_size).min(mic_samples.len());
        let mic_chunk = &mic_samples[chunk_start..chunk_end];
        let spk_start = chunk_start.min(spk_samples.len());
        let spk_end = chunk_end.min(spk_samples.len());

        if spk_end > spk_start {
            let spk_chunk = &spk_samples[spk_start..spk_end];
            let len = mic_chunk.len().min(spk_chunk.len());
            match aec.process_streaming(&mic_chunk[..len], &spk_chunk[..len]) {
                Ok(aec_result) => cleaned.extend_from_slice(&aec_result),
                Err(_) => cleaned.extend_from_slice(&mic_chunk[..len]),
            }
            if mic_chunk.len() > len {
                cleaned.extend_from_slice(&mic_chunk[len..]);
            }
        } else {
            cleaned.extend_from_slice(mic_chunk);
        }
    }
    Ok(cleaned)
}

/// Transcribe raw audio for golden generation.
/// Applies AEC to mic channel, then transcribes both channels in large chunks.
pub fn transcribe_raw(
    mic_samples: &[f32],
    spk_samples: &[f32],
    engine: &mut ReplayEngine,
    aec_enabled: bool,
    chunk_size: usize,
) -> Result<Vec<ReplaySegment>> {
    use crate::audio_toolkit::preprocessing::AudioPreprocessor;

    let mut segments = Vec::new();

    // Transcribe speaker channel (clean, no AEC needed)
    info!(
        "Transcribing speaker channel ({} samples)...",
        spk_samples.len()
    );
    let mut spk_preprocessor = AudioPreprocessor::new(16000);
    for (i, chunk_start) in (0..spk_samples.len()).step_by(chunk_size).enumerate() {
        let chunk_end = (chunk_start + chunk_size).min(spk_samples.len());
        let mut chunk = spk_samples[chunk_start..chunk_end].to_vec();
        spk_preprocessor.process(&mut chunk);

        if is_silence(&chunk, 0.01) {
            continue;
        }

        let start_ms = (chunk_start as i64 * 1000) / 16000;
        let end_ms = (chunk_end as i64 * 1000) / 16000;

        match engine.transcribe(chunk) {
            Ok(text) if !text.is_empty() => {
                info!("  Speaker chunk {}: '{}'", i, truncate(&text, 80));
                segments.push(ReplaySegment {
                    text,
                    source: "speaker".to_string(),
                    start_ms,
                    end_ms,
                });
            }
            _ => {}
        }
    }

    // Transcribe mic channel (with AEC if enabled)
    info!(
        "Transcribing mic channel ({} samples, aec={})...",
        mic_samples.len(),
        aec_enabled
    );

    let mic_to_transcribe = if aec_enabled {
        apply_aec_to_mic(mic_samples, spk_samples)?
    } else {
        mic_samples.to_vec()
    };

    let mut mic_preprocessor = AudioPreprocessor::new(16000);
    for (i, chunk_start) in (0..mic_to_transcribe.len()).step_by(chunk_size).enumerate() {
        let chunk_end = (chunk_start + chunk_size).min(mic_to_transcribe.len());
        let mut chunk = mic_to_transcribe[chunk_start..chunk_end].to_vec();
        mic_preprocessor.process(&mut chunk);

        if is_silence(&chunk, 0.01) {
            continue;
        }

        let start_ms = (chunk_start as i64 * 1000) / 16000;
        let end_ms = (chunk_end as i64 * 1000) / 16000;

        match engine.transcribe(chunk) {
            Ok(text) if !text.is_empty() => {
                info!("  Mic chunk {}: '{}'", i, truncate(&text, 80));
                segments.push(ReplaySegment {
                    text,
                    source: "mic".to_string(),
                    start_ms,
                    end_ms,
                });
            }
            _ => {}
        }
    }

    // Sort by start_ms
    segments.sort_by_key(|s| s.start_ms);

    Ok(segments)
}

/// Decode any audio file (mp3, m4a, wav, flac, ogg) to 16kHz mono f32 samples.
pub fn decode_audio_file(path: &std::path::Path) -> Result<Vec<f32>> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = std::fs::File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| anyhow::anyhow!("Unsupported audio format: {}", e))?;

    let mut format = probed.format;

    let track = format
        .default_track()
        .ok_or_else(|| anyhow::anyhow!("No audio track found"))?;

    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| anyhow::anyhow!("Unknown sample rate"))?;
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(1);
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| anyhow::anyhow!("Failed to create decoder: {}", e))?;

    let mut all_samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => return Err(anyhow::anyhow!("Error reading packet: {}", e)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(anyhow::anyhow!("Decode error: {}", e)),
        };

        let spec = *decoded.spec();
        let num_frames = decoded.capacity();
        let mut sample_buf = SampleBuffer::<f32>::new(num_frames as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);

        let samples = sample_buf.samples();
        if channels > 1 {
            // Downmix to mono by averaging channels
            for frame in samples.chunks(channels) {
                let mono: f32 = frame.iter().sum::<f32>() / channels as f32;
                all_samples.push(mono);
            }
        } else {
            all_samples.extend_from_slice(samples);
        }
    }

    // Resample to 16kHz if needed
    if sample_rate != 16000 {
        info!(
            "Resampling from {}Hz to 16000Hz ({} samples)",
            sample_rate,
            all_samples.len()
        );
        all_samples = resample(&all_samples, sample_rate, 16000)?;
    }

    info!(
        "Decoded {}: {:.1}s, {}Hz {}ch → {} samples at 16kHz",
        path.display(),
        all_samples.len() as f64 / 16000.0,
        sample_rate,
        channels,
        all_samples.len()
    );

    Ok(all_samples)
}

/// Resample audio using linear interpolation.
fn resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Result<Vec<f32>> {
    if from_rate == to_rate {
        return Ok(samples.to_vec());
    }

    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = (samples.len() as f64 * ratio).ceil() as usize;
    let mut output = Vec::with_capacity(out_len);

    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos as usize;
        let frac = src_pos - idx as f64;

        let sample = if idx + 1 < samples.len() {
            samples[idx] as f64 * (1.0 - frac) + samples[idx + 1] as f64 * frac
        } else if idx < samples.len() {
            samples[idx] as f64
        } else {
            0.0
        };

        output.push(sample as f32);
    }

    Ok(output)
}

/// Transcribe a single audio file, returning the full text.
/// Unlike transcribe_raw, this skips preprocessing since the input is
/// already a mastered/encoded audio file, not raw mic capture.
pub fn transcribe_file(
    samples: &[f32],
    engine: &mut ReplayEngine,
    chunk_size: usize,
) -> Result<String> {
    let mut texts = Vec::new();

    for (i, chunk_start) in (0..samples.len()).step_by(chunk_size).enumerate() {
        let chunk_end = (chunk_start + chunk_size).min(samples.len());
        let chunk = samples[chunk_start..chunk_end].to_vec();

        match engine.transcribe(chunk) {
            Ok(text) if !text.is_empty() => {
                info!("  Chunk {}: '{}'", i, truncate(&text, 80));
                texts.push(text);
            }
            _ => {}
        }
    }

    Ok(texts.join(" "))
}

fn truncate(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        s
    } else {
        &s[..s.floor_char_boundary(max_len)]
    }
}
