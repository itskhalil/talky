#!/usr/bin/env python3
"""Run the replay binary over every eval case and score the results.

  run_eval.py NAME [--engine parakeet|coreml] [--cases-glob GLOB] [-j N] -- [replay run flags]

Outputs go to <root>/runs/NAME/<case_id>.json (+ .log), and the score table
is printed at the end. Extra flags after `--` are passed to `replay run`.
"""

import argparse
import concurrent.futures as cf
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DEFAULT_ROOT = Path.home() / ".cache" / "talky-audio-eval"
APP_SUPPORT = Path.home() / "Library" / "Application Support" / "com.khalil.talky"


def ort_dylib_dir():
    base = Path.home() / "Library" / "Caches" / "ort.pyke.io" / "dfbin" / "aarch64-apple-darwin"
    cands = sorted(base.glob("*/onnxruntime/lib"), key=lambda p: p.stat().st_mtime, reverse=True)
    return str(cands[0]) if cands else ""


def main():
    argv = sys.argv[1:]
    extra = []
    if "--" in argv:
        i = argv.index("--")
        argv, extra = argv[:i], argv[i + 1 :]
    ap = argparse.ArgumentParser()
    ap.add_argument("name")
    ap.add_argument("--engine", default="parakeet")
    ap.add_argument("--model", default=str(APP_SUPPORT / "models" / "parakeet-tdt-0.6b-v3-int8"))
    ap.add_argument("--vad-model", default=str(REPO / "src-tauri" / "resources" / "models" / "silero_vad_v4.onnx"))
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    ap.add_argument("--cases-glob", default="*")
    ap.add_argument("--bin", default=str(REPO / "src-tauri" / "target" / "release" / "replay"))
    ap.add_argument("--sidecar", default=str(REPO / "src-tauri" / "coreml-asr" / ".build" / "release" / "talky-coreml-asr"))
    ap.add_argument("-j", type=int, default=3)
    ap.add_argument("--subcommand", default="session")
    args = ap.parse_args(argv)

    out_dir = args.root / "runs" / args.name
    out_dir.mkdir(parents=True, exist_ok=True)
    cases = sorted(p for p in (args.root / "cases").glob(args.cases_glob) if (p / "reference.json").exists())
    env = dict(os.environ)
    env.setdefault("DYLD_LIBRARY_PATH", ort_dylib_dir())
    env.setdefault("RUST_LOG", "warn")
    (out_dir / "cmd.txt").write_text(" ".join([args.subcommand, "--engine", args.engine] + extra) + "\n")

    # Snapshot the binary so rebuilding mid-run can't change what's measured.
    import shutil
    snap = out_dir / "replay.bin"
    shutil.copy2(args.bin, snap)
    args.bin = str(snap)
    sidecar = Path(args.sidecar)
    if sidecar.exists():
        shutil.copy2(sidecar, out_dir / "talky-coreml-asr")
        env["TALKY_COREML_ASR_BIN"] = str(out_dir / "talky-coreml-asr")

    def run_one(case: Path):
        out = out_dir / f"{case.name}.json"
        cmd = [args.bin, args.subcommand, "-r", str(case), "-e", args.engine, "-o", str(out)]
        if args.subcommand in ("run", "session"):
            cmd += ["--vad-model", args.vad_model]
        if not args.engine.startswith("coreml"):
            cmd += ["-m", args.model]
        cmd += extra
        t = time.time()
        p = subprocess.run(cmd, env=env, capture_output=True, text=True)
        (out_dir / f"{case.name}.log").write_text(p.stdout + p.stderr)
        m = re.search(r"Engine time: ([\d.]+)s", p.stderr)
        eng = float(m.group(1)) if m else float("nan")
        if p.returncode != 0:
            print(f"FAILED {case.name}: {p.stderr[-800:]}", file=sys.stderr)
        return case.name, time.time() - t, eng

    t0 = time.time()
    total_eng = 0.0
    with cf.ThreadPoolExecutor(max_workers=args.j) as ex:
        for name, wall, eng in ex.map(run_one, cases):
            total_eng += eng if eng == eng else 0
            print(f"  {name:<28} wall {wall:6.1f}s  engine {eng:6.1f}s", flush=True)
    audio_s = sum(600 for _ in cases) * 2  # two 10-min channels per case
    print(f"{args.name}: {len(cases)} cases in {time.time() - t0:.0f}s; engine {total_eng:.0f}s "
          f"for {audio_s / 60:.0f} min of channel audio (RTFx {audio_s / max(total_eng, 1e-9):.0f})")
    (out_dir / "engine_seconds.txt").write_text(f"{total_eng}\n")
    subprocess.run([sys.executable, str(HERE / "score.py"), "--runs", str(out_dir), "--cases", str(args.root / "cases")])


if __name__ == "__main__":
    main()
