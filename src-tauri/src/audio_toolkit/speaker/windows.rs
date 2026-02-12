//! WASAPI loopback capture for Windows speaker audio
//!
//! This module captures system audio output (speaker/headphone audio) using
//! Windows Audio Session API (WASAPI) loopback mode.

use std::collections::VecDeque;
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

use wasapi::{Direction, SampleType, ShareMode};

use super::{BUFFER_SIZE, CHUNK_SIZE};

/// Represents a speaker input device that can be used to capture system audio
pub struct SpeakerInput {
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

        // Get the default render device to query sample rate
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

        Ok(Self { sample_rate })
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
    mut producer: HeapProd<f32>,
    waker: Arc<AtomicWaker>,
    current_sample_rate: Arc<AtomicU32>,
    dropped_samples: Arc<AtomicUsize>,
    shutdown: Arc<AtomicBool>,
) -> Result<()> {
    // Initialize COM for this thread
    wasapi::initialize_mta().ok();

    // Get the default render device (for loopback capture)
    let device = wasapi::get_default_device(&Direction::Render)
        .map_err(|e| anyhow!("Failed to get default render device: {:?}", e))?;

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
    let block_align = mix_format.get_blockalign() as usize;

    current_sample_rate.store(sample_rate, Ordering::Release);

    // Determine if format is float
    let is_float = mix_format
        .get_subformat()
        .map(|t| t == SampleType::Float)
        .unwrap_or(false);

    log::info!(
        "Capture format: {}Hz, {} channels, {} bits, float={}, block_align={}",
        sample_rate,
        channels,
        bits_per_sample,
        is_float,
        block_align
    );

    // Get device period for buffer size
    let (def_time, _min_time) = client
        .get_device_period()
        .map_err(|e| anyhow!("Failed to get device period: {:?}", e))?;

    log::debug!("Device period: default={}00ns", def_time);

    // Initialize in shared loopback mode
    // By getting a Render device and initializing with Capture direction,
    // WASAPI automatically enables loopback capture
    // Parameters: (format, period, direction, sharemode, autoconvert)
    client
        .initialize_client(
            &mix_format,
            def_time,
            &Direction::Capture,
            &ShareMode::Shared,
            true, // autoconvert
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

    // Buffer for raw audio data
    let mut sample_queue: VecDeque<u8> = VecDeque::with_capacity(block_align * 4096);

    // Capture loop
    while !shutdown.load(Ordering::Acquire) {
        // Wait for audio data (timeout 100ms)
        if event.wait_for_event(100).is_err() {
            continue;
        }

        // Read available data into queue
        match capture_client.read_from_device_to_deque(&mut sample_queue) {
            Ok(_buffer_info) => {
                // Convert raw bytes to mono f32 samples
                let mono_samples =
                    convert_bytes_to_mono_f32(&sample_queue, channels, bits_per_sample, is_float);

                // Clear the queue after processing
                sample_queue.clear();

                if !mono_samples.is_empty() {
                    let pushed = producer.push_slice(&mono_samples);
                    if pushed < mono_samples.len() {
                        dropped_samples.fetch_add(mono_samples.len() - pushed, Ordering::Relaxed);
                    }
                    if pushed > 0 {
                        waker.wake();
                    }
                }
            }
            Err(e) => {
                log::warn!("Capture read error: {:?}", e);
            }
        }
    }

    // Stop and clean up
    client.stop_stream().ok();
    log::info!("WASAPI loopback capture stopped");

    Ok(())
}

/// Convert raw interleaved bytes to mono f32 samples
fn convert_bytes_to_mono_f32(
    data: &VecDeque<u8>,
    channels: usize,
    bits_per_sample: u16,
    is_float: bool,
) -> Vec<f32> {
    if data.is_empty() {
        return Vec::new();
    }

    let bytes_per_sample = (bits_per_sample / 8) as usize;
    let frame_size = bytes_per_sample * channels;

    if data.len() < frame_size {
        return Vec::new();
    }

    let frame_count = data.len() / frame_size;
    let mut mono = Vec::with_capacity(frame_count);

    // Convert VecDeque to contiguous slice for easier processing
    let (front, back) = data.as_slices();
    let mut all_data = Vec::with_capacity(data.len());
    all_data.extend_from_slice(front);
    all_data.extend_from_slice(back);

    for frame_idx in 0..frame_count {
        let frame_offset = frame_idx * frame_size;
        let mut sum = 0.0f32;

        for ch in 0..channels {
            let sample_offset = frame_offset + ch * bytes_per_sample;

            let sample = if is_float && bits_per_sample == 32 {
                // 32-bit float
                if sample_offset + 4 <= all_data.len() {
                    let bytes = [
                        all_data[sample_offset],
                        all_data[sample_offset + 1],
                        all_data[sample_offset + 2],
                        all_data[sample_offset + 3],
                    ];
                    f32::from_le_bytes(bytes)
                } else {
                    0.0
                }
            } else if bits_per_sample == 16 {
                // 16-bit PCM
                if sample_offset + 2 <= all_data.len() {
                    let bytes = [all_data[sample_offset], all_data[sample_offset + 1]];
                    let i16_val = i16::from_le_bytes(bytes);
                    i16_val as f32 / 32768.0
                } else {
                    0.0
                }
            } else if bits_per_sample == 32 && !is_float {
                // 32-bit PCM integer
                if sample_offset + 4 <= all_data.len() {
                    let bytes = [
                        all_data[sample_offset],
                        all_data[sample_offset + 1],
                        all_data[sample_offset + 2],
                        all_data[sample_offset + 3],
                    ];
                    let i32_val = i32::from_le_bytes(bytes);
                    i32_val as f32 / 2147483648.0
                } else {
                    0.0
                }
            } else if bits_per_sample == 24 {
                // 24-bit PCM (sign-extend to 32-bit)
                if sample_offset + 3 <= all_data.len() {
                    let i24 = (all_data[sample_offset] as i32)
                        | ((all_data[sample_offset + 1] as i32) << 8)
                        | ((all_data[sample_offset + 2] as i32) << 16);
                    // Sign extend from 24 to 32 bits
                    let i24 = if i24 & 0x800000 != 0 {
                        i24 | 0xFF000000u32 as i32
                    } else {
                        i24
                    };
                    i24 as f32 / 8388608.0
                } else {
                    0.0
                }
            } else {
                // Fallback: assume 32-bit float
                if sample_offset + 4 <= all_data.len() {
                    let bytes = [
                        all_data[sample_offset],
                        all_data[sample_offset + 1],
                        all_data[sample_offset + 2],
                        all_data[sample_offset + 3],
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
