use std::{
    io::Error,
    sync::{mpsc, Arc},
    time::Duration,
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, Sample, SizedSample,
};

use crate::audio_toolkit::{
    audio::{AudioVisualiser, FrameResampler},
    constants,
};

/// How often the consumer checks for commands when no audio arrives.
const COMMAND_POLL: Duration = Duration::from_millis(50);
/// Upper bound on waiting for the consumer to answer a command.
const REPLY_TIMEOUT: Duration = Duration::from_secs(2);

enum Cmd {
    Start,
    Stop(mpsc::Sender<Vec<f32>>),
    /// Take accumulated samples without stopping the stream (gap-free extraction)
    Take(mpsc::Sender<Vec<f32>>),
    Shutdown,
}

pub struct AudioRecorder {
    device: Option<Device>,
    cmd_tx: Option<mpsc::Sender<Cmd>>,
    worker_handle: Option<std::thread::JoinHandle<()>>,
    level_cb: Option<Arc<dyn Fn(Vec<f32>) + Send + Sync + 'static>>,
}

impl AudioRecorder {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        Ok(AudioRecorder {
            device: None,
            cmd_tx: None,
            worker_handle: None,
            level_cb: None,
        })
    }

    pub fn with_level_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(Vec<f32>) + Send + Sync + 'static,
    {
        self.level_cb = Some(Arc::new(cb));
        self
    }

    pub fn open(&mut self, device: Option<Device>) -> Result<(), Box<dyn std::error::Error>> {
        if self.worker_handle.is_some() {
            return Ok(()); // already open
        }

        let (sample_tx, sample_rx) = mpsc::channel::<Vec<f32>>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();

        let host = crate::audio_toolkit::get_cpal_host();
        let device = match device {
            Some(dev) => dev,
            None => host
                .default_input_device()
                .ok_or_else(|| Error::new(std::io::ErrorKind::NotFound, "No input device found"))?,
        };

        let thread_device = device.clone();
        // Move the optional level callback into the worker thread
        let level_cb = self.level_cb.clone();

        let worker = std::thread::spawn(move || {
            // Release builds abort on panic, so a device that vanishes between
            // enumeration and opening must not panic here: log and exit, and
            // callers get errors from the closed command channel instead.
            let config = match AudioRecorder::get_preferred_config(&thread_device) {
                Ok(config) => config,
                Err(e) => {
                    log::error!("Failed to fetch input config: {e}");
                    return;
                }
            };

            let sample_rate = config.sample_rate().0;
            let channels = config.channels() as usize;

            log::info!(
                "Using device: {:?}\nSample rate: {}\nChannels: {}\nFormat: {:?}",
                thread_device.name(),
                sample_rate,
                channels,
                config.sample_format()
            );

            let stream = match config.sample_format() {
                cpal::SampleFormat::U8 => {
                    AudioRecorder::build_stream::<u8>(&thread_device, &config, sample_tx, channels)
                }
                cpal::SampleFormat::I8 => {
                    AudioRecorder::build_stream::<i8>(&thread_device, &config, sample_tx, channels)
                }
                cpal::SampleFormat::I16 => {
                    AudioRecorder::build_stream::<i16>(&thread_device, &config, sample_tx, channels)
                }
                cpal::SampleFormat::I32 => {
                    AudioRecorder::build_stream::<i32>(&thread_device, &config, sample_tx, channels)
                }
                cpal::SampleFormat::F32 => {
                    AudioRecorder::build_stream::<f32>(&thread_device, &config, sample_tx, channels)
                }
                other => {
                    log::error!("Unsupported input sample format: {other:?}");
                    return;
                }
            };
            let stream = match stream {
                Ok(stream) => stream,
                Err(e) => {
                    log::error!("Failed to build input stream: {e}");
                    return;
                }
            };

            if let Err(e) = stream.play() {
                log::error!("Failed to start input stream: {e}");
                return;
            }

            // keep the stream alive while we process samples
            run_consumer(sample_rate, sample_rx, cmd_rx, level_cb);
            // stream is dropped here, after run_consumer returns
        });

        self.device = Some(device);
        self.cmd_tx = Some(cmd_tx);
        self.worker_handle = Some(worker);

        Ok(())
    }

    pub fn start(&self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(tx) = &self.cmd_tx {
            tx.send(Cmd::Start)?;
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let (resp_tx, resp_rx) = mpsc::channel();
        if let Some(tx) = &self.cmd_tx {
            tx.send(Cmd::Stop(resp_tx))?;
        } else {
            return Ok(Vec::new()); // already closed
        }
        Ok(resp_rx.recv_timeout(REPLY_TIMEOUT)?) // wait for the samples
    }

    /// Take accumulated samples without stopping the stream.
    /// This allows gap-free chunk extraction during continuous recording.
    pub fn take(&self) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let (resp_tx, resp_rx) = mpsc::channel();
        if let Some(tx) = &self.cmd_tx {
            tx.send(Cmd::Take(resp_tx))?;
        } else {
            return Ok(Vec::new()); // not recording
        }
        Ok(resp_rx.recv_timeout(REPLY_TIMEOUT)?)
    }

    pub fn close(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.send(Cmd::Shutdown);
        }
        if let Some(h) = self.worker_handle.take() {
            let _ = h.join();
        }
        self.device = None;
        Ok(())
    }

    fn build_stream<T>(
        device: &cpal::Device,
        config: &cpal::SupportedStreamConfig,
        sample_tx: mpsc::Sender<Vec<f32>>,
        channels: usize,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: Sample + SizedSample + Send + 'static,
        f32: cpal::FromSample<T>,
    {
        let mut output_buffer = Vec::new();

        let stream_cb = move |data: &[T], _: &cpal::InputCallbackInfo| {
            output_buffer.clear();

            if channels == 1 {
                // Direct conversion without intermediate Vec
                output_buffer.extend(data.iter().map(|&sample| sample.to_sample::<f32>()));
            } else {
                // Convert to mono directly
                let frame_count = data.len() / channels;
                output_buffer.reserve(frame_count);

                for frame in data.chunks_exact(channels) {
                    let mono_sample = frame
                        .iter()
                        .map(|&sample| sample.to_sample::<f32>())
                        .sum::<f32>()
                        / channels as f32;
                    output_buffer.push(mono_sample);
                }
            }

            if sample_tx.send(output_buffer.clone()).is_err() {
                log::error!("Failed to send samples");
            }
        };

        device.build_input_stream(
            &config.clone().into(),
            stream_cb,
            |err| log::error!("Stream error: {}", err),
            None,
        )
    }

    fn get_preferred_config(
        device: &cpal::Device,
    ) -> Result<cpal::SupportedStreamConfig, Box<dyn std::error::Error>> {
        // Use the device's native/default sample rate and let the FrameResampler
        // in run_consumer() downsample to 16kHz. Forcing hardware into a
        // non-native rate degrades some devices (Bluetooth codecs, certain ALSA
        // drivers, USB mics). Ported from Handy (#1084).
        let default_config = device.default_input_config()?;
        let target_rate = default_config.sample_rate();

        // Pick the best sample format at the device's default rate
        let supported_configs = match device.supported_input_configs() {
            Ok(configs) => configs,
            Err(e) => {
                log::warn!("Could not enumerate input configs ({e}), using device default");
                return Ok(default_config);
            }
        };
        let mut best_config: Option<cpal::SupportedStreamConfigRange> = None;

        for config_range in supported_configs {
            if config_range.min_sample_rate() <= target_rate
                && config_range.max_sample_rate() >= target_rate
            {
                match best_config {
                    None => best_config = Some(config_range),
                    Some(ref current) => {
                        // Prioritize F32 > I16 > I32 > others
                        let score = |fmt: cpal::SampleFormat| match fmt {
                            cpal::SampleFormat::F32 => 4,
                            cpal::SampleFormat::I16 => 3,
                            cpal::SampleFormat::I32 => 2,
                            _ => 1,
                        };

                        if score(config_range.sample_format()) > score(current.sample_format()) {
                            best_config = Some(config_range);
                        }
                    }
                }
            }
        }

        if let Some(config) = best_config {
            return Ok(config.with_sample_rate(target_rate));
        }

        // Fall back to device default if no config matched (exotic/virtual devices)
        log::warn!(
            "No supported config matched device default rate {:?}, using default config",
            target_rate
        );
        Ok(default_config)
    }
}

fn run_consumer(
    in_sample_rate: u32,
    sample_rx: mpsc::Receiver<Vec<f32>>,
    cmd_rx: mpsc::Receiver<Cmd>,
    level_cb: Option<Arc<dyn Fn(Vec<f32>) + Send + Sync + 'static>>,
) {
    let mut frame_resampler = FrameResampler::new(
        in_sample_rate as usize,
        constants::WHISPER_SAMPLE_RATE as usize,
        Duration::from_millis(30),
    );

    let mut processed_samples = Vec::<f32>::new();
    let mut recording = false;
    let mut stream_lost = false;

    // ---------- spectrum visualisation setup ---------------------------- //
    const BUCKETS: usize = 16;
    const WINDOW_SIZE: usize = 512;
    let mut visualizer = AudioVisualiser::new(
        in_sample_rate,
        WINDOW_SIZE,
        BUCKETS,
        400.0,  // vocal_min_hz
        4000.0, // vocal_max_hz
    );

    loop {
        // Wait for audio, but never so long that a command goes unanswered: if
        // the device stops delivering (unplugged, Bluetooth drop, sleep),
        // Stop and Take must still reply or the caller blocks forever.
        match sample_rx.recv_timeout(COMMAND_POLL) {
            Ok(raw) => {
                // ---------- spectrum processing ------------------------------ //
                if let Some(buckets) = visualizer.feed(&raw) {
                    if let Some(cb) = &level_cb {
                        cb(buckets);
                    }
                }

                // ---------- resample and accumulate ---------------------------- //
                // No VAD filtering here - we capture all audio and do VAD-based
                // segmentation in the pipeline instead to avoid double-VAD issues.
                frame_resampler.push(&raw, &mut |frame: &[f32]| {
                    if recording {
                        processed_samples.extend_from_slice(frame);
                    }
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // The stream is gone; keep answering commands until shutdown.
                if !stream_lost {
                    log::warn!("Microphone stream stopped delivering audio");
                    stream_lost = true;
                }
                std::thread::sleep(COMMAND_POLL);
            }
        }

        // non-blocking check for a command
        loop {
            let cmd = match cmd_rx.try_recv() {
                Ok(cmd) => cmd,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            };
            match cmd {
                Cmd::Start => {
                    processed_samples.clear();
                    // Drop audio buffered inside the resampler from before this
                    // recording so it can't leak into it.
                    frame_resampler.reset();
                    recording = true;
                    visualizer.reset(); // Reset visualization buffer
                }
                Cmd::Stop(reply_tx) => {
                    // Audio captured before the stop but not yet consumed
                    // belongs to this recording (Handy #838).
                    while let Ok(raw) = sample_rx.try_recv() {
                        frame_resampler.push(&raw, &mut |frame: &[f32]| {
                            if recording {
                                processed_samples.extend_from_slice(frame);
                            }
                        });
                    }
                    recording = false;

                    frame_resampler.finish(&mut |frame: &[f32]| {
                        // we still want to process the last few frames
                        processed_samples.extend_from_slice(frame);
                    });
                    frame_resampler.reset();

                    let _ = reply_tx.send(std::mem::take(&mut processed_samples));
                }
                Cmd::Take(reply_tx) => {
                    // Take accumulated samples without stopping - gap-free extraction
                    // Recording continues, we just extract what we have so far
                    if recording {
                        let _ = reply_tx.send(std::mem::take(&mut processed_samples));
                    } else {
                        let _ = reply_tx.send(Vec::new());
                    }
                }
                Cmd::Shutdown => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_keeps_audio_still_queued() {
        let (sample_tx, sample_rx) = mpsc::channel::<Vec<f32>>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();
        let worker = std::thread::spawn(move || run_consumer(16_000, sample_rx, cmd_rx, None));

        // Take's reply means Start has been handled.
        cmd_tx.send(Cmd::Start).unwrap();
        let (tx, rx) = mpsc::channel();
        cmd_tx.send(Cmd::Take(tx)).unwrap();
        rx.recv_timeout(REPLY_TIMEOUT).unwrap();

        // Queue a second of audio and stop before the consumer can drain it.
        for _ in 0..100 {
            sample_tx.send(vec![0.1; 160]).unwrap();
        }
        let (tx, rx) = mpsc::channel();
        cmd_tx.send(Cmd::Stop(tx)).unwrap();
        let samples = rx.recv_timeout(REPLY_TIMEOUT).unwrap();
        // The last 30 ms frame is zero-padded, so a little more comes back.
        assert!(samples.len() >= 16_000, "got {} samples", samples.len());

        cmd_tx.send(Cmd::Shutdown).unwrap();
        worker.join().unwrap();
    }
}
