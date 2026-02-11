//! WASAPI loopback capture for Windows speaker audio
//!
//! This module captures system audio output (speaker/headphone audio) using
//! Windows Audio Session API (WASAPI) loopback mode.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::Poll;

use anyhow::{anyhow, Result};
use futures_util::task::AtomicWaker;
use futures_util::Stream;

use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};

use wasapi::{AudioClient, Device, Direction, ShareMode, WasapiError};

use super::pcm::{pcm_f32_to_f32, pcm_i16_to_f32, pcm_i32_to_f32};
use super::{BUFFER_SIZE, CHUNK_SIZE};

/// Represents a speaker input device that can be used to capture system audio
pub struct SpeakerInput {
    device: Device,
    sample_rate: u32,
}

/// Active speaker capture stream
pub struct SpeakerStream {
    consumer: HeapCons<f32>,
    shutdown: Arc<AtomicBool>,
    _capture_thread: std::thread::JoinHandle<()>,
    waker: Arc<AtomicWaker>,
    current_sample_rate: Arc<AtomicU32>,
    read_buffer: Vec<f32>,
    dropped_samples: Arc<AtomicUsize>,
}

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        self.current_sample_rate.load(Ordering::Acquire)
    }
}

impl SpeakerInput {
    /// Create a new speaker input using the default render (output) device
    pub fn new() -> Result<Self> {
        // Initialize COM for this thread if not already done
        wasapi::initialize_mta().ok();

        // Get the default render device (speakers/headphones)
        let device = wasapi::get_default_device(&Direction::Render)
            .map_err(|e| anyhow!("Failed to get default render device: {:?}", e))?;

        // Get the device's mix format to determine sample rate
        let client = device
            .get_iaudioclient()
            .map_err(|e| anyhow!("Failed to get audio client: {:?}", e))?;

        let mix_format = client
            .get_mixformat()
            .map_err(|e| anyhow!("Failed to get mix format: {:?}", e))?;

        let sample_rate = mix_format.get_samplespersec();

        log::info!(
            "Windows speaker input initialized: device sample rate = {}Hz, channels = {}, bits = {}",
            sample_rate,
            mix_format.get_nchannels(),
            mix_format.get_bitspersample()
        );

        Ok(Self {
            device,
            sample_rate,
        })
    }

    /// Get the sample rate of the audio device
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Start capturing speaker audio and return a stream of audio samples
    pub fn stream(self) -> SpeakerStream {
        let rb = HeapRb::<f32>::new(BUFFER_SIZE);
        let (producer, consumer) = rb.split();

        let waker = Arc::new(AtomicWaker::new());
        let current_sample_rate = Arc::new(AtomicU32::new(self.sample_rate));
        let dropped_samples = Arc::new(AtomicUsize::new(0));
        let shutdown = Arc::new(AtomicBool::new(false));

        let waker_clone = waker.clone();
        let sample_rate_clone = current_sample_rate.clone();
        let dropped_clone = dropped_samples.clone();
        let shutdown_clone = shutdown.clone();

        log::info!(
            "Starting speaker capture stream (sample_rate={}Hz)",
            self.sample_rate
        );

        let capture_thread = std::thread::spawn(move || {
            if let Err(e) = run_capture_loop(
                self.device,
                producer,
                waker_clone,
                sample_rate_clone,
                dropped_clone,
                shutdown_clone,
            ) {
                log::error!("Speaker capture error: {}", e);
            }
            log::info!("Speaker capture thread exiting");
        });

        SpeakerStream {
            consumer,
            shutdown,
            _capture_thread: capture_thread,
            waker,
            current_sample_rate,
            read_buffer: vec![0.0f32; CHUNK_SIZE],
            dropped_samples,
        }
    }
}

/// Main capture loop running in a background thread
fn run_capture_loop(
    device: Device,
    mut producer: HeapProd<f32>,
    waker: Arc<AtomicWaker>,
    current_sample_rate: Arc<AtomicU32>,
    dropped_samples: Arc<AtomicUsize>,
    shutdown: Arc<AtomicBool>,
) -> Result<()> {
    // Initialize COM for this thread
    wasapi::initialize_mta().map_err(|e| anyhow!("Failed to initialize COM: {:?}", e))?;

    // Get audio client
    let mut client = device
        .get_iaudioclient()
        .map_err(|e| anyhow!("Failed to get audio client: {:?}", e))?;

    // Get the mix format (device's native format)
    let mix_format = client
        .get_mixformat()
        .map_err(|e| anyhow!("Failed to get mix format: {:?}", e))?;

    let sample_rate = mix_format.get_samplespersec();
    let channels = mix_format.get_nchannels() as usize;
    let bits_per_sample = mix_format.get_bitspersample();
    let sample_type = mix_format.get_subformat().map_err(|e| {
        anyhow!(
            "Failed to get sample format: {:?}. Using PCM float fallback.",
            e
        )
    });

    current_sample_rate.store(sample_rate, Ordering::Release);

    log::info!(
        "Capture format: {}Hz, {} channels, {} bits, format={:?}",
        sample_rate,
        channels,
        bits_per_sample,
        sample_type
    );

    // Initialize client in shared loopback mode
    // Buffer duration in 100-nanosecond units (20ms = 200000 * 100ns)
    let buffer_duration_100ns = 200_000i64;

    client
        .initialize_client(
            &mix_format,
            buffer_duration_100ns,
            &Direction::Capture,
            &ShareMode::Shared,
            true, // loopback mode
        )
        .map_err(|e| anyhow!("Failed to initialize loopback client: {:?}", e))?;

    // Create event handle for audio data
    let event = client
        .set_get_eventhandle()
        .map_err(|e| anyhow!("Failed to get event handle: {:?}", e))?;

    // Get capture client
    let capture_client = client
        .get_audiocaptureclient()
        .map_err(|e| anyhow!("Failed to get capture client: {:?}", e))?;

    // Start capturing
    client
        .start_stream()
        .map_err(|e| anyhow!("Failed to start stream: {:?}", e))?;

    log::info!("WASAPI loopback capture started");

    // Determine format for conversion
    let is_float = sample_type
        .as_ref()
        .map(|t| *t == wasapi::SampleType::Float)
        .unwrap_or(true);

    // Capture loop
    while !shutdown.load(Ordering::Acquire) {
        // Wait for audio data (timeout 100ms)
        if event.wait_for_event(100).is_err() {
            continue;
        }

        // Read available frames
        loop {
            match capture_client.read_from_device_to_deinterleaved(channels, false) {
                Ok(None) => break, // No more data available
                Ok(Some(data)) => {
                    // Convert to mono f32 and push to ring buffer
                    let mono_samples = convert_to_mono_f32(&data, is_float, bits_per_sample);

                    let pushed = producer.push_slice(&mono_samples);
                    if pushed < mono_samples.len() {
                        dropped_samples.fetch_add(mono_samples.len() - pushed, Ordering::Relaxed);
                    }
                    if pushed > 0 {
                        waker.wake();
                    }
                }
                Err(WasapiError::BufferEmpty) => break,
                Err(e) => {
                    log::warn!("Capture read error: {:?}", e);
                    break;
                }
            }
        }
    }

    // Stop and clean up
    client.stop_stream().ok();
    log::info!("WASAPI loopback capture stopped");

    Ok(())
}

/// Convert deinterleaved multi-channel audio to mono f32
fn convert_to_mono_f32(data: &[Vec<u8>], is_float: bool, bits_per_sample: u16) -> Vec<f32> {
    if data.is_empty() || data[0].is_empty() {
        return Vec::new();
    }

    let channels = data.len();

    // Determine sample count based on first channel
    let sample_count = match bits_per_sample {
        16 => data[0].len() / 2,
        24 => data[0].len() / 3,
        32 => data[0].len() / 4,
        _ => data[0].len() / 4, // Default to 32-bit
    };

    let mut mono = Vec::with_capacity(sample_count);

    for i in 0..sample_count {
        let mut sum = 0.0f32;

        for ch in 0..channels {
            let sample = if is_float && bits_per_sample == 32 {
                // 32-bit float
                let offset = i * 4;
                if offset + 4 <= data[ch].len() {
                    let bytes = [
                        data[ch][offset],
                        data[ch][offset + 1],
                        data[ch][offset + 2],
                        data[ch][offset + 3],
                    ];
                    pcm_f32_to_f32(f32::from_le_bytes(bytes))
                } else {
                    0.0
                }
            } else if bits_per_sample == 16 {
                // 16-bit PCM
                let offset = i * 2;
                if offset + 2 <= data[ch].len() {
                    let bytes = [data[ch][offset], data[ch][offset + 1]];
                    pcm_i16_to_f32(i16::from_le_bytes(bytes))
                } else {
                    0.0
                }
            } else if bits_per_sample == 32 && !is_float {
                // 32-bit PCM integer
                let offset = i * 4;
                if offset + 4 <= data[ch].len() {
                    let bytes = [
                        data[ch][offset],
                        data[ch][offset + 1],
                        data[ch][offset + 2],
                        data[ch][offset + 3],
                    ];
                    pcm_i32_to_f32(i32::from_le_bytes(bytes))
                } else {
                    0.0
                }
            } else if bits_per_sample == 24 {
                // 24-bit PCM (sign-extend to 32-bit)
                let offset = i * 3;
                if offset + 3 <= data[ch].len() {
                    let i24 = (data[ch][offset] as i32)
                        | ((data[ch][offset + 1] as i32) << 8)
                        | ((data[ch][offset + 2] as i32) << 16);
                    // Sign extend from 24 to 32 bits
                    let i24 = if i24 & 0x800000 != 0 {
                        i24 | 0xFF000000u32 as i32
                    } else {
                        i24
                    };
                    // Scale to [-1, 1]
                    i24 as f32 / 8388607.0
                } else {
                    0.0
                }
            } else {
                // Fallback: assume 32-bit float
                let offset = i * 4;
                if offset + 4 <= data[ch].len() {
                    let bytes = [
                        data[ch][offset],
                        data[ch][offset + 1],
                        data[ch][offset + 2],
                        data[ch][offset + 3],
                    ];
                    f32::from_le_bytes(bytes)
                } else {
                    0.0
                }
            };

            sum += sample;
        }

        // Average across channels for mono
        mono.push(sum / channels as f32);
    }

    mono
}

impl Stream for SpeakerStream {
    type Item = Vec<f32>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();

        // Log dropped samples
        let dropped = this.dropped_samples.swap(0, Ordering::Relaxed);
        if dropped > 0 {
            log::warn!("Speaker samples dropped: {}", dropped);
        }

        // Try to read from buffer
        let popped = this.consumer.pop_slice(&mut this.read_buffer);

        if popped > 0 {
            return Poll::Ready(Some(this.read_buffer[..popped].to_vec()));
        }

        // Register waker and try again
        this.waker.register(cx.waker());

        let popped = this.consumer.pop_slice(&mut this.read_buffer);
        if popped > 0 {
            return Poll::Ready(Some(this.read_buffer[..popped].to_vec()));
        }

        Poll::Pending
    }
}

impl Drop for SpeakerStream {
    fn drop(&mut self) {
        log::debug!("SpeakerStream dropping, signaling shutdown");
        self.shutdown.store(true, Ordering::Release);
    }
}
