#!/usr/bin/env python3
"""Score Talky replay output against an eval case's word-level reference.

Per channel (mic = "me", speaker = "them"):
  WER with substitution / deletion / insertion counts.
Plus the failure modes users report:
  me_recall_overlap   share of my words transcribed while someone else talks
  me_recall_clear     share of my words transcribed when nobody else talks
  echo_leak           others' words that also appear on the mic channel
                      (duplicate "Me" lines), per 100 of their words
  latency_p50/p90     seconds from a word ending to its segment being emitted
Headline: `channel_wer` = all errors on both channels / all reference words.

Usage:
  score.py CASE_DIR HYP_JSON            # one case, prints JSON
  score.py --runs RUN_DIR [RUN_DIR...]  # RUN_DIR/<case_id>.json, prints a table
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import jiwer
from whisper_normalizer.english import EnglishTextNormalizer

_normalizer = EnglishTextNormalizer()
FILLERS = {"um", "uh", "uhm", "umm", "er", "erm", "ah", "eh", "hm", "hmm", "mm", "mmm", "mhm", "huh", "mmhmm", "uhhuh"}
CANON = {"ok": "okay", "alright": "all right", "yep": "yeah", "yup": "yeah"}


def normalize_tokens(text: str):
    t = re.sub(r"([A-Za-z])_", r"\1", text)  # AMI acronyms: T_V_ -> TV
    t = re.sub(r"(?<=[A-Za-z])-(?=[A-Za-z])", " ", t)
    t = _normalizer(t)
    out = []
    for tok in t.split():
        tok = CANON.get(tok, tok)
        if tok in FILLERS or not tok:
            continue
        out.extend(tok.split())
    return out


def tokens_with_owner(items):
    """items: [(text, owner)] -> (tokens, owners) with per-token owner."""
    toks, owners = [], []
    for text, owner in items:
        for tok in normalize_tokens(text):
            toks.append(tok)
            owners.append(owner)
    return toks, owners


def align(ref_toks, hyp_toks):
    """Returns (S, D, I, hits, ref_hit_flags, hyp_inserted_flags)."""
    ref_hit = [False] * len(ref_toks)
    hyp_ins = [False] * len(hyp_toks)
    if not ref_toks and not hyp_toks:
        return 0, 0, 0, 0, ref_hit, hyp_ins
    if not ref_toks:
        return 0, 0, len(hyp_toks), 0, ref_hit, [True] * len(hyp_toks)
    if not hyp_toks:
        return 0, len(ref_toks), 0, 0, ref_hit, hyp_ins
    out = jiwer.process_words(" ".join(ref_toks), " ".join(hyp_toks))
    for chunk in out.alignments[0]:
        if chunk.type == "equal":
            for k in range(chunk.ref_end_idx - chunk.ref_start_idx):
                ref_hit[chunk.ref_start_idx + k] = True
        elif chunk.type == "insert":
            for k in range(chunk.hyp_start_idx, chunk.hyp_end_idx):
                hyp_ins[k] = True
    return out.substitutions, out.deletions, out.insertions, out.hits, ref_hit, hyp_ins


def ngrams(toks, n=3):
    return {tuple(toks[i : i + n]) for i in range(len(toks) - n + 1)}


def score_case(case_dir: Path, hyp_segments):
    ref = json.loads((case_dir / "reference.json").read_text())
    words = ref["words"]
    me_words = [w for w in words if w["channel"] == "mic"]
    them_words = [w for w in words if w["channel"] == "speaker"]

    # Ref tokens keep a pointer back to their word for timing.
    def ref_tokens(ws):
        toks, owners = [], []
        for i, w in enumerate(ws):
            for tok in normalize_tokens(w["w"]):
                toks.append(tok)
                owners.append(i)
        return toks, owners

    result = {"case_id": ref["case_id"], "scenario": ref["scenario"]}
    hyp_by_chan = {
        "mic": sorted([s for s in hyp_segments if s["source"] == "mic"], key=lambda s: s["start_ms"]),
        "speaker": sorted([s for s in hyp_segments if s["source"] == "speaker"], key=lambda s: s["start_ms"]),
    }
    them_intervals = sorted((w["start"], w["end"]) for w in them_words)

    def overlapped(w):
        # any other speaker's word overlapping this one (binary search would be
        # faster; cases are small)
        for s, e in them_intervals:
            if s > w["end"]:
                break
            if e > w["start"] and s < w["end"]:
                return True
        return False

    for chan, ws in (("mic", me_words), ("speaker", them_words)):
        r_toks, r_owner = ref_tokens(ws)
        h_toks, h_seg = tokens_with_owner([(s["text"], i) for i, s in enumerate(hyp_by_chan[chan])])
        S, D, I, H, ref_hit, hyp_ins = align(r_toks, h_toks)
        N = len(r_toks)
        result[chan] = {"N": N, "S": S, "D": D, "I": I, "H": H, "wer": (S + D + I) / max(N, 1)}

        # latency: emit time (emitted_ms, or end_ms for the legacy runner, which
        # sets it to the tick the segment was produced) minus the end of the
        # reference word it matched.
        # Map hits back to hyp tokens via a second pass over the alignment.
        lat = []
        if N and h_toks:
            out = jiwer.process_words(" ".join(r_toks), " ".join(h_toks))
            segs = hyp_by_chan[chan]
            for chunk in out.alignments[0]:
                if chunk.type != "equal":
                    continue
                for k in range(chunk.ref_end_idx - chunk.ref_start_idx):
                    w = ws[r_owner[chunk.ref_start_idx + k]]
                    seg = segs[h_seg[chunk.hyp_start_idx + k]]
                    emitted = seg.get("emitted_ms") or seg["end_ms"]
                    lat.append(emitted / 1000 - w["end"])
        lat.sort()
        result[chan]["latency"] = lat

        if chan == "mic":
            ov_tot = ov_hit = cl_tot = cl_hit = 0
            ov_cache = [overlapped(w) for w in ws]
            for t, hit in enumerate(ref_hit):
                if ov_cache[r_owner[t]]:
                    ov_tot += 1
                    ov_hit += hit
                else:
                    cl_tot += 1
                    cl_hit += hit
            result["me_overlap"] = {"tot": ov_tot, "hit": ov_hit}
            result["me_clear"] = {"tot": cl_tot, "hit": cl_hit}

            # Echo leak: inserted mic tokens covered by a 3-gram of what the
            # others said within +-5 s of the segment, and not by a 3-gram of
            # what I said there.
            leak = 0
            segs = hyp_by_chan["mic"]
            for si, seg in enumerate(segs):
                idx = [k for k in range(len(h_toks)) if h_seg[k] == si]
                if not idx:
                    continue
                t0, t1 = seg["start_ms"] / 1000 - 5, seg["end_ms"] / 1000 + 5
                them_win = [tok for w in them_words if t0 <= w["start"] <= t1 for tok in normalize_tokens(w["w"])]
                me_win = [tok for w in me_words if t0 <= w["start"] <= t1 for tok in normalize_tokens(w["w"])]
                them_ng, me_ng = ngrams(them_win), ngrams(me_win)
                seg_toks = [h_toks[k] for k in idx]
                covered = [False] * len(seg_toks)
                for j in range(len(seg_toks) - 2):
                    g = tuple(seg_toks[j : j + 3])
                    if g in them_ng and g not in me_ng:
                        covered[j] = covered[j + 1] = covered[j + 2] = True
                leak += sum(1 for j, k in enumerate(idx) if covered[j] and hyp_ins[k])
            result["echo_leak_words"] = leak

    n_all = result["mic"]["N"] + result["speaker"]["N"]
    errs = sum(result[c][k] for c in ("mic", "speaker") for k in ("S", "D", "I"))
    result["channel_wer"] = errs / max(n_all, 1)
    # Readability: sentence punctuation per raw hypothesis word.
    raw_words = [w for seg in hyp_segments for w in seg["text"].split()]
    result["punct"] = {"words": len(raw_words), "marks": sum(1 for w in raw_words if w[-1:] in ".?!,")}
    return result


def pct(lst, p):
    if not lst:
        return float("nan")
    return lst[min(len(lst) - 1, int(p * len(lst)))]


def summarize(results):
    agg = defaultdict(lambda: defaultdict(float))
    lat = defaultdict(list)
    for r in results:
        for key in (r["scenario"], "ALL"):
            a = agg[key]
            for c in ("mic", "speaker"):
                for k in ("N", "S", "D", "I"):
                    a[f"{c}_{k}"] += r[c][k]
                lat[(key, c)].extend(r[c]["latency"])
            a["ov_tot"] += r["me_overlap"]["tot"]
            a["ov_hit"] += r["me_overlap"]["hit"]
            a["cl_tot"] += r["me_clear"]["tot"]
            a["cl_hit"] += r["me_clear"]["hit"]
            a["leak"] += r["echo_leak_words"]
            a["p_words"] += r["punct"]["words"]
            a["p_marks"] += r["punct"]["marks"]
    rows = {}
    for key, a in agg.items():
        n_all = a["mic_N"] + a["speaker_N"]
        errs = sum(a[f"{c}_{k}"] for c in ("mic", "speaker") for k in ("S", "D", "I"))
        lm = sorted(lat[(key, "mic")])
        ls = sorted(lat[(key, "speaker")])
        rows[key] = {
            "channel_wer": errs / n_all,
            "mic_wer": (a["mic_S"] + a["mic_D"] + a["mic_I"]) / a["mic_N"],
            "mic_del": a["mic_D"] / a["mic_N"],
            "mic_ins": a["mic_I"] / a["mic_N"],
            "spk_wer": (a["speaker_S"] + a["speaker_D"] + a["speaker_I"]) / a["speaker_N"],
            "spk_del": a["speaker_D"] / a["speaker_N"],
            "me_recall_overlap": a["ov_hit"] / max(a["ov_tot"], 1),
            "me_recall_clear": a["cl_hit"] / max(a["cl_tot"], 1),
            "echo_leak_per100": 100 * a["leak"] / a["speaker_N"],
            "lat_mic_p50": pct(lm, 0.5),
            "lat_mic_p90": pct(lm, 0.9),
            "lat_spk_p50": pct(ls, 0.5),
            "lat_spk_p90": pct(ls, 0.9),
            "punct_per100": 100 * a["p_marks"] / max(a["p_words"], 1),
        }
    return rows


COLS = [
    ("channel_wer", "chanWER", "{:.1%}"),
    ("mic_wer", "micWER", "{:.1%}"),
    ("mic_del", "micDel", "{:.1%}"),
    ("mic_ins", "micIns", "{:.1%}"),
    ("spk_wer", "spkWER", "{:.1%}"),
    ("spk_del", "spkDel", "{:.1%}"),
    ("me_recall_overlap", "meRec(ovl)", "{:.1%}"),
    ("me_recall_clear", "meRec(clr)", "{:.1%}"),
    ("echo_leak_per100", "leak/100", "{:.2f}"),
    ("lat_mic_p50", "latMic50", "{:.1f}s"),
    ("lat_mic_p90", "latMic90", "{:.1f}s"),
    ("lat_spk_p50", "latSpk50", "{:.1f}s"),
    ("lat_spk_p90", "latSpk90", "{:.1f}s"),
    ("punct_per100", "punct/100", "{:.1f}"),
]


def load_hyp(path: Path):
    data = json.loads(path.read_text())
    if isinstance(data, dict):
        data = data.get("segments", data)
    return data


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("case_dir", nargs="?", type=Path)
    ap.add_argument("hyp", nargs="?", type=Path)
    ap.add_argument("--runs", nargs="+", type=Path, help="run dirs with <case_id>.json outputs")
    ap.add_argument("--cases", type=Path, default=Path.home() / ".cache" / "talky-audio-eval" / "cases")
    ap.add_argument("--per-case", action="store_true")
    ap.add_argument("--json", type=Path, help="write summary JSON here")
    args = ap.parse_args()

    if args.runs:
        summary = {}
        header = f"{'run':<34}{'subset':<12}" + "".join(f"{h:>11}" for _, h, _ in COLS)
        print(header)
        for run in args.runs:
            results = []
            for hyp in sorted(run.glob("*.json")):
                case_dir = args.cases / hyp.stem
                if not (case_dir / "reference.json").exists():
                    continue
                r = score_case(case_dir, load_hyp(hyp))
                results.append(r)
                if args.per_case:
                    clr = r["me_clear"]["hit"] / max(r["me_clear"]["tot"], 1)
                    ovl = r["me_overlap"]["hit"] / max(r["me_overlap"]["tot"], 1)
                    print(f"  {hyp.stem:<28} chanWER={r['channel_wer']:.1%} mic={r['mic']['wer']:.1%} "
                          f"(del {r['mic']['D']}/{r['mic']['N']}) spk={r['speaker']['wer']:.1%} "
                          f"meRec clr={clr:.0%} ovl={ovl:.0%} leak={r['echo_leak_words']}")
            if not results:
                print(f"{run.name}: no results", file=sys.stderr)
                continue
            rows = summarize(results)
            summary[run.name] = rows
            for key in ("headphones", "speakers", "ALL"):
                if key not in rows:
                    continue
                row = rows[key]
                print(f"{run.name[:33]:<34}{key:<12}" + "".join(f"{f.format(row[k]):>11}" for k, _, f in COLS))
        if args.json:
            args.json.write_text(json.dumps(summary, indent=1))
    else:
        r = score_case(args.case_dir, load_hyp(args.hyp))
        for c in ("mic", "speaker"):
            r[c].pop("latency")
        print(json.dumps(r, indent=1))


if __name__ == "__main__":
    main()
