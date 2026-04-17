---
name: replay
description: |
  Offline CLI for replaying debug recordings through the audio pipeline for testing and parameter tuning.
  Use this skill whenever working with the replay tool, debug recordings, golden transcripts, WER scoring,
  parameter sweeps, or audio pipeline tuning. Also use when building, running, or debugging the replay binary.
---

# Replay Tool

Offline CLI (`src-tauri/src/bin/replay.rs`) that re-runs the audio pipeline on debug recordings. Core logic lives in `src-tauri/src/replay/` (engine, recording, runner, scoring, sweep, types).

## Building

The replay binary links against whisper-rs-sys which needs the clang runtime library path on macOS:

```bash
cd src-tauri && LIBRARY_PATH="/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang/21/lib/darwin" cargo build --bin replay
```

## Environment

The ONNX runtime must be on the dylib path at runtime. Set these before running:

```bash
export DYLD_LIBRARY_PATH="/Users/khalil/Library/Caches/ort.pyke.io/dfbin/aarch64-apple-darwin/00FBFD6F08BAC2A4E28C66723AF900D58D1B4B1C73EFBA6290637CD3019883D5/onnxruntime/lib"
MODEL="/Users/khalil/Library/Application Support/com.khalil.talky/models/parakeet-tdt-0.6b-v3-int8"
VAD="src-tauri/resources/models/silero_vad_v4.onnx"
RECORDINGS_DIR="/Users/khalil/Library/Application Support/com.khalil.talky/debug_recordings"
```

## Subcommands

### transcribe-raw

Generate golden transcript drafts by transcribing each channel independently with large chunks. Applies AEC to the mic channel to remove speaker echo. Output defaults to `<recording>/golden_draft.json` (override with `-o`).

```bash
./target/debug/replay transcribe-raw -r "$RECORDINGS_DIR/<id>" -m "$MODEL" --chunk-size 480000
```

### run

Replay a recording through the full pipeline: VAD -> AEC -> speaker energy filtering -> transcription -> prefix overlap removal -> dedup. Output defaults to `<recording>/replay_output.json` (override with `-o`).

```bash
# Full replay with scoring against golden
./target/debug/replay run -r "$RECORDINGS_DIR/<id>" -m "$MODEL" --vad-model "$VAD" --compare

# Dry run (segment boundaries only, no model needed)
./target/debug/replay run -r "$RECORDINGS_DIR/<id>" --vad-model "$VAD" --dry-run
```

All 19 pipeline parameters are overridable via CLI flags (e.g. `--vad-threshold 0.4`).

### sweep

Cartesian product parameter sweep. Requires `golden.json` in the recording directory and a sweep config JSON defining parameter ranges. Output defaults to `<recording>/sweep_results.json` (override with `-o`). Results sorted by combined WER.

```bash
./target/debug/replay sweep -r "$RECORDINGS_DIR/<id>" -m "$MODEL" --vad-model "$VAD" --config sweep.json
```

Sweep config format:
```json
{
  "parameters": {
    "vad_threshold": [0.3, 0.4, 0.5],
    "speaker_energy_threshold": [0.01, 0.02, 0.05]
  }
}
```

## Tunable Parameters (19)

| Parameter | Description |
|-----------|-------------|
| `vad_threshold` | Voice activity detection confidence threshold |
| `vad_onset_frames` | Frames of speech needed before VAD triggers |
| `vad_hangover_frames` | Frames of silence before VAD releases |
| `aec_enabled` | Acoustic echo cancellation on/off |
| `speaker_energy_threshold` | Energy level above which speaker is considered active |
| `mic_energy_threshold` | Energy level for mic activity detection |
| `skip_mic_on_speaker_energy` | Zero mic windows where speaker is active |
| `dedup_similarity_threshold` | Levenshtein similarity for cross-channel dedup |
| `dedup_time_overlap_ms` | Time overlap required for dedup to apply |
| `min_chunk_samples` | Minimum audio chunk before transcription |
| `max_chunk_samples` | Maximum chunk (force flush) |
| `overlap_samples` | Overlap between consecutive chunks |
| `prefix_overlap_min_words` | Min words for prefix overlap removal |
| `spk_silence_flush_polls` | Silent polls before flushing speaker buffer |
| `window_ms` | Window size for speaker energy filtering |
| `hpf_cutoff` | High-pass filter cutoff frequency |
| `target_rms` | RMS normalization target |
| `silence_threshold` | RMS below which audio is considered silent |
| `poll_interval_ms` | Simulated polling interval (250ms = real-time) |

## Scoring

Per-channel WER (word error rate) via edit distance, weighted combined WER, and channel misattribution detection. Segment boundaries are ignored -- only transcription accuracy and correct channel attribution matter.

## Workflow

1. `transcribe-raw` -- generate draft golden transcripts
2. Human review -- fix errors in the draft, save as `golden.json`
3. `run --compare` -- replay with current params, score against golden
4. `sweep` -- find optimal parameters across a grid

## Recording Directory Structure

Debug recordings live outside the repo at `~/Library/Application Support/com.khalil.talky/debug_recordings/<uuid>/`:

```
<uuid>/
  metadata.json       # Pipeline config and recording metadata
  raw_mic.wav         # 16kHz mono 16-bit PCM
  raw_spk.wav         # 16kHz mono 16-bit PCM
  golden_draft.json   # Output of transcribe-raw
  golden.json         # Human-reviewed reference transcript
  replay_output.json  # Output of run
  sweep_results.json  # Output of sweep
```
