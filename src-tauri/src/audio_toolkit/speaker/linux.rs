//! PulseAudio monitor source capture for Linux speaker audio
//!
//! This module captures system audio output (speaker/headphone audio) using
//! PulseAudio's monitor source mechanism. Works on both native PulseAudio
//! and PipeWire (via pipewire-pulse compatibility).

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

use libpulse_binding as pulse;
use libpulse_simple_binding as psimple;

use super::{BUFFER_SIZE, CHUNK_SIZE};

/// Represents a speaker input device that can be used to capture system audio
pub struct SpeakerInput {
    monitor_source_name: String,
    sample_rate: u32,
    channels: u8,
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

/// Helper to iterate the mainloop until an operation completes
fn wait_for_operation<F: ?Sized>(
    mainloop: &mut pulse::mainloop::standard::Mainloop,
    op: &pulse::operation::Operation<F>,
) -> Result<()> {
    while op.get_state() == pulse::operation::State::Running {
        match mainloop.iterate(true) {
            pulse::mainloop::standard::IterateResult::Quit(_)
            | pulse::mainloop::standard::IterateResult::Err(_) => {
                return Err(anyhow!("PulseAudio mainloop iteration failed"));
            }
            pulse::mainloop::standard::IterateResult::Success(_) => {}
        }
    }
    Ok(())
}

impl SpeakerInput {
    /// Create a new speaker input by querying PulseAudio for the default sink's monitor source
    pub fn new() -> Result<Self> {
        let mut mainloop = pulse::mainloop::standard::Mainloop::new()
            .ok_or_else(|| anyhow!("Failed to create PulseAudio mainloop"))?;

        let mut context =
            pulse::context::Context::new(&mainloop, "talky-speaker-query")
                .ok_or_else(|| anyhow!("Failed to create PulseAudio context"))?;

        context
            .connect(None, pulse::context::FlagSet::NOFLAGS, None)
            .map_err(|e| anyhow!("PulseAudio connect failed: {:?}", e))?;

        // Wait for context to be ready
        loop {
            match mainloop.iterate(true) {
                pulse::mainloop::standard::IterateResult::Quit(_)
                | pulse::mainloop::standard::IterateResult::Err(_) => {
                    return Err(anyhow!("PulseAudio mainloop iteration failed"));
                }
                pulse::mainloop::standard::IterateResult::Success(_) => {}
            }
            match context.get_state() {
                pulse::context::State::Ready => break,
                pulse::context::State::Failed | pulse::context::State::Terminated => {
                    return Err(anyhow!("PulseAudio context connection failed"));
                }
                _ => {}
            }
        }

        // Query default sink name via server info
        let sink_name_result: Arc<std::sync::Mutex<Option<String>>> =
            Arc::new(std::sync::Mutex::new(None));
        let sink_name_clone = sink_name_result.clone();

        let op = context.introspect().get_server_info(move |info| {
            if let Some(ref name) = info.default_sink_name {
                *sink_name_clone.lock().unwrap() = Some(name.to_string());
            }
        });

        wait_for_operation(&mut mainloop, &op)?;

        let default_sink = sink_name_result
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| anyhow!("No default PulseAudio sink found"))?;

        log::info!("PulseAudio default sink: {}", default_sink);

        // Query sink info to get monitor source name and sample rate
        let sink_details: Arc<std::sync::Mutex<Option<(String, u32, u8)>>> =
            Arc::new(std::sync::Mutex::new(None));
        let details_clone = sink_details.clone();

        let op = context
            .introspect()
            .get_sink_info_by_name(&default_sink, move |result| {
                if let pulse::callbacks::ListResult::Item(info) = result {
                    if let Some(ref monitor_name) = info.monitor_source_name {
                        *details_clone.lock().unwrap() = Some((
                            monitor_name.to_string(),
                            info.sample_spec.rate,
                            info.sample_spec.channels,
                        ));
                    }
                }
            });

        wait_for_operation(&mut mainloop, &op)?;

        context.disconnect();

        let (monitor_source_name, sample_rate, channels) = sink_details
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| anyhow!("Failed to get sink details for '{}'", default_sink))?;

        log::info!(
            "Linux speaker input initialized: monitor_source={}, sample_rate={}Hz, channels={}",
            monitor_source_name,
            sample_rate,
            channels,
        );

        Ok(Self {
            monitor_source_name,
            sample_rate,
            channels,
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
        let dropped_clone = dropped_samples.clone();
        let shutdown_clone = shutdown.clone();

        log::info!(
            "Starting speaker capture stream (source={}, sample_rate={}Hz, channels={})",
            self.monitor_source_name,
            self.sample_rate,
            self.channels,
        );

        let monitor_source = self.monitor_source_name;
        let sample_rate = self.sample_rate;
        let channels = self.channels;

        let capture_thread = std::thread::spawn(move || {
            if let Err(e) = run_capture_loop(
                &monitor_source,
                sample_rate,
                channels,
                producer,
                waker_clone,
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
    monitor_source: &str,
    sample_rate: u32,
    channels: u8,
    mut producer: HeapProd<f32>,
    waker: Arc<AtomicWaker>,
    dropped_samples: Arc<AtomicUsize>,
    shutdown: Arc<AtomicBool>,
) -> Result<()> {
    // Request f32 native-endian so PulseAudio handles format conversion
    let spec = pulse::sample::Spec {
        format: pulse::sample::Format::FLOAT32NE,
        rate: sample_rate,
        channels,
    };

    if !spec.is_valid() {
        return Err(anyhow!(
            "Invalid PulseAudio sample spec: rate={}, channels={}",
            sample_rate,
            channels
        ));
    }

    // Target ~20ms fragments for low latency
    let bytes_per_frame = channels as u32 * 4; // 4 bytes per f32
    let frag_frames = sample_rate / 50; // ~20ms
    let fragsize = frag_frames * bytes_per_frame;

    let buffer_attr = pulse::def::BufferAttr {
        maxlength: u32::MAX,
        tlength: u32::MAX,
        prebuf: u32::MAX,
        minreq: u32::MAX,
        fragsize,
    };

    let simple = psimple::Simple::new(
        None,
        "Talky",
        pulse::stream::Direction::Record,
        Some(monitor_source),
        "Speaker Capture",
        &spec,
        None,
        Some(&buffer_attr),
    )
    .map_err(|e| {
        anyhow!(
            "Failed to open PulseAudio monitor source '{}': {:?}",
            monitor_source,
            e
        )
    })?;

    log::info!(
        "PulseAudio Simple recording opened on '{}' ({}Hz, {} ch, f32, fragsize={})",
        monitor_source,
        sample_rate,
        channels,
        fragsize,
    );

    let read_frames = frag_frames as usize;
    let read_samples = read_frames * channels as usize;
    let mut read_buf = vec![0.0f32; read_samples];
    let byte_len = read_samples * std::mem::size_of::<f32>();
    let mut mono_buf = Vec::with_capacity(read_frames);

    while !shutdown.load(Ordering::Acquire) {
        // Reinterpret f32 buffer as bytes for the PulseAudio read call.
        // Safe because we requested FLOAT32NE format and the sizes match exactly.
        let byte_slice = unsafe {
            std::slice::from_raw_parts_mut(read_buf.as_mut_ptr() as *mut u8, byte_len)
        };

        if let Err(e) = simple.read(byte_slice) {
            log::warn!("PulseAudio read error: {:?}", e);
            std::thread::sleep(std::time::Duration::from_millis(10));
            continue;
        }

        // Downmix interleaved multi-channel f32 to mono
        mono_buf.clear();
        for frame in read_buf.chunks_exact(channels as usize) {
            let sum: f32 = frame.iter().sum();
            mono_buf.push(sum / channels as f32);
        }

        if !mono_buf.is_empty() {
            let pushed = producer.push_slice(&mono_buf);
            if pushed < mono_buf.len() {
                dropped_samples.fetch_add(mono_buf.len() - pushed, Ordering::Relaxed);
            }
            if pushed > 0 {
                waker.wake();
            }
        }
    }

    log::info!("PulseAudio monitor capture stopped");
    Ok(())
}

impl Stream for SpeakerStream {
    type Item = Vec<f32>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();

        let dropped = this.dropped_samples.swap(0, Ordering::Relaxed);
        if dropped > 0 {
            log::warn!("Speaker samples dropped: {}", dropped);
        }

        let popped = this.consumer.pop_slice(&mut this.read_buffer);
        if popped > 0 {
            return Poll::Ready(Some(this.read_buffer[..popped].to_vec()));
        }

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
