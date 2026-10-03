//! Live two-channel transcription for a session.
//!
//! The mic carries the user ("me"); the system-audio tap carries everyone else
//! ("them"). Each channel is cut into speech chunks by Silero VAD through
//! transcribe-rs's `VadChunked`, so chunks end in pauses rather than mid-word
//! and silence never reaches the model. Before segmentation the mic can be
//! cleaned of the far end's echo, and a mic chunk that only repeats what the
//! far end said is dropped.
//!
//! The same code drives the live app (`actions.rs`) and the offline replay
//! tool, so what replay measures is what ships.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use anyhow::Result;
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use transcribe_rs::transcriber::{Transcriber, VadChunked, VadChunkedConfig};
use transcribe_rs::vad::{SileroVad, SmoothedVad, Vad};
use transcribe_rs::{
    ModelCapabilities, SpeechModel, TranscribeError, TranscribeOptions, TranscriptionResult,
    TranscriptionSegment,
};

pub const SAMPLE_RATE: usize = 16000;
const VAD_FRAME: usize = 480; // 30 ms; Silero v4 frame size

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
    /// Run echo cancellation on the mic using the system audio as reference.
    pub aec: bool,
    /// Silence mic windows while the far end is loud (blunt echo control;
    /// also drops the user's speech when talking over someone).
    pub echo_gate: bool,
    pub echo_gate_threshold: f32,
    pub echo_gate_window_ms: usize,
    /// Drop a mic chunk when this share of its words repeat the far end.
    pub dedup_coverage: f32,
    /// Hold mic chunks while an overlapping far-end chunk is still open, so
    /// the duplicate check can see it. Upper bound on the hold.
    pub max_mic_hold_secs: f32,
}

impl Default for TranscriberConfig {
    fn default() -> Self {
        Self {
            vad_threshold: 0.3,
            min_speech_dbfs: -50.0,
            onset_frames: 2,
            hangover_frames: 15,
            prefill_frames: 10,
            min_chunk_secs: 1.0,
            max_chunk_secs: 15.0,
            smart_split_secs: 3.0,
            padding_secs: 0.0,
            aec: true,
            echo_gate: false,
            echo_gate_threshold: 0.04,
            echo_gate_window_ms: 400,
            dedup_coverage: 0.6,
            max_mic_hold_secs: 20.0,
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

/// Wraps the smoothed VAD so the session can see whether a channel is
/// mid-utterance (`VadChunked` keeps that private).
struct VadTap {
    inner: SmoothedVad,
    in_speech: Arc<AtomicBool>,
    /// Frames seen so far, and the frame index at which the open speech
    /// region began.
    frames: Arc<AtomicUsize>,
    speech_start_frame: Arc<AtomicUsize>,
}

impl Vad for VadTap {
    fn frame_size(&self) -> usize {
        self.inner.frame_size()
    }

    fn is_speech(&mut self, frame: &[f32]) -> std::result::Result<bool, TranscribeError> {
        let was = self.inner.in_speech();
        let speech = self.inner.is_speech(frame)?;
        let n = self.frames.fetch_add(1, Ordering::Relaxed);
        let now = self.inner.in_speech();
        if now && !was {
            self.speech_start_frame.store(n, Ordering::Relaxed);
        }
        self.in_speech.store(now, Ordering::Relaxed);
        Ok(speech)
    }

    fn drain_prefill(&mut self) -> Vec<f32> {
        self.inner.drain_prefill()
    }

    fn reset(&mut self) {
        self.inner.reset();
        self.in_speech.store(false, Ordering::Relaxed);
    }
}

struct ChannelPipeline {
    channel: Channel,
    chunker: VadChunked,
    in_speech: Arc<AtomicBool>,
    speech_start_frame: Arc<AtomicUsize>,
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
        let in_speech = Arc::new(AtomicBool::new(false));
        let speech_start_frame = Arc::new(AtomicUsize::new(0));
        let tap = VadTap {
            inner: SmoothedVad::new(
                Box::new(LevelGatedVad {
                    silero,
                    min_rms: 10f32.powf(config.min_speech_dbfs / 20.0),
                }),
                config.prefill_frames,
                config.hangover_frames,
                config.onset_frames,
            ),
            in_speech: in_speech.clone(),
            frames: Arc::new(AtomicUsize::new(0)),
            speech_start_frame: speech_start_frame.clone(),
        };
        let chunker = VadChunked::new(
            Box::new(tap),
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
            in_speech,
            speech_start_frame,
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

    /// Start (ms) of the utterance currently being buffered, if any.
    fn open_speech_start_ms(&self) -> Option<i64> {
        if !self.in_speech.load(Ordering::Relaxed) {
            return None;
        }
        let frame = self.speech_start_frame.load(Ordering::Relaxed);
        Some((frame * VAD_FRAME * 1000 / SAMPLE_RATE) as i64)
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

/// Streams the mic through the DTLN echo canceller with the system audio as
/// reference, keeping both streams sample-aligned by position.
struct EchoCanceller {
    aec: crate::aec::AEC,
    /// Mic samples waiting for their reference.
    mic: Vec<f32>,
    /// Reference samples not yet consumed.
    spk: VecDeque<f32>,
}

impl EchoCanceller {
    const BLOCK: usize = 128;
    /// If the reference falls this far behind, treat the gap as silence
    /// rather than holding the mic back indefinitely (system audio capture
    /// can stall or fail).
    const MAX_REFERENCE_LAG: usize = SAMPLE_RATE;

    fn process(&mut self, mic: &[f32], spk: &[f32]) -> Vec<f32> {
        self.mic.extend_from_slice(mic);
        self.spk.extend(spk.iter().copied());
        let lag = self.mic.len().saturating_sub(self.spk.len());
        if lag > Self::MAX_REFERENCE_LAG {
            let fill = lag - Self::MAX_REFERENCE_LAG;
            self.spk.extend(std::iter::repeat_n(0.0, fill));
        }
        let ready = self.mic.len().min(self.spk.len()) / Self::BLOCK * Self::BLOCK;
        if ready == 0 {
            return Vec::new();
        }
        let mic_block: Vec<f32> = self.mic.drain(..ready).collect();
        let spk_block: Vec<f32> = self.spk.drain(..ready).collect();
        match self.aec.process_streaming(&mic_block, &spk_block) {
            Ok(cleaned) => cleaned,
            Err(e) => {
                warn!("AEC failed, passing mic through: {e}");
                mic_block
            }
        }
    }

    /// Mic samples still waiting for reference audio (at the end of a session
    /// the reference may never arrive).
    fn drain(&mut self) -> Vec<f32> {
        self.spk.clear();
        std::mem::take(&mut self.mic)
    }
}

pub struct SessionTranscriber {
    config: TranscriberConfig,
    mic: ChannelPipeline,
    spk: ChannelPipeline,
    aec: Option<EchoCanceller>,
    /// Far-end audio kept for the echo gate, aligned to mic positions.
    gate_ref: VecDeque<f32>,
    /// Recent far-end segments, for the duplicate check.
    recent_spk: VecDeque<Segment>,
    /// Mic segments waiting for the overlapping far-end chunk to close.
    held_mic: VecDeque<Segment>,
    pub stats: TranscriberStats,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct TranscriberStats {
    pub mic_chunks: usize,
    pub spk_chunks: usize,
    pub mic_dropped_as_echo: usize,
    pub gate_windows_zeroed: usize,
}

impl SessionTranscriber {
    pub fn new(config: TranscriberConfig, vad_model: &Path) -> Result<Self> {
        let aec = if config.aec {
            match crate::aec::AEC::new() {
                Ok(aec) => Some(EchoCanceller {
                    aec,
                    mic: Vec::new(),
                    spk: VecDeque::new(),
                }),
                Err(e) => {
                    warn!("AEC init failed, running without echo cancellation: {e}");
                    None
                }
            }
        } else {
            None
        };
        info!("Session transcriber config: {:?}", config);
        Ok(Self {
            mic: ChannelPipeline::new(Channel::Mic, &config, vad_model)?,
            spk: ChannelPipeline::new(Channel::Speaker, &config, vad_model)?,
            config,
            aec,
            gate_ref: VecDeque::new(),
            recent_spk: VecDeque::new(),
            held_mic: VecDeque::new(),
            stats: TranscriberStats::default(),
        })
    }

    /// Feed newly captured audio from both channels and return any segments
    /// that completed. Far-end chunks are processed first so a mic chunk can
    /// be checked against what the far end said.
    pub fn push(
        &mut self,
        mic: &[f32],
        spk: &[f32],
        engine: &mut dyn ChunkEngine,
    ) -> Result<Vec<Segment>> {
        let mut out = Vec::new();
        for seg in self.spk.feed(spk, engine)? {
            self.on_spk_segment(seg, &mut out);
        }

        let mic = match &mut self.aec {
            Some(aec) => aec.process(mic, spk),
            None => mic.to_vec(),
        };
        let mic = self.apply_echo_gate(mic, spk);
        for seg in self.mic.feed(&mic, engine)? {
            self.stats.mic_chunks += 1;
            self.held_mic.push_back(seg);
        }
        self.release_held_mic(false, &mut out);
        Ok(out)
    }

    /// Transcribe whatever is buffered on both channels now (e.g. before the
    /// user asks a question about the meeting) and keep going afterwards.
    pub fn flush(&mut self, engine: &mut dyn ChunkEngine) -> Result<Vec<Segment>> {
        let mut out = Vec::new();
        for seg in self.spk.finish(engine)? {
            self.on_spk_segment(seg, &mut out);
        }
        for seg in self.mic.finish(engine)? {
            self.stats.mic_chunks += 1;
            self.held_mic.push_back(seg);
        }
        self.release_held_mic(true, &mut out);
        Ok(out)
    }

    /// End of the session: also transcribe mic audio still waiting for its
    /// echo reference, then flush.
    pub fn finish(&mut self, engine: &mut dyn ChunkEngine) -> Result<Vec<Segment>> {
        let mut out = Vec::new();
        if let Some(aec) = &mut self.aec {
            let rest = aec.drain();
            for seg in self.mic.feed(&rest, engine)? {
                self.stats.mic_chunks += 1;
                self.held_mic.push_back(seg);
            }
        }
        out.extend(self.flush(engine)?);
        Ok(out)
    }

    fn on_spk_segment(&mut self, seg: Segment, out: &mut Vec<Segment>) {
        self.stats.spk_chunks += 1;
        self.recent_spk.push_back(seg.clone());
        // Keep a minute of far-end history for the duplicate check.
        while self
            .recent_spk
            .front()
            .is_some_and(|s| s.end_ms < seg.end_ms - 60_000)
        {
            self.recent_spk.pop_front();
        }
        out.push(seg);
    }

    fn release_held_mic(&mut self, force: bool, out: &mut Vec<Segment>) {
        let max_hold_ms = (self.config.max_mic_hold_secs * 1000.0) as i64;
        let mic_now_ms = (self.mic.fed * 1000 / SAMPLE_RATE) as i64;
        while let Some(seg) = self.held_mic.front() {
            // An open far-end utterance that began before this mic chunk ended
            // may be the source of an echo: wait for it to be transcribed.
            let waiting = !force
                && self
                    .spk
                    .open_speech_start_ms()
                    .is_some_and(|start| start < seg.end_ms)
                && mic_now_ms - seg.end_ms < max_hold_ms;
            if waiting {
                break;
            }
            let seg = self.held_mic.pop_front().expect("front exists");
            if self.is_echo(&seg) {
                self.stats.mic_dropped_as_echo += 1;
                debug!("Dropping mic chunk that repeats the far end");
                continue;
            }
            out.push(seg);
        }
    }

    /// True when most of the mic chunk's words repeat a far-end chunk that
    /// overlaps it in time.
    fn is_echo(&self, seg: &Segment) -> bool {
        let mic_words = words(&seg.text);
        if mic_words.is_empty() {
            return false;
        }
        let far: Vec<String> = self
            .recent_spk
            .iter()
            .filter(|s| s.end_ms >= seg.start_ms - 2000 && s.start_ms <= seg.end_ms + 2000)
            .flat_map(|s| words(&s.text))
            .collect();
        if far.is_empty() {
            return false;
        }
        coverage(&mic_words, &far) >= self.config.dedup_coverage
    }

    /// Zero mic windows in which the far end is louder than the threshold.
    fn apply_echo_gate(&mut self, mut mic: Vec<f32>, spk: &[f32]) -> Vec<f32> {
        if !self.config.echo_gate {
            return mic;
        }
        self.gate_ref.extend(spk.iter().copied());
        let window = self.config.echo_gate_window_ms * SAMPLE_RATE / 1000;
        for chunk in mic.chunks_mut(window) {
            // Reference samples for this mic span, as far as they've arrived.
            let n = chunk.len().min(self.gate_ref.len());
            if n > 0 {
                let energy: f32 = self.gate_ref.iter().take(n).map(|x| x * x).sum();
                let rms = (energy / n as f32).sqrt();
                if rms > self.config.echo_gate_threshold {
                    chunk.iter_mut().for_each(|x| *x = 0.0);
                    self.stats.gate_windows_zeroed += 1;
                }
                self.gate_ref.drain(..n);
            }
        }
        mic
    }
}

/// Lower-cased words with punctuation stripped.
fn words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

/// Share of `a`'s words covered by runs of 3+ words that also appear, in
/// order, in `b`. Short runs ("and the", "yeah") match by chance and don't
/// count.
fn coverage(a: &[String], b: &[String]) -> f32 {
    const MIN_RUN: usize = 3;
    if a.len() < MIN_RUN || b.len() < MIN_RUN {
        // Very short chunks: count them as covered only when they appear whole.
        let joined_b = format!(" {} ", b.join(" "));
        let joined_a = format!(" {} ", a.join(" "));
        return if !a.is_empty() && joined_b.contains(&joined_a) {
            1.0
        } else {
            0.0
        };
    }
    let mut covered = vec![false; a.len()];
    let grams: std::collections::HashSet<&[String]> = b.windows(MIN_RUN).collect();
    for i in 0..=a.len() - MIN_RUN {
        if grams.contains(&a[i..i + MIN_RUN]) {
            covered[i..i + MIN_RUN].iter_mut().for_each(|c| *c = true);
        }
    }
    covered.iter().filter(|c| **c).count() as f32 / a.len() as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(s: &str) -> Vec<String> {
        words(s)
    }

    #[test]
    fn coverage_counts_shared_runs() {
        let a = w("so the budget is twelve thousand euros right");
        let b = w("okay so the budget is twelve thousand euros for the remote");
        assert!(coverage(&a, &b) > 0.8);
    }

    #[test]
    fn coverage_ignores_common_short_overlaps() {
        let a = w("I think we should go with the yellow one");
        let b = w("and the remote should be yellow and the");
        assert!(coverage(&a, &b) < 0.3);
    }

    #[test]
    fn echo_canceller_does_not_wait_forever_for_reference() {
        let Ok(aec) = crate::aec::AEC::new() else {
            return;
        };
        let mut ec = EchoCanceller {
            aec,
            mic: Vec::new(),
            spk: VecDeque::new(),
        };
        let second = vec![0.01f32; SAMPLE_RATE];
        // No reference at all: the first second is held, then mic flows.
        assert!(ec.process(&second, &[]).is_empty());
        let out = ec.process(&second, &[]);
        assert!(out.len() >= SAMPLE_RATE - EchoCanceller::BLOCK);
    }

    #[test]
    fn short_chunks_must_match_whole() {
        assert_eq!(
            coverage(&w("yeah exactly"), &w("yeah exactly that's it")),
            1.0
        );
        assert_eq!(coverage(&w("no way"), &w("yeah exactly that's it")), 0.0);
    }
}
