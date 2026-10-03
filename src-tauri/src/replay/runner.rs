use anyhow::Result;
use log::info;
use std::path::Path;

use crate::aec::AEC;

use super::engine::ReplayEngine;
use super::types::ReplaySegment;

/// Returns true if the chunk's RMS energy is below a quiet threshold.
fn is_silence(samples: &[f32], threshold: f32) -> bool {
    if samples.is_empty() {
        return true;
    }
    let sum_sq: f32 = samples.iter().map(|x| x * x).sum();
    let rms = (sum_sq / samples.len() as f32).sqrt();
    rms < threshold
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
                    emitted_ms: None,
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
                    emitted_ms: None,
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

/// How audio reaches the live loop.
pub struct LiveTiming {
    /// The loop polls both channels this often.
    pub poll_interval_ms: u64,
    /// Shift of the system-audio stream against the mic. Positive: the far
    /// end leads (the tap started after the mic, so by sample position the
    /// reference comes earlier than its echo). Negative: it lags.
    pub spk_lead_ms: i64,
    /// System audio is delivered in bursts of this length.
    pub spk_burst_ms: u64,
}

/// Replay through `SessionTranscriber`, the pipeline the live app runs.
/// Audio is fed in `poll_interval_ms` ticks as the live loop does.
pub fn run_session_replay(
    config: &crate::audio_toolkit::session_transcriber::TranscriberConfig,
    mic_samples: &[f32],
    spk_samples: &[f32],
    engine: &mut ReplayEngine,
    vad_model_path: &Path,
    timing: &LiveTiming,
) -> Result<(
    Vec<ReplaySegment>,
    crate::audio_toolkit::session_transcriber::TranscriberStats,
)> {
    use crate::audio_toolkit::session_transcriber::SessionTranscriber;

    let mut transcriber = SessionTranscriber::new(config.clone(), vad_model_path)?;
    let per_tick = (timing.poll_interval_ms as usize * 16000) / 1000;
    let shift = (timing.spk_lead_ms.unsigned_abs() as usize * 16000) / 1000;
    let shifted_spk: Vec<f32> = if timing.spk_lead_ms >= 0 {
        spk_samples[shift.min(spk_samples.len())..].to_vec()
    } else {
        let mut v = vec![0.0f32; shift];
        v.extend_from_slice(spk_samples);
        v
    };
    let spk_samples = &shifted_spk[..];
    let burst = ((timing.spk_burst_ms as usize * 16000) / 1000).max(per_tick);
    let total = mic_samples.len().max(spk_samples.len());
    let mut segments = Vec::new();
    let mut spk_sent = 0usize;

    let push = |segs: Vec<crate::audio_toolkit::session_transcriber::Segment>,
                emitted_ms: i64,
                segments: &mut Vec<ReplaySegment>| {
        for s in segs {
            segments.push(ReplaySegment {
                text: s.text,
                source: s.channel.source().to_string(),
                start_ms: s.start_ms,
                end_ms: s.end_ms,
                emitted_ms: Some(emitted_ms),
            });
        }
    };

    let mut offset = 0;
    while offset < total {
        let end = offset + per_tick;
        let mic = &mic_samples[offset.min(mic_samples.len())..end.min(mic_samples.len())];
        // Far-end audio arrives in bursts of `burst` samples.
        let spk_ready = (end / burst * burst).min(spk_samples.len());
        let spk = &spk_samples[spk_sent.min(spk_ready)..spk_ready];
        spk_sent = spk_sent.max(spk_ready);
        let segs = transcriber.push(mic, spk, engine)?;
        push(segs, (end * 1000 / 16000) as i64, &mut segments);
        offset = end;
    }
    if spk_sent < spk_samples.len() {
        let segs = transcriber.push(&[], &spk_samples[spk_sent..], engine)?;
        push(segs, (total * 1000 / 16000) as i64, &mut segments);
    }
    let segs = transcriber.finish(engine)?;
    push(segs, (total * 1000 / 16000) as i64, &mut segments);

    Ok((segments, transcriber.stats.clone()))
}
