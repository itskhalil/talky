use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

use talky_app_lib::audio_toolkit::session_transcriber::TranscriberConfig;
use talky_app_lib::replay::{
    engine::ReplayEngine,
    recording::DebugRecording,
    runner::{
        apply_aec_to_mic, decode_audio_file, run_session_replay, transcribe_file, transcribe_raw,
        LiveTiming,
    },
    scoring::{format_score_table, score},
};

#[derive(Parser)]
#[command(
    name = "replay",
    about = "Replay debug recordings through the audio pipeline"
)]
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

    /// Replay a recording through the session transcriber (the live pipeline)
    Session {
        /// Path to debug recording directory
        #[arg(short, long)]
        recording: PathBuf,

        /// Path to transcription model (ONNX engines)
        #[arg(short, long)]
        model: Option<PathBuf>,

        /// Model engine type: "parakeet" or "coreml"
        #[arg(short, long, default_value = "parakeet")]
        engine: String,

        /// Path to silero_vad_v4.onnx
        #[arg(long)]
        vad_model: PathBuf,

        /// TranscriberConfig overrides as JSON, e.g. '{"aec":false}'
        #[arg(long, default_value = "{}")]
        config: String,

        /// Simulated polling interval
        #[arg(long, default_value = "250")]
        poll_interval_ms: u64,

        /// Score against golden.json in the recording directory
        #[arg(long)]
        compare: bool,

        /// Shift system audio against the mic (+: far end leads its echo)
        #[arg(long, default_value = "0", allow_hyphen_values = true)]
        spk_lead_ms: i64,

        /// Deliver system audio in bursts of this length
        #[arg(long, default_value = "0")]
        spk_burst_ms: u64,

        /// Output file path (default: <recording>/replay_output.json)
        #[arg(short, long)]
        output: Option<PathBuf>,
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
}

fn default_model_path(engine: &str) -> PathBuf {
    let home = std::env::var("HOME").expect("HOME environment variable not set");
    let app_support =
        PathBuf::from(home).join("Library/Application Support/com.khalil.talky/models");

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

            let segments = transcribe_raw(
                &rec.mic_samples,
                &rec.spk_samples,
                &mut eng,
                !no_aec,
                chunk_size,
            )?;

            let json = serde_json::to_string_pretty(&segments)?;
            let out_path = output.unwrap_or_else(|| recording.join("golden_draft.json"));
            std::fs::write(&out_path, &json)?;
            eprintln!(
                "Written {} segments to {}",
                segments.len(),
                out_path.display()
            );
        }

        Command::Session {
            recording,
            model,
            engine,
            vad_model,
            config,
            poll_interval_ms,
            spk_lead_ms,
            spk_burst_ms,
            compare,
            output,
        } => {
            let rec = DebugRecording::load(&recording)?;
            let config: TranscriberConfig = serde_json::from_str(&config)?;
            let model_path = if engine.starts_with("coreml") {
                None
            } else {
                Some(model.unwrap_or_else(|| default_model_path(&engine)))
            };
            let mut eng = ReplayEngine::load(&engine, model_path.as_deref())?;
            eprintln!(
                "Session replay: {:.1}s, config {:?}",
                rec.metadata.duration_seconds, config
            );

            let (segments, stats) = run_session_replay(
                &config,
                &rec.mic_samples,
                &rec.spk_samples,
                &mut eng,
                &vad_model,
                &LiveTiming {
                    poll_interval_ms,
                    spk_lead_ms,
                    spk_burst_ms,
                },
            )?;
            let out_path = output.unwrap_or_else(|| recording.join("replay_output.json"));
            std::fs::write(&out_path, serde_json::to_string_pretty(&segments)?)?;
            eprintln!(
                "Written {} segments to {}",
                segments.len(),
                out_path.display()
            );
            eprintln!("Stats: {:?}", stats);
            if compare {
                match &rec.golden {
                    Some(golden) => {
                        eprintln!("\n{}", format_score_table(&score(&segments, golden)))
                    }
                    None => eprintln!("--compare: no golden.json in {}", recording.display()),
                }
            }
            eprintln!(
                "Engine time: {:.1}s for {:.1}s of audio",
                talky_app_lib::replay::engine::infer_secs(),
                rec.metadata.duration_seconds
            );
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
            eprintln!(
                "Written {} samples to {}",
                cleaned.len(),
                out_path.display()
            );
        }
    }

    Ok(())
}
