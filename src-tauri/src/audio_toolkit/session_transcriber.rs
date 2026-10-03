//! Live two-channel transcription for a session.
//!
//! The mic carries the user ("me"); the system-audio tap carries everyone else
//! ("them"). Each channel is cut into speech chunks by Silero VAD through
//! transcribe-rs's `VadChunked`, so chunks end in pauses rather than mid-word
//! and silence never reaches the model. Before segmentation the mic runs
//! through WebRTC's echo canceller (AEC3) with the system audio as reference,
//! so on laptop speakers the others' voices don't come back as "me".
//!
//! The same code drives the live app (`actions.rs`) and the offline replay
//! tool, so what replay measures is what ships.

use std::collections::VecDeque;
use std::path::Path;

use anyhow::Result;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use transcribe_rs::transcriber::{Transcriber, VadChunked, VadChunkedConfig};
use transcribe_rs::vad::{SileroVad, SmoothedVad, Vad};
use transcribe_rs::{
    ModelCapabilities, SpeechModel, TranscribeError, TranscribeOptions, TranscriptionResult,
    TranscriptionSegment,
};

pub const SAMPLE_RATE: usize = 16000;
const WEBRTC_FRAME: usize = SAMPLE_RATE / 100; // AEC3 works on 10 ms frames

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct TranscriberConfig {
    /// Silero speech probability threshold.
    pub vad_threshold: f32,
    /// Frames quieter than this never count as speech. Silero detects speech
    /// at any level, including faint background talk on a call.
    pub min_speech_dbfs: f32,
    /// Consecutive speech frames (30 ms) before a chunk opens.
    pub onset_frames: usize,
    /// Non-speech frames tolerated inside a chunk before it closes.
    pub hangover_frames: usize,
    /// Frames of audio kept from before speech onset.
    pub prefill_frames: usize,
    /// Chunks shorter than this merge into the next speech region.
    pub min_chunk_secs: f32,
    /// Chunks are split once they reach this length.
    pub max_chunk_secs: f32,
    /// When splitting a long chunk, search this far back for the quietest
    /// frame instead of cutting mid-word. 0 disables.
    pub smart_split_secs: f32,
    /// Silence added around each chunk before transcription.
    pub padding_secs: f32,
    /// Cancel echo of the system audio in the mic (WebRTC AEC3). It finds the
    /// delay between the two streams itself, which the live capture needs:
    /// the system-audio tap starts after the mic and delivers in bursts.
    pub aec: bool,
}

impl Default for TranscriberConfig {
    fn default() -> Self {
        Self {
            vad_threshold: 0.3,
            min_speech_dbfs: -50.0,
            onset_frames: 2,
            hangover_frames: 25,
            prefill_frames: 10,
            min_chunk_secs: 3.0,
            max_chunk_secs: 15.0,
            smart_split_secs: 3.0,
            padding_secs: 0.0,
            aec: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Mic,
    Speaker,
}

impl Channel {
    /// The `source` string stored with transcript segments.
    pub fn source(self) -> &'static str {
        match self {
            Channel::Mic => "mic",
            Channel::Speaker => "speaker",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Segment {
    pub channel: Channel,
    pub text: String,
    /// Milliseconds since the start of the recording.
    pub start_ms: i64,
    pub end_ms: i64,
}

/// Something that turns a chunk of 16 kHz mono audio into text.
pub trait ChunkEngine: Send {
    fn transcribe(&mut self, audio: &[f32]) -> Result<TranscriptionResult>;
}

/// Adapts a [`ChunkEngine`] to transcribe-rs's `SpeechModel` so `VadChunked`
/// can drive it. Engines that return no timestamps get one segment spanning
/// the chunk.
struct ModelShim<'a> {
    engine: &'a mut dyn ChunkEngine,
    /// Text of the most recent chunk, as the engine returned it.
    last_text: Option<String>,
}

impl SpeechModel for ModelShim<'_> {
    fn capabilities(&self) -> ModelCapabilities {
        ModelCapabilities {
            name: "talky-chunk-engine",
            engine_id: "talky",
            sample_rate: SAMPLE_RATE as u32,
            languages: &[],
            supports_timestamps: true,
            supports_translation: false,
            supports_streaming: false,
        }
    }

    fn transcribe_raw(
        &mut self,
        samples: &[f32],
        options: &TranscribeOptions,
    ) -> std::result::Result<TranscriptionResult, TranscribeError> {
        let lead = options.leading_silence_ms.unwrap_or(0) as f32 / 1000.0;
        let trail = options.trailing_silence_ms.unwrap_or(0) as f32 / 1000.0;
        let total = samples.len() as f32 / SAMPLE_RATE as f32;
        let mut result = self
            .engine
            .transcribe(samples)
            .map_err(|e| TranscribeError::Inference(e.to_string()))?;
        self.last_text = Some(result.text.clone());
        let has_segments = result.segments.as_ref().is_some_and(|s| !s.is_empty());
        if !has_segments {
            result.segments = Some(vec![TranscriptionSegment {
                start: lead,
                end: (total - trail).max(lead),
                text: result.text.clone(),
            }]);
        }
        Ok(result)
    }
}

/// Silero, but frames below a level floor are never speech.
struct LevelGatedVad {
    silero: SileroVad,
    min_rms: f32,
}

impl Vad for LevelGatedVad {
    fn frame_size(&self) -> usize {
        self.silero.frame_size()
    }

    fn is_speech(&mut self, frame: &[f32]) -> std::result::Result<bool, TranscribeError> {
        // Always run the model so its recurrent state follows the audio.
        let speech = self.silero.is_speech(frame)?;
        let rms = (frame.iter().map(|x| x * x).sum::<f32>() / frame.len().max(1) as f32).sqrt();
        Ok(speech && rms >= self.min_rms)
    }

    fn reset(&mut self) {
        self.silero.reset();
    }
}

struct ChannelPipeline {
    channel: Channel,
    chunker: VadChunked,
    /// Samples fed to the chunker so far.
    fed: usize,
    /// Engine segments already turned into transcript segments; `finish`
    /// returns the whole session merged, so this marks where new ones start.
    segments_seen: usize,
    /// `VadChunked` restarts its clock at zero after `finish`; samples fed
    /// before the last finish.
    time_base: usize,
}

impl ChannelPipeline {
    fn new(channel: Channel, config: &TranscriberConfig, vad_model: &Path) -> Result<Self> {
        let silero = SileroVad::new(vad_model, config.vad_threshold)
            .map_err(|e| anyhow::anyhow!("Silero VAD: {e}"))?;
        let vad = SmoothedVad::new(
            Box::new(LevelGatedVad {
                silero,
                min_rms: 10f32.powf(config.min_speech_dbfs / 20.0),
            }),
            config.prefill_frames,
            config.hangover_frames,
            config.onset_frames,
        );
        let chunker = VadChunked::new(
            Box::new(vad),
            VadChunkedConfig {
                min_chunk_secs: config.min_chunk_secs,
                max_chunk_secs: config.max_chunk_secs,
                padding_secs: config.padding_secs,
                smart_split_search_secs: (config.smart_split_secs > 0.0)
                    .then_some(config.smart_split_secs),
                merge_separator: " ".into(),
            },
            TranscribeOptions::default(),
        );
        Ok(Self {
            channel,
            chunker,
            fed: 0,
            segments_seen: 0,
            time_base: 0,
        })
    }

    fn feed(&mut self, samples: &[f32], engine: &mut dyn ChunkEngine) -> Result<Vec<Segment>> {
        if samples.is_empty() {
            return Ok(Vec::new());
        }
        self.fed += samples.len();
        let mut shim = ModelShim {
            engine,
            last_text: None,
        };
        let results = self
            .chunker
            .feed(&mut shim, samples)
            .map_err(|e| anyhow::anyhow!("{:?} chunker: {e}", self.channel))?;
        let base_ms = self.base_ms();
        Ok(results
            .into_iter()
            .filter_map(|r| {
                self.segments_seen += r.segments.as_ref().map_or(0, |s| s.len());
                to_segment(self.channel, r, base_ms)
            })
            .collect())
    }

    fn base_ms(&self) -> i64 {
        (self.time_base * 1000 / SAMPLE_RATE) as i64
    }

    fn finish(&mut self, engine: &mut dyn ChunkEngine) -> Result<Vec<Segment>> {
        let mut shim = ModelShim {
            engine,
            last_text: None,
        };
        let merged = self
            .chunker
            .finish(&mut shim)
            .map_err(|e| anyhow::anyhow!("{:?} chunker finish: {e}", self.channel))?;
        // `finish` returns every chunk of the session merged; what's past the
        // segments already seen is the final chunk. Its text comes from the
        // engine call itself (segment texts skip the engine's post-processing).
        let Some(text) = shim.last_text.take() else {
            self.segments_seen = 0;
            self.time_base = self.fed;
            return Ok(Vec::new());
        };
        let rest: Vec<TranscriptionSegment> = merged
            .segments
            .unwrap_or_default()
            .into_iter()
            .skip(self.segments_seen)
            .collect();
        self.segments_seen = 0;
        let base_ms = self.base_ms();
        self.time_base = self.fed;
        Ok(to_segment(
            self.channel,
            TranscriptionResult {
                text,
                segments: Some(rest),
            },
            base_ms,
        )
        .into_iter()
        .collect())
    }
}

/// One `TranscriptionResult` (a chunk) becomes one transcript segment spanning
/// its timestamped speech.
fn to_segment(channel: Channel, r: TranscriptionResult, base_ms: i64) -> Option<Segment> {
    let text = r.text.trim().to_string();
    if text.is_empty() {
        return None;
    }
    let segs = r.segments.unwrap_or_default();
    let start = segs.iter().map(|s| s.start).fold(f32::INFINITY, f32::min);
    let end = segs.iter().map(|s| s.end).fold(0.0f32, f32::max);
    let start = if start.is_finite() { start } else { 0.0 };
    Some(Segment {
        channel,
        text,
        start_ms: base_ms + (start * 1000.0) as i64,
        end_ms: base_ms + (end.max(start) * 1000.0) as i64,
    })
}

/// Streams the mic through WebRTC AEC3 with the system audio as reference,
/// keeping both streams in step by sample position.
struct EchoCanceller {
    apm: Box<sonora::AudioProcessing>,
    /// Mic samples waiting for their reference.
    mic: Vec<f32>,
    /// Reference samples not yet consumed.
    spk: VecDeque<f32>,
    render_out: Vec<f32>,
}

impl EchoCanceller {
    /// If the reference falls this far behind, treat the gap as silence
    /// rather than holding the mic back indefinitely (system audio capture
    /// can stall or fail).
    const MAX_REFERENCE_LAG: usize = SAMPLE_RATE;

    fn new() -> Self {
        let stream = sonora::StreamConfig::new(SAMPLE_RATE as u32, 1);
        let apm = sonora::AudioProcessing::builder()
            .config(sonora::Config {
                echo_canceller: Some(sonora::config::EchoCanceller::default()),
                ..Default::default()
            })
            .capture_config(stream)
            .render_config(stream)
            .build();
        Self {
            apm: Box::new(apm),
            mic: Vec::new(),
            spk: VecDeque::new(),
            render_out: vec![0.0; WEBRTC_FRAME],
        }
    }

    fn process(&mut self, mic: &[f32], spk: &[f32]) -> Vec<f32> {
        self.mic.extend_from_slice(mic);
        self.spk.extend(spk.iter().copied());
        let lag = self.mic.len().saturating_sub(self.spk.len());
        if lag > Self::MAX_REFERENCE_LAG {
            let fill = lag - Self::MAX_REFERENCE_LAG;
            self.spk.extend(std::iter::repeat_n(0.0, fill));
        }
        let frames = self.mic.len().min(self.spk.len()) / WEBRTC_FRAME;
        let mut out = vec![0.0f32; frames * WEBRTC_FRAME];
        let mut render = [0.0f32; WEBRTC_FRAME];
        let (out_frames, _) = out.as_chunks_mut::<WEBRTC_FRAME>();
        let (mic_frames, _) = self.mic.as_chunks::<WEBRTC_FRAME>();
        for (o, m) in out_frames.iter_mut().zip(mic_frames) {
            for (dst, src) in render.iter_mut().zip(self.spk.drain(..WEBRTC_FRAME)) {
                *dst = src;
            }
            // Render (far end) first, then the capture it may have leaked into.
            let result = self
                .apm
                .process_render_f32(&[&render], &mut [&mut self.render_out])
                .and_then(|_| self.apm.process_capture_f32(&[m], &mut [o]));
            if let Err(e) = result {
                warn!("AEC3 failed on a frame, passing mic through: {e:?}");
                o.copy_from_slice(m);
            }
        }
        self.mic.drain(..out.len());
        out
    }

    /// Mic samples still waiting for reference audio (at the end of a session
    /// the reference may never arrive).
    fn drain(&mut self) -> Vec<f32> {
        self.spk.clear();
        std::mem::take(&mut self.mic)
    }
}

/// Echo-cancel a whole recording's mic channel (offline tools).
pub fn cancel_echo(mic: &[f32], spk: &[f32]) -> Vec<f32> {
    let mut ec = EchoCanceller::new();
    let mut out = ec.process(mic, spk);
    out.extend(ec.drain());
    out
}

pub struct SessionTranscriber {
    mic: ChannelPipeline,
    spk: ChannelPipeline,
    aec: Option<EchoCanceller>,
    pub stats: TranscriberStats,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct TranscriberStats {
    pub mic_chunks: usize,
    pub spk_chunks: usize,
}

impl SessionTranscriber {
    pub fn new(config: TranscriberConfig, vad_model: &Path) -> Result<Self> {
        info!("Session transcriber config: {:?}", config);
        Ok(Self {
            mic: ChannelPipeline::new(Channel::Mic, &config, vad_model)?,
            spk: ChannelPipeline::new(Channel::Speaker, &config, vad_model)?,
            aec: config.aec.then(EchoCanceller::new),
            stats: TranscriberStats::default(),
        })
    }

    /// Feed newly captured audio from both channels and return any segments
    /// that completed.
    pub fn push(
        &mut self,
        mic: &[f32],
        spk: &[f32],
        engine: &mut dyn ChunkEngine,
    ) -> Result<Vec<Segment>> {
        let mut out = self.spk.feed(spk, engine)?;
        self.stats.spk_chunks += out.len();
        let mic = match &mut self.aec {
            Some(aec) => aec.process(mic, spk),
            None => mic.to_vec(),
        };
        let mic_segments = self.mic.feed(&mic, engine)?;
        self.stats.mic_chunks += mic_segments.len();
        out.extend(mic_segments);
        Ok(out)
    }

    /// Transcribe whatever is buffered on both channels now (e.g. before the
    /// user asks a question about the meeting) and keep going afterwards.
    pub fn flush(&mut self, engine: &mut dyn ChunkEngine) -> Result<Vec<Segment>> {
        let mut out = self.spk.finish(engine)?;
        self.stats.spk_chunks += out.len();
        let mic_segments = self.mic.finish(engine)?;
        self.stats.mic_chunks += mic_segments.len();
        out.extend(mic_segments);
        Ok(out)
    }

    /// End of the session: also transcribe mic audio still waiting for its
    /// echo reference, then flush.
    pub fn finish(&mut self, engine: &mut dyn ChunkEngine) -> Result<Vec<Segment>> {
        let mut out = Vec::new();
        if let Some(aec) = &mut self.aec {
            let rest = aec.drain();
            let segments = self.mic.feed(&rest, engine)?;
            self.stats.mic_chunks += segments.len();
            out.extend(segments);
        }
        out.extend(self.flush(engine)?);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_canceller_does_not_wait_forever_for_reference() {
        let mut ec = EchoCanceller::new();
        let second = vec![0.01f32; SAMPLE_RATE];
        // No reference at all: the first second is held, then mic flows.
        assert!(ec.process(&second, &[]).is_empty());
        let out = ec.process(&second, &[]);
        assert!(out.len() >= SAMPLE_RATE - WEBRTC_FRAME);
    }

    #[test]
    fn echo_canceller_removes_a_delayed_echo() {
        // Far end: deterministic noise. Mic: the far end 120 ms later at half
        // level, as a laptop speaker into its own mic.
        let n = SAMPLE_RATE * 8;
        let mut seed = 12345u32;
        let far: Vec<f32> = (0..n)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
            })
            .map(|x| x * 0.2)
            .collect();
        let delay = SAMPLE_RATE * 120 / 1000;
        let mut mic = vec![0.0f32; n];
        for i in delay..n {
            mic[i] = far[i - delay] * 0.5;
        }
        let out = cancel_echo(&mic, &far);
        let rms = |x: &[f32]| (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
        // After a few seconds to converge, most of the echo is gone.
        let tail = 5 * SAMPLE_RATE..out.len();
        let reduction_db = 20.0 * (rms(&mic[tail.clone()]) / rms(&out[tail]).max(1e-9)).log10();
        assert!(
            reduction_db > 15.0,
            "only {reduction_db:.1} dB of echo removed"
        );
    }
}
