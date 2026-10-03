# Audio pipeline eval

Measures the live transcription pipeline (`SessionTranscriber`) on meetings
with human transcripts, so pipeline and model changes can be compared by
number rather than by ear.

## Data

Built from the [AMI meeting corpus](https://groups.inf.ed.ac.uk/ami/corpus/)
(CC BY 4.0): one close-talk headset per participant plus word-level
transcripts. `build_ami_cases.py` turns six 10-minute excerpts into Talky's
two-channel layout:

- `raw_mic.wav`: one participant ("me") with a laptop-mic noise floor
- `raw_spk.wav`: everyone else, as a call app would play them
- two scenarios per excerpt: `headphones`, and `speakers`, where the far end
  also leaks into the mic through a simulated laptop speaker and room

Everything lives outside the repo, in `~/.cache/talky-audio-eval/`. To
rebuild it:

```bash
mkdir -p ~/.cache/talky-audio-eval/ami/audio && cd ~/.cache/talky-audio-eval/ami
curl -O https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip
unzip -q ami_public_manual_1.6.2.zip -d manual
for m in ES2004a ES2004c IS1009b TS3003b EN2002a EN2002b; do for h in 0 1 2 3; do
  curl -s -o audio/$m.Headset-$h.wav https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/$m/audio/$m.Headset-$h.wav
done; done
cd .. && uv venv venv && uv pip install --python venv/bin/python numpy scipy soundfile jiwer whisper-normalizer
venv/bin/python <repo>/scripts/audio-eval/build_ami_cases.py
```

## Running

Build the replay binary (see the `replay` skill), then:

```bash
venv/bin/python scripts/audio-eval/run_eval.py NAME --engine coreml -- --config '{"hangover_frames":25}'
venv/bin/python scripts/audio-eval/score.py --runs ~/.cache/talky-audio-eval/runs/A ~/.cache/talky-audio-eval/runs/B
```

`run_eval.py` snapshots the replay binary and Core ML sidecar into the run
directory, so rebuilding mid-run doesn't change what's measured.

## Metrics

| Column | Meaning |
| --- | --- |
| `chanWER` | All errors on both channels over all reference words. Headline number. |
| `micDel` | My words missing from the mic channel |
| `micIns` | Extra words on the mic channel (echo, hallucination) |
| `spkWER` / `spkDel` | The same for everyone else |
| `meRec(ovl)` | Share of my words transcribed while someone else is talking |
| `meRec(clr)` | Share of my words transcribed when nobody else is |
| `leak/100` | Others' words duplicated onto the mic channel, per 100 of their words |
| `latMic50/90` | Seconds from a word ending to its segment appearing (p50/p90) |
| `punct/100` | Sentence punctuation per 100 words (readability) |

Text is normalised with Whisper's English normaliser, fillers are dropped on
both sides, and AMI's acronym spelling (`T_V_`) is joined.
