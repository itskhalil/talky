---
name: replay
description: |
  Offline CLI for replaying debug recordings through the audio pipeline for testing and parameter tuning.
  Use this skill whenever working with the replay tool, debug recordings, the AMI eval set, WER scoring,
  parameter sweeps, or audio pipeline tuning. Also use when building, running, or debugging the replay binary.
---

# Replay Tool

Offline CLI (`src-tauri/src/bin/replay.rs`) that re-runs recordings through `SessionTranscriber`
(`src-tauri/src/audio_toolkit/session_transcriber.rs`), the same code the live app runs. Core logic
lives in `src-tauri/src/replay/` (engine, recording, runner, scoring, types).

## Building

The replay binary links against whisper-rs-sys which needs the clang runtime library path on macOS.
`TALKY_SUPPORT_EMAIL` must be set at compile time (the main checkout keeps it in the untracked
`src-tauri/.cargo/config.toml`):

```bash
cd src-tauri && TALKY_SUPPORT_EMAIL=support@example.com \
  LIBRARY_PATH="/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang/21/lib/darwin" \
  cargo build --release --bin replay
```

For quick iteration, override the release profile's LTO:
`CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 CARGO_PROFILE_RELEASE_INCREMENTAL=true`.

## Environment

The ONNX runtime must be on the dylib path at runtime:

```bash
export DYLD_LIBRARY_PATH="$(ls -d ~/Library/Caches/ort.pyke.io/dfbin/aarch64-apple-darwin/*/onnxruntime/lib | head -1)"
MODEL="$HOME/Library/Application Support/com.khalil.talky/models/parakeet-tdt-0.6b-v3-int8"
VAD="src-tauri/resources/models/silero_vad_v4.onnx"
RECORDINGS_DIR="$HOME/Library/Application Support/com.khalil.talky/debug_recordings"
```

Engines: `parakeet` (ONNX, needs `-m`), `coreml` (v3 via the Swift sidecar), `coreml-ultra`, `coreml-v2`.
The sidecar is found via `TALKY_COREML_ASR_BIN`, next to the binary, or in `src-tauri/coreml-asr/.build/release/`.

## Subcommands

### session

Replay a recording through the live pipeline. Audio is fed in 250 ms ticks like the live loop.

```bash
./target/release/replay session -r "$RECORDINGS_DIR/<id>" -e parakeet -m "$MODEL" --vad-model "$VAD" -o out.json
# TranscriberConfig overrides as JSON (see the struct for every field)
./target/release/replay session ... --config '{"hangover_frames":25,"aec":false}'
# Simulate live delivery: system audio leading its echo by 150 ms, arriving in 500 ms bursts
./target/release/replay session ... --spk-lead-ms 150 --spk-burst-ms 500
# Score against golden.json in the recording directory
./target/release/replay session ... --compare
```

Output segments carry `emitted_ms` (when the segment was produced) alongside `start_ms`/`end_ms` (where the
speech is).

### transcribe-raw

Golden transcript drafts: transcribes each channel independently in large chunks, with AEC on the mic.
Output defaults to `<recording>/golden_draft.json`.

### transcribe

Transcribe any audio file (mp3, m4a, wav, flac, ogg) to text.

### aec-mic

Write the echo-cancelled mic channel as `mic_aec.wav` for listening.

## AMI eval set

`scripts/audio-eval/` builds two-channel cases with word-level ground truth from the AMI corpus and scores runs
(channel WER, my-words recall during overlap, echo leak, latency). See `scripts/audio-eval/README.md`. Data lives
in `~/.cache/talky-audio-eval/`, outside the repo.

```bash
cd ~/.cache/talky-audio-eval
venv/bin/python <repo>/scripts/audio-eval/run_eval.py NAME --engine coreml -- --config '{...}'
venv/bin/python <repo>/scripts/audio-eval/score.py --runs runs/A runs/B --per-case
```

## Recording Directory Structure

Debug recordings live outside the repo at `~/Library/Application Support/com.khalil.talky/debug_recordings/<uuid>/`.
They contain real meeting audio and transcripts: never commit them or anything derived from them.

```
<uuid>/
  metadata.json       # Transcriber config (v2) or legacy pipeline config (v1), transcript
  raw_mic.wav         # 16kHz mono 16-bit PCM
  raw_spk.wav         # 16kHz mono 16-bit PCM
  golden_draft.json   # Output of transcribe-raw
  golden.json         # Human-reviewed reference transcript
```
