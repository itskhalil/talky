use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

use talky_app_lib::replay::{
    engine::ReplayEngine,
    recording::DebugRecording,
    runner::{apply_aec_to_mic, decode_audio_file, run_replay, transcribe_file, transcribe_raw},
    scoring::{format_score_table, score},
    sweep::{run_sweep, SweepConfig},
    types::ReplayConfig,
};

#[derive(Parser)]
#[command(name = "replay", about = "Replay debug recordings through the audio pipeline")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate golden transcript draft by transcribing each channel independently
    TranscribeRaw {
        /// Path to debug recording directory
        #[arg(short, long)]
        recording: PathBuf,

        /// Path to transcription model
        #[arg(short, long)]
        model: PathBuf,

        /// Model engine type: "whisper" or "parakeet"
        #[arg(short, long, default_value = "parakeet")]
        engine: String,

        /// Chunk size in samples for transcription (default: 480000 = 30s)
        #[arg(long, default_value = "480000")]
        chunk_size: usize,

        /// Disable AEC for mic channel
        #[arg(long)]
        no_aec: bool,

        /// Output file path (default: <recording>/golden_draft.json)
        #[arg(short, long)]
        output: Option<PathBuf>,
    },

    /// Replay a single recording through the pipeline
    Run {
        /// Path to debug recording directory
        #[arg(short, long)]
        recording: PathBuf,

        /// Path to transcription model
        #[arg(short, long)]
        model: Option<PathBuf>,

        /// Model engine type: "whisper" or "parakeet"
        #[arg(short, long, default_value = "parakeet")]
        engine: String,

        /// Path to silero_vad_v4.onnx
        #[arg(long)]
        vad_model: PathBuf,

        /// Compare against golden.json
        #[arg(long)]
        compare: bool,

        /// Skip transcription, output segment boundaries only
        #[arg(long)]
        dry_run: bool,

        /// Output file path (default: <recording>/replay_output.json)
        #[arg(short, long)]
        output: Option<PathBuf>,

        // Parameter overrides
        #[arg(long)]
        vad_threshold: Option<f32>,
        #[arg(long)]
        vad_onset_frames: Option<u32>,
        #[arg(long)]
        vad_hangover_frames: Option<u32>,
        #[arg(long)]
        speaker_energy_threshold: Option<f32>,
        #[arg(long)]
        skip_mic_on_speaker_energy: Option<bool>,
        #[arg(long)]
        dedup_similarity: Option<f64>,
        #[arg(long)]
        dedup_time_overlap_ms: Option<i64>,
        #[arg(long)]
        min_chunk_samples: Option<usize>,
        #[arg(long)]
        max_chunk_samples: Option<usize>,
        #[arg(long)]
        overlap_samples: Option<usize>,
        #[arg(long)]
        aec_enabled: Option<bool>,
        #[arg(long)]
        window_ms: Option<usize>,
        #[arg(long)]
        hpf_cutoff: Option<f32>,
        #[arg(long)]
        target_rms: Option<f32>,
        #[arg(long)]
        silence_threshold: Option<f32>,
        #[arg(long)]
        poll_interval_ms: Option<u64>,
        #[arg(long)]
        spk_silence_flush_polls: Option<u32>,
        #[arg(long)]
        prefix_overlap_min_words: Option<usize>,
    },

    /// Transcribe any audio file (mp3, m4a, wav, flac, ogg)
    Transcribe {
        /// Path to audio file
        #[arg(short, long)]
        input: PathBuf,

        /// Path to transcription model (default: ~/Library/Application Support/com.khalil.talky/models/parakeet-tdt-0.6b-v3-int8)
        #[arg(short, long)]
        model: Option<PathBuf>,

        /// Model engine type: "whisper" or "parakeet"
        #[arg(short, long, default_value = "parakeet")]
        engine: String,

        /// Chunk size in samples for transcription (default: 480000 = 30s)
        #[arg(long, default_value = "480000")]
        chunk_size: usize,

        /// Output file path (default: <input_dir>/<input_stem>.txt)
        #[arg(short, long)]
        output: Option<PathBuf>,
    },

    /// Apply AEC to the mic channel and write it as a WAV file (timestamps align with original)
    AecMic {
        /// Path to debug recording directory
        #[arg(short, long)]
        recording: PathBuf,

        /// Output WAV file path (default: <recording>/mic_aec.wav)
        #[arg(short, long)]
        output: Option<PathBuf>,
    },

    /// Run parameter sweep across multiple configurations
    Sweep {
        /// Path to debug recording directory
        #[arg(short, long)]
        recording: PathBuf,

        /// Path to transcription model
        #[arg(short, long)]
        model: PathBuf,

        /// Model engine type
        #[arg(short, long, default_value = "parakeet")]
        engine: String,

        /// Path to silero_vad_v4.onnx
        #[arg(long)]
        vad_model: PathBuf,

        /// Path to sweep config JSON file
        #[arg(long)]
        config: PathBuf,

        /// Output file path (default: <recording>/sweep_results.json)
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
}

fn default_model_path(engine: &str) -> PathBuf {
    let home = std::env::var("HOME").expect("HOME environment variable not set");
    let app_support = PathBuf::from(home)
        .join("Library/Application Support/com.khalil.talky/models");

    match engine {
        "whisper" => app_support.join("ggml-base.en.bin"),
        _ => app_support.join("parakeet-tdt-0.6b-v3-int8"),
    }
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let cli = Cli::parse();

    match cli.command {
        Command::TranscribeRaw {
            recording,
            model,
            engine,
            chunk_size,
            no_aec,
            output,
        } => {
            let rec = DebugRecording::load(&recording)?;
            let mut eng = ReplayEngine::load(&engine, Some(&model))?;

            eprintln!(
                "Transcribing raw audio: mic={:.1}s, spk={:.1}s, chunk_size={:.1}s, aec={}",
                rec.mic_samples.len() as f64 / 16000.0,
                rec.spk_samples.len() as f64 / 16000.0,
                chunk_size as f64 / 16000.0,
                !no_aec,
            );

            let segments =
                transcribe_raw(&rec.mic_samples, &rec.spk_samples, &mut eng, !no_aec, chunk_size)?;

            let json = serde_json::to_string_pretty(&segments)?;
            let out_path = output.unwrap_or_else(|| recording.join("golden_draft.json"));
            std::fs::write(&out_path, &json)?;
            eprintln!("Written {} segments to {}", segments.len(), out_path.display());
        }

        Command::Run {
            recording,
            model,
            engine,
            vad_model,
            compare,
            dry_run,
            output,
            vad_threshold,
            vad_onset_frames,
            vad_hangover_frames,
            speaker_energy_threshold,
            skip_mic_on_speaker_energy,
            dedup_similarity,
            dedup_time_overlap_ms,
            min_chunk_samples,
            max_chunk_samples,
            overlap_samples,
            aec_enabled,
            window_ms,
            hpf_cutoff,
            target_rms,
            silence_threshold,
            poll_interval_ms,
            spk_silence_flush_polls,
            prefix_overlap_min_words,
        } => {
            let rec = DebugRecording::load(&recording)?;
            let mut config = ReplayConfig::from_pipeline_config(&rec.metadata.pipeline_config);

            // Apply overrides
            if let Some(v) = vad_threshold { config.vad_threshold = v; }
            if let Some(v) = vad_onset_frames { config.vad_onset_frames = v; }
            if let Some(v) = vad_hangover_frames { config.vad_hangover_frames = v; }
            if let Some(v) = speaker_energy_threshold { config.speaker_energy_threshold = v; }
            if let Some(v) = skip_mic_on_speaker_energy { config.skip_mic_on_speaker_energy = v; }
            if let Some(v) = dedup_similarity { config.dedup_similarity_threshold = v; }
            if let Some(v) = dedup_time_overlap_ms { config.dedup_time_overlap_ms = v; }
            if let Some(v) = min_chunk_samples { config.min_chunk_samples = v; }
            if let Some(v) = max_chunk_samples { config.max_chunk_samples = v; }
            if let Some(v) = overlap_samples { config.overlap_samples = v; }
            if let Some(v) = aec_enabled { config.aec_enabled = v; }
            if let Some(v) = window_ms { config.window_ms = v; }
            if let Some(v) = hpf_cutoff { config.hpf_cutoff = v; }
            if let Some(v) = target_rms { config.target_rms = v; }
            if let Some(v) = silence_threshold { config.silence_threshold = v; }
            if let Some(v) = poll_interval_ms { config.poll_interval_ms = v; }
            if let Some(v) = spk_silence_flush_polls { config.spk_silence_flush_polls = v; }
            if let Some(v) = prefix_overlap_min_words { config.prefix_overlap_min_words = v; }

            if dry_run && model.is_some() {
                eprintln!("Warning: --model is ignored in dry-run mode");
            }

            let mut engine_instance = if !dry_run {
                let model_path = if engine.starts_with("coreml") {
                    None
                } else {
                    Some(model.ok_or_else(|| {
                        anyhow::anyhow!("--model is required when not using --dry-run")
                    })?)
                };
                Some(ReplayEngine::load(&engine, model_path.as_deref())?)
            } else {
                None
            };

            eprintln!(
                "Replaying: {:.1}s of audio, dry_run={}, compare={}",
                rec.metadata.duration_seconds,
                dry_run,
                compare
            );
            eprintln!("Config: {:?}", config);

            let result = run_replay(
                &config,
                &rec.mic_samples,
                &rec.spk_samples,
                engine_instance.as_mut(),
                &vad_model,
            )?;

            // Output segments to file
            let json = serde_json::to_string_pretty(&result.segments)?;
            let out_path = output.unwrap_or_else(|| recording.join("replay_output.json"));
            std::fs::write(&out_path, &json)?;
            eprintln!("Written {} segments to {}", result.segments.len(), out_path.display());

            // Output diagnostics to stderr
            eprintln!("\nDiagnostics: {:?}", result.diagnostics);

            // Compare against golden if requested
            if compare {
                if let Some(golden) = &rec.golden {
                    let score_result = score(&result.segments, golden);
                    eprintln!("\n{}", format_score_table(&score_result));
                } else {
                    eprintln!("\nWarning: --compare requested but no golden.json found in recording directory");
                }
            }
        }

        Command::Transcribe {
            input,
            model,
            engine,
            chunk_size,
            output,
        } => {
            let model = if engine.starts_with("coreml") {
                None
            } else {
                Some(model.unwrap_or_else(|| default_model_path(&engine)))
            };
            let samples = decode_audio_file(&input)?;

            eprintln!(
                "Transcribing {}: {:.1}s of audio",
                input.display(),
                samples.len() as f64 / 16000.0,
            );

            let mut eng = ReplayEngine::load(&engine, model.as_deref())?;
            let text = transcribe_file(&samples, &mut eng, chunk_size)?;

            let out_path = output.unwrap_or_else(|| input.with_extension("txt"));
            std::fs::write(&out_path, &text)?;
            eprintln!("Written to {}", out_path.display());
        }

        Command::AecMic { recording, output } => {
            let rec = DebugRecording::load(&recording)?;
            eprintln!(
                "Applying AEC to mic: {:.1}s ({} samples)",
                rec.mic_samples.len() as f64 / 16000.0,
                rec.mic_samples.len(),
            );

            let cleaned = apply_aec_to_mic(&rec.mic_samples, &rec.spk_samples)?;

            let out_path = output.unwrap_or_else(|| recording.join("mic_aec.wav"));
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: 16000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::create(&out_path, spec)?;
            for &s in &cleaned {
                let clamped = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                writer.write_sample(clamped)?;
            }
            writer.finalize()?;
            eprintln!("Written {} samples to {}", cleaned.len(), out_path.display());
        }

        Command::Sweep {
            recording,
            model,
            engine,
            vad_model,
            config: config_path,
            output,
        } => {
            let rec = DebugRecording::load(&recording)?;
            let golden = rec.golden.as_ref().ok_or_else(|| {
                anyhow::anyhow!("Sweep requires golden.json in the recording directory")
            })?;

            let base_config = ReplayConfig::from_pipeline_config(&rec.metadata.pipeline_config);
            let sweep_config = SweepConfig::load(&config_path)?;
            let mut eng = ReplayEngine::load(&engine, Some(&model))?;

            eprintln!(
                "Running sweep on {:.1}s recording with {} parameter combinations",
                rec.metadata.duration_seconds,
                sweep_config
                    .parameters
                    .values()
                    .map(|v| v.len())
                    .product::<usize>()
            );

            let results = run_sweep(
                &base_config,
                &sweep_config,
                &rec.mic_samples,
                &rec.spk_samples,
                &mut eng,
                golden,
                &vad_model,
            )?;

            let json = serde_json::to_string_pretty(&results)?;
            let out_path = output.unwrap_or_else(|| recording.join("sweep_results.json"));
            std::fs::write(&out_path, &json)?;
            eprintln!("Written {} results to {}", results.len(), out_path.display());

            // Summary table to stderr
            eprintln!("\n=== Sweep Results (sorted by combined WER) ===");
            eprintln!("{:<8} {:<8} {:<8}", "Comb%", "Mic%", "Spk%");
            for r in &results {
                eprintln!(
                    "{:<8.1} {:<8.1} {:<8.1}",
                    r.score.combined_wer * 100.0,
                    r.score.mic_wer * 100.0,
                    r.score.spk_wer * 100.0
                );
            }
        }
    }

    Ok(())
}
