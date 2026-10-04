#!/usr/bin/env python3
"""Build two-channel Talky eval cases from the AMI meeting corpus.

Talky records the user's mic and the system audio ("Them") as separate
channels. AMI has one close-talk headset per participant plus word-level
human transcripts, so we can synthesise that setup with ground truth:

  raw_spk.wav  = the other participants' headsets, mixed (what a call app plays)
  raw_mic.wav  = one participant's headset ("me"), with a laptop-mic noise floor
                 plus, in the `speakers` scenario, an echo of raw_spk as if the
                 call were played through laptop speakers into the laptop mic.

Each case directory is laid out like a Talky debug recording, so the replay
binary can run it directly, plus a `reference.json` with word timings.

Data lives outside the repo (default ~/.cache/talky-audio-eval). AMI is
CC BY 4.0: https://groups.inf.ed.ac.uk/ami/corpus/license.shtml

Usage:
  build_ami_cases.py [--root DIR]
"""

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 16000
AMI_AUDIO_URL = "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/{m}/audio/{m}.Headset-{h}.wav"

# (meeting, "me" agent, excerpt start s, excerpt end s). Test-set meetings from
# the standard AMI ASR split; "me" ranges from a quiet participant to the most
# talkative one, and the EN2002 meetings are unscripted with lots of overlap.
CASES = [
    ("ES2004a", "C", 240, 840),
    ("ES2004c", "A", 600, 1200),
    ("IS1009b", "D", 300, 900),
    ("TS3003b", "B", 600, 1200),
    ("EN2002a", "A", 300, 900),
    ("EN2002b", "C", 300, 900),
]

SCENARIOS = ("headphones", "speakers")

# Levels (dBFS of active speech)
SPEECH_DBFS = -26.0
MIC_NOISE_DBFS = -62.0
# Echo of the far end in the near-end mic, relative to the near-end speech
# level. Laptop speakers into a laptop mic is loud: -6 dB is a moderate case.
ECHO_REL_DB = -6.0
ECHO_DELAY_S = 0.06
RT60_S = 0.3


def db_to_lin(db):
    return 10 ** (db / 20)


def load_speaker_map(manual: Path):
    """meeting -> {agent letter: headset channel}"""
    tree = ET.parse(manual / "corpusResources" / "meetings.xml")
    out = {}
    for meeting in tree.getroot():
        obs = meeting.get("observation")
        agents = {}
        for spk in meeting:
            agent = spk.get("nxt_agent")
            chan = spk.get("channel")
            if agent and chan is not None:
                agents[agent] = int(chan)
        out[obs] = agents
    return out


def load_words(manual: Path, meeting: str, agent: str):
    path = manual / "words" / f"{meeting}.{agent}.words.xml"
    if not path.exists():
        return []
    text = path.read_text(encoding="iso-8859-1")
    words = []
    for el in ET.fromstring(text.encode("iso-8859-1")):
        if not el.tag.endswith("w"):
            continue
        if el.get("punc") == "true":
            continue
        st, et = el.get("starttime"), el.get("endtime")
        if st is None or et is None or el.text is None:
            continue
        w = el.text.strip()
        if not w:
            continue
        words.append({"w": w, "start": float(st), "end": float(et), "speaker": agent})
    return words


def speech_envelope(words, n, floor, pad=0.3, merge_gap=0.5, fade=0.03):
    """Gain envelope: 1 within (padded) speech regions, `floor` elsewhere."""
    env = np.full(n, floor, dtype=np.float32)
    if not words:
        return env
    regions = []
    for w in sorted(words, key=lambda x: x["start"]):
        s, e = w["start"] - pad, w["end"] + pad
        if regions and s - regions[-1][1] < merge_gap:
            regions[-1][1] = max(regions[-1][1], e)
        else:
            regions.append([s, e])
    f = int(fade * SR)
    ramp = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, f, dtype=np.float32))
    for s, e in regions:
        a, b = max(0, int(s * SR)), min(n, int(e * SR))
        if b <= a:
            continue
        env[a:b] = 1.0
        # fades
        lo = max(0, a - f)
        seg = ramp[f - (a - lo):] * (1 - floor) + floor
        env[lo:a] = np.maximum(env[lo:a], seg)
        hi = min(n, b + f)
        seg = ramp[::-1][: hi - b] * (1 - floor) + floor
        env[b:hi] = np.maximum(env[b:hi], seg)
    return env


def active_rms(x, words, offset):
    """RMS over the samples covered by the given words (excerpt-relative)."""
    idx = []
    for w in words:
        a, b = int((w["start"] - offset) * SR), int((w["end"] - offset) * SR)
        a, b = max(0, a), min(len(x), b)
        if b > a:
            idx.append(x[a:b])
    if not idx:
        return 0.0
    cat = np.concatenate(idx)
    return float(np.sqrt(np.mean(cat**2)) + 1e-9)


def pink_noise(n, rng):
    # Voss-McCartney-ish via FFT shaping
    white = rng.standard_normal(n).astype(np.float32)
    spec = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n, 1 / SR)
    freqs[0] = 1.0
    spec /= np.sqrt(freqs)
    out = np.fft.irfft(spec, n).astype(np.float32)
    return out / (np.sqrt(np.mean(out**2)) + 1e-9)


def room_ir(rng):
    n = int(RT60_S * SR)
    t = np.arange(n) / SR
    decay = np.exp(-6.9 * t / RT60_S)  # -60 dB at RT60
    ir = rng.standard_normal(n).astype(np.float32) * decay.astype(np.float32) * 0.3
    ir[0] = 1.0  # direct path
    d = int(ECHO_DELAY_S * SR)
    return np.concatenate([np.zeros(d, dtype=np.float32), ir])


def fft_convolve(x, h):
    n = len(x) + len(h) - 1
    nfft = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, nfft) * np.fft.rfft(h, nfft), nfft)[: len(x)]
    return y.astype(np.float32)


def write_case(out_dir: Path, mic, spk, reference, case_id):
    out_dir.mkdir(parents=True, exist_ok=True)
    sf.write(out_dir / "raw_mic.wav", np.clip(mic, -1, 1), SR, subtype="PCM_16")
    sf.write(out_dir / "raw_spk.wav", np.clip(spk, -1, 1), SR, subtype="PCM_16")
    metadata = {
        "version": 2,
        "session_id": case_id,
        "recorded_at": "2005-01-01T00:00:00+00:00",
        "duration_seconds": len(mic) / SR,
        "transcript_segments": [],
    }
    (out_dir / "metadata.json").write_text(json.dumps(metadata, indent=2))
    (out_dir / "reference.json").write_text(json.dumps(reference, indent=1))
    # golden.json keeps the replay binary's own --compare scoring working.
    golden = []
    for chan in ("mic", "speaker"):
        ws = [w for w in reference["words"] if w["channel"] == chan]
        cur = None
        for w in ws:
            if cur and w["start"] - cur["_end"] < 1.0:
                cur["text"] += " " + w["w"]
                cur["_end"] = w["end"]
            else:
                if cur:
                    golden.append(cur)
                cur = {"text": w["w"], "source": chan, "start_ms": int(w["start"] * 1000), "_end": w["end"]}
        if cur:
            golden.append(cur)
    for g in golden:
        g["end_ms"] = int(g.pop("_end") * 1000)
    golden.sort(key=lambda g: g["start_ms"])
    (out_dir / "golden.json").write_text(json.dumps(golden, indent=1))


def build(root: Path):
    manual = root / "ami" / "manual"
    audio_dir = root / "ami" / "audio"
    cases_dir = root / "cases"
    spk_map = load_speaker_map(manual)

    for meeting, me, t0, t1 in CASES:
        agents = spk_map[meeting]
        rng = np.random.default_rng(zlib.crc32(meeting.encode()))
        n = int((t1 - t0) * SR)
        tracks = {}
        words = {}
        for agent, chan in sorted(agents.items()):
            path = audio_dir / f"{meeting}.Headset-{chan}.wav"
            if not path.exists():
                sys.exit(f"missing {path}; download {AMI_AUDIO_URL.format(m=meeting, h=chan)}")
            x, sr = sf.read(path, dtype="float32", start=int(t0 * SR), stop=int(t1 * SR))
            assert sr == SR, (path, sr)
            if x.ndim > 1:
                x = x.mean(axis=1)
            if len(x) < n:
                x = np.pad(x, (0, n - len(x)))
            ws = [w for w in load_words(manual, meeting, agent) if t0 <= (w["start"] + w["end"]) / 2 < t1]
            # level-normalise each talker's active speech
            rms = active_rms(x, ws, t0)
            if rms > 0:
                x = x * (db_to_lin(SPEECH_DBFS) / rms)
            tracks[agent] = x
            words[agent] = [{**w, "start": w["start"] - t0, "end": w["end"] - t0} for w in ws]

        others = [a for a in agents if a != me]
        # Far end: what the call app plays. Gate each remote talker to their
        # own speech so their headset's crosstalk of "me" doesn't leak into
        # the remote channel (a real call's far end has its own echo control).
        spk = np.zeros(n, dtype=np.float32)
        for a in others:
            spk += tracks[a] * speech_envelope(words[a], n, floor=0.02)
        # Near end: my headset, crosstalk of others attenuated by 26 dB outside
        # my speech, over a laptop-mic noise floor.
        mic_clean = tracks[me] * speech_envelope(words[me], n, floor=0.05)
        mic_clean += pink_noise(n, rng) * db_to_lin(MIC_NOISE_DBFS)

        reference_words = []
        for a in agents:
            for w in words[a]:
                reference_words.append({**w, "channel": "mic" if a == me else "speaker"})
        reference_words.sort(key=lambda w: w["start"])

        for scenario in SCENARIOS:
            if scenario == "headphones":
                mic = mic_clean
            else:
                # Loudspeaker -> room -> mic. Mild loudspeaker saturation makes
                # the echo path non-linear, as small laptop speakers are.
                drive = np.tanh(spk * 3.0) / 3.0
                echo = fft_convolve(drive, room_ir(rng))
                echo_rms = active_rms(echo, [w for a in others for w in words[a]], 0)
                echo *= db_to_lin(SPEECH_DBFS + ECHO_REL_DB) / (echo_rms + 1e-9)
                mic = mic_clean + echo
            case_id = f"{meeting}-{me}-{scenario}"
            reference = {
                "case_id": case_id,
                "meeting": meeting,
                "me": me,
                "scenario": scenario,
                "excerpt_s": [t0, t1],
                "words": reference_words,
            }
            write_case(cases_dir / case_id, mic, spk, reference, case_id)
            n_me = sum(1 for w in reference_words if w["channel"] == "mic")
            print(f"{case_id}: {n / SR / 60:.1f} min, me={n_me} words, them={len(reference_words) - n_me} words")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=Path.home() / ".cache" / "talky-audio-eval")
    args = ap.parse_args()
    build(args.root)


if __name__ == "__main__":
    main()
