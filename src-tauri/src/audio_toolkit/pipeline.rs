use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::audio_toolkit::audio::FrameResampler;
use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;
use crate::audio_toolkit::vad::VadFrame;
use crate::audio_toolkit::VoiceActivityDetector;

const AMPLITUDE_THROTTLE: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ChannelMode {
    MicOnly,
    SpeakerOnly,
    MicAndSpeaker,
}

pub type AudioPair = (Vec<f32>, Vec<f32>);

pub struct Joiner {
    mic: VecDeque<Vec<f32>>,
    spk: VecDeque<Vec<f32>>,
}

impl Joiner {
    const MAX_LAG: usize = 4;
    const MAX_QUEUE_SIZE: usize = 30;

    pub fn new() -> Self {
        Self {
            mic: VecDeque::new(),
            spk: VecDeque::new(),
        }
    }

    pub fn reset(&mut self) {
        self.mic.clear();
        self.spk.clear();
    }

    pub fn push_mic(&mut self, data: Vec<f32>) {
        self.mic.push_back(data);
        if self.mic.len() > Self::MAX_QUEUE_SIZE {
            log::warn!("mic_queue_overflow");
            self.mic.pop_front();
        }
    }

    pub fn push_spk(&mut self, data: Vec<f32>) {
        self.spk.push_back(data);
        if self.spk.len() > Self::MAX_QUEUE_SIZE {
            log::warn!("spk_queue_overflow");
            self.spk.pop_front();
        }
    }

    fn get_silence(len: usize) -> Vec<f32> {
        vec![0.0; len]
    }

    pub fn pop_pair(&mut self, mode: ChannelMode) -> Option<AudioPair> {
        if self.mic.front().is_some() && self.spk.front().is_some() {
            return Some((self.mic.pop_front()?, self.spk.pop_front()?));
        }

        match mode {
            ChannelMode::MicOnly => {
                if let Some(mic) = self.mic.pop_front() {
                    let spk = Self::get_silence(mic.len());
                    return Some((mic, spk));
                }
            }
            ChannelMode::SpeakerOnly => {
                if let Some(spk) = self.spk.pop_front() {
                    let mic = Self::get_silence(spk.len());
                    return Some((mic, spk));
                }
            }
            ChannelMode::MicAndSpeaker => {
                if self.mic.front().is_some()
                    && self.spk.is_empty()
                    && self.mic.len() > Self::MAX_LAG
                {
                    let mic = self.mic.pop_front()?;
                    let spk = Self::get_silence(mic.len());
                    return Some((mic, spk));
                }
                if self.spk.front().is_some()
                    && self.mic.is_empty()
                    && self.spk.len() > Self::MAX_LAG
                {
                    let spk = self.spk.pop_front()?;
                    let mic = Self::get_silence(spk.len());
                    return Some((mic, spk));
                }
            }
        }

        None
    }
}

pub struct AmplitudeInfo {
    pub mic_level: f32,
    pub spk_level: f32,
}

pub struct Pipeline {
    joiner: Joiner,
    mode: ChannelMode,
    mic_resampler: FrameResampler,
    spk_resampler: FrameResampler,
    vad: Option<Box<dyn VoiceActivityDetector>>,
    accumulated_mic: Vec<f32>,
    accumulated_spk: Vec<f32>,
    mic_smoothed: f32,
    spk_smoothed: f32,
    last_amplitude_emit: Instant,
}

impl Pipeline {
    const SMOOTHING_ALPHA: f32 = 0.7;
    const MIN_DB: f32 = -60.0;
    const MAX_DB: f32 = 0.0;

    pub fn new(
        mic_sample_rate: u32,
        spk_sample_rate: u32,
        vad: Option<Box<dyn VoiceActivityDetector>>,
        mode: ChannelMode,
    ) -> Self {
        Self {
            joiner: Joiner::new(),
            mode,
            mic_resampler: FrameResampler::new(
                mic_sample_rate as usize,
                WHISPER_SAMPLE_RATE as usize,
                Duration::from_millis(30),
            ),
            spk_resampler: FrameResampler::new(
                spk_sample_rate as usize,
                WHISPER_SAMPLE_RATE as usize,
                Duration::from_millis(30),
            ),
            vad,
            accumulated_mic: Vec::new(),
            accumulated_spk: Vec::new(),
            mic_smoothed: 0.0,
            spk_smoothed: 0.0,
            last_amplitude_emit: Instant::now() - AMPLITUDE_THROTTLE,
        }
    }

    pub fn push_mic_samples(&mut self, raw: &[f32]) {
        let joiner = &mut self.joiner;
        self.mic_resampler.push(raw, &mut |frame: &[f32]| {
            joiner.push_mic(frame.to_vec());
        });
    }

    pub fn push_spk_samples(&mut self, raw: &[f32]) {
        let joiner = &mut self.joiner;
        self.spk_resampler.push(raw, &mut |frame: &[f32]| {
            joiner.push_spk(frame.to_vec());
        });
    }

    pub fn flush(&mut self) -> Vec<AudioPair> {
        let mut pairs = Vec::new();
        while let Some(pair) = self.joiner.pop_pair(self.mode) {
            pairs.push(pair);
        }
        pairs
    }

    pub fn process_pairs(&mut self, pairs: Vec<AudioPair>) {
        for (mic, spk) in pairs {
            let processed_mic = self.apply_vad(mic);
            self.accumulated_mic.extend_from_slice(&processed_mic);
            self.accumulated_spk.extend_from_slice(&spk);

            self.observe_amplitude(&processed_mic, &spk);
        }
    }

    fn apply_vad(&mut self, mic: Vec<f32>) -> Vec<f32> {
        if let Some(vad) = &mut self.vad {
            match vad.push_frame(&mic) {
                Ok(VadFrame::Speech(buf)) => buf.to_vec(),
                Ok(VadFrame::Noise) => vec![0.0; mic.len()],
                Err(_) => mic,
            }
        } else {
            mic
        }
    }

    fn observe_amplitude(&mut self, mic: &[f32], spk: &[f32]) {
        let mic_amp = Self::amplitude_from_chunk(mic);
        self.mic_smoothed =
            (1.0 - Self::SMOOTHING_ALPHA) * self.mic_smoothed + Self::SMOOTHING_ALPHA * mic_amp;

        let spk_amp = Self::amplitude_from_chunk(spk);
        self.spk_smoothed =
            (1.0 - Self::SMOOTHING_ALPHA) * self.spk_smoothed + Self::SMOOTHING_ALPHA * spk_amp;
    }

    pub fn get_amplitude(&mut self) -> Option<AmplitudeInfo> {
        if self.last_amplitude_emit.elapsed() < AMPLITUDE_THROTTLE {
            return None;
        }
        self.last_amplitude_emit = Instant::now();
        Some(AmplitudeInfo {
            mic_level: self.mic_smoothed,
            spk_level: self.spk_smoothed,
        })
    }

    pub fn take_accumulated(&mut self, min_samples: usize) -> Option<(Vec<f32>, Vec<f32>)> {
        if self.accumulated_mic.len() >= min_samples {
            let mic = std::mem::take(&mut self.accumulated_mic);
            let spk = std::mem::take(&mut self.accumulated_spk);
            Some((mic, spk))
        } else {
            None
        }
    }

    pub fn take_all_accumulated(&mut self) -> (Vec<f32>, Vec<f32>) {
        let mic = std::mem::take(&mut self.accumulated_mic);
        let spk = std::mem::take(&mut self.accumulated_spk);
        (mic, spk)
    }

    pub fn reset(&mut self) {
        self.joiner.reset();
        self.accumulated_mic.clear();
        self.accumulated_spk.clear();
        self.mic_smoothed = 0.0;
        self.spk_smoothed = 0.0;
        if let Some(vad) = &mut self.vad {
            vad.reset();
        }
    }

    fn amplitude_from_chunk(chunk: &[f32]) -> f32 {
        if chunk.is_empty() {
            return 0.0;
        }

        let sum_squares: f32 = chunk.iter().filter(|x| x.is_finite()).map(|&x| x * x).sum();
        let count = chunk.iter().filter(|x| x.is_finite()).count();
        if count == 0 {
            return 0.0;
        }
        let rms = (sum_squares / count as f32).sqrt();

        let db = if rms > 0.0 {
            20.0 * rms.log10()
        } else {
            Self::MIN_DB
        };

        ((db - Self::MIN_DB) / (Self::MAX_DB - Self::MIN_DB)).clamp(0.0, 1.0)
    }
}
