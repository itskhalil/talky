#!/usr/bin/env bash
# Generate a review.html in the given recording directory.
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <recording_dir>" >&2
  exit 1
fi

REC_DIR="$1"

if [ ! -f "$REC_DIR/mic_aec.wav" ] || [ ! -f "$REC_DIR/raw_spk.wav" ]; then
  echo "Missing mic_aec.wav or raw_spk.wav in $REC_DIR" >&2
  exit 1
fi

if [ ! -f "$REC_DIR/golden_draft_aec.json" ]; then
  echo "Missing golden_draft_aec.json in $REC_DIR" >&2
  exit 1
fi

cp "$(dirname "$0")/review_template.html" "$REC_DIR/review.html"
echo "Review tool ready: $REC_DIR/review.html"
echo ""
echo "Open it in a browser — but audio needs a local server:"
echo "  cd '$REC_DIR' && python3 -m http.server 8765"
echo "Then visit: http://localhost:8765/review.html"
