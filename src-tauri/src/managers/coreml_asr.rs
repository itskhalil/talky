//! Rust client for the `talky-coreml-asr` Swift sidecar.
//!
//! Speaks a length-prefixed binary framing protocol over stdio:
//! each frame is `[4-byte BE header length][JSON header][optional raw body]`.
//! Responses are `[4-byte BE length][JSON]`.
//!
//! Most ops (`transcribe`, `shutdown`) are single-frame request/response.
//! `load` can be multi-frame: when called with `progress: true` the sidecar
//! streams `event: "progress"` frames ahead of the terminal `event: "loaded"`
//! (or `ok: false` on failure). `load_streaming` handles that; `load` keeps
//! the single-frame shape for callers that don't care about progress.
//!
//! macOS-only. On other platforms this module is absent.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::error_events::{self, ErrorKind};
use tauri::AppHandle;

/// Progress frame shape emitted by the sidecar during `load(progress: true)`.
/// Mirrors FluidAudio's `DownloadProgress` / `DownloadPhase`.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CoreMlDownloadProgress {
    pub fraction: f64,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub completed_files: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub total_files: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model_name: Option<String>,
}

pub struct CoreMlAsr {
    child: Arc<Mutex<Option<Child>>>,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    dead: Arc<AtomicBool>,
    _watcher: Option<JoinHandle<()>>,
}

impl CoreMlAsr {
    /// Spawn the sidecar. When `app` is provided, a watcher thread records a
    /// `SidecarCrashed` error event if the process exits unexpectedly — so
    /// the banner surfaces the crash even if no transcription was in flight.
    /// `replay` and other dev tooling can pass `None`.
    pub fn spawn(binary_path: &Path, app: Option<AppHandle>) -> Result<Self> {
        if !binary_path.exists() {
            bail!(
                "coreml-asr sidecar not found at {} — build it with `swift build -c release` in src-tauri/coreml-asr/",
                binary_path.display()
            );
        }

        let mut child = Command::new(binary_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("spawning {}", binary_path.display()))?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow!("missing stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("missing stdout"))?;

        // Forward sidecar stderr at warn so it lands in the default info-level
        // file log. Crashes are the whole reason we keep this around — debug
        // would drop them.
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let reader = std::io::BufReader::new(stderr);
                use std::io::BufRead;
                for line in reader.lines().map_while(Result::ok) {
                    log::warn!("[coreml-asr] {}", line);
                }
            });
        }

        let dead = Arc::new(AtomicBool::new(false));
        let child_arc = Arc::new(Mutex::new(Some(child)));
        let watcher = spawn_death_watcher(child_arc.clone(), dead.clone(), app);

        Ok(Self {
            child: child_arc,
            stdin,
            stdout: BufReader::new(stdout),
            dead,
            _watcher: Some(watcher),
        })
    }

    /// Whether the sidecar has exited (seen by the watcher). Callers should
    /// check this before invoking `transcribe` to avoid blocking on a dead
    /// stdin write that will surface as a broken-pipe error.
    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Acquire)
    }

    /// Load the model without progress streaming. Single-frame response
    /// (matches the pre-v0.13 protocol).
    pub fn load(&mut self, version: &str) -> Result<()> {
        self.send_header(&json!({ "op": "load", "version": version }), None)?;
        let resp = self.recv()?;
        if resp.get("ok").and_then(Value::as_bool) != Some(true) {
            bail!(
                "load failed: {}",
                resp.get("error").and_then(Value::as_str).unwrap_or("unknown")
            );
        }
        Ok(())
    }

    /// Load the model with progress streaming. Callback is invoked on every
    /// `event: "progress"` frame; the call returns when a terminal frame
    /// (`event: "loaded"` or `ok: false`) arrives.
    pub fn load_streaming(
        &mut self,
        version: &str,
        mut on_progress: impl FnMut(CoreMlDownloadProgress),
    ) -> Result<()> {
        self.send_header(
            &json!({ "op": "load", "version": version, "progress": true }),
            None,
        )?;
        loop {
            let resp = self.recv()?;
            let ok = resp.get("ok").and_then(Value::as_bool).unwrap_or(false);
            if !ok {
                bail!(
                    "load failed: {}",
                    resp.get("error").and_then(Value::as_str).unwrap_or("unknown")
                );
            }
            let event = resp.get("event").and_then(Value::as_str).unwrap_or("");
            match event {
                "progress" => {
                    if let Ok(p) = serde_json::from_value::<CoreMlDownloadProgress>(resp) {
                        on_progress(p);
                    }
                }
                "loaded" => return Ok(()),
                other => bail!("unexpected load frame: event={}", other),
            }
        }
    }

    /// Transcribe 16 kHz mono f32 samples. Returns `(text, infer_ms)` where
    /// `infer_ms` is the sidecar's own wall-clock measurement of the call.
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<(String, f64)> {
        if self.is_dead() {
            bail!("sidecar_dead");
        }
        let header = json!({
            "op": "transcribe",
            "sample_rate": 16000,
            "len": samples.len(),
        });
        // macOS is always little-endian (x86_64 and aarch64), so the f32
        // in-memory representation already matches the sidecar's LE protocol.
        let body = unsafe {
            std::slice::from_raw_parts(
                samples.as_ptr() as *const u8,
                std::mem::size_of_val(samples),
            )
        };
        self.send_header(&header, Some(body))?;
        let resp = self.recv()?;
        if resp.get("ok").and_then(Value::as_bool) != Some(true) {
            bail!(
                "transcribe failed: {}",
                resp.get("error").and_then(Value::as_str).unwrap_or("unknown")
            );
        }
        let text = resp
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let infer_ms = resp.get("infer_ms").and_then(Value::as_f64).unwrap_or(0.0);
        Ok((text, infer_ms))
    }

    fn send_header(&mut self, header: &Value, body: Option<&[u8]>) -> Result<()> {
        let header_bytes = serde_json::to_vec(header)?;
        let header_len = u32::try_from(header_bytes.len())
            .map_err(|_| anyhow!("header too large"))?;
        self.stdin.write_all(&header_len.to_be_bytes())?;
        self.stdin.write_all(&header_bytes)?;
        if let Some(b) = body {
            self.stdin.write_all(b)?;
        }
        self.stdin.flush()?;
        Ok(())
    }

    fn recv(&mut self) -> Result<Value> {
        let mut len_buf = [0u8; 4];
        self.stdout
            .read_exact(&mut len_buf)
            .context("reading response length (sidecar may have exited)")?;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len == 0 || len > 1 << 20 {
            bail!("invalid response length: {}", len);
        }
        let mut buf = vec![0u8; len];
        self.stdout.read_exact(&mut buf)?;
        serde_json::from_slice(&buf).map_err(|e| anyhow!("parse response: {}", e))
    }
}

impl Drop for CoreMlAsr {
    fn drop(&mut self) {
        // Suppress the watcher's "unexpected exit" bookkeeping: graceful
        // shutdown is expected, not a crash.
        self.dead.store(true, Ordering::Release);

        // Best-effort graceful shutdown, then kill if it lingers.
        let _ = self.send_header(&json!({ "op": "shutdown" }), None);

        let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let Some(mut child) = guard.take() else {
            return;
        };
        drop(guard);

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(25)),
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn spawn_death_watcher(
    child: Arc<Mutex<Option<Child>>>,
    dead: Arc<AtomicBool>,
    app: Option<AppHandle>,
) -> JoinHandle<()> {
    thread::spawn(move || loop {
        if dead.load(Ordering::Acquire) {
            // Either Drop flipped it (graceful) or we already recorded a crash.
            return;
        }
        {
            let mut guard = match child.lock() {
                Ok(g) => g,
                Err(e) => e.into_inner(),
            };
            let Some(c) = guard.as_mut() else {
                // Drop already took the child; nothing left to watch.
                return;
            };
            match c.try_wait() {
                Ok(Some(_status)) => {
                    if dead
                        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                    {
                        log::warn!("[coreml-asr] sidecar exited unexpectedly");
                        drop(guard);
                        if let Some(app) = app.as_ref() {
                            error_events::record(
                                app,
                                ErrorKind::SidecarCrashed,
                                "Core ML engine crashed",
                                "The transcription sidecar exited unexpectedly. Talky will try to recover automatically.",
                            );
                        }
                    }
                    return;
                }
                Ok(None) => { /* still alive */ }
                Err(e) => {
                    log::warn!("[coreml-asr] watcher try_wait error: {}", e);
                    return;
                }
            }
        }
        thread::sleep(Duration::from_millis(500));
    })
}

/// Locate the sidecar binary.
///
/// Resolution order:
/// 1. `TALKY_COREML_ASR_BIN` env var (absolute path).
/// 2. Next to the current executable: `$EXE_DIR/talky-coreml-asr` (how Tauri
///    lays out `externalBin` sidecars in the bundled app).
/// 3. Dev fallback: `$CARGO_MANIFEST_DIR/coreml-asr/.build/release/talky-coreml-asr`
///    so `cargo run --bin replay` works without bundling.
pub fn find_sidecar_binary() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("TALKY_COREML_ASR_BIN") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Ok(path);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("talky-coreml-asr");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("coreml-asr/.build/release/talky-coreml-asr");
    if dev.exists() {
        return Ok(dev);
    }

    bail!(
        "coreml-asr sidecar not found. Set TALKY_COREML_ASR_BIN, or build it with \
         `cd src-tauri/coreml-asr && swift build -c release`"
    )
}
