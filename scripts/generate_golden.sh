#!/usr/bin/env bash
set -euo pipefail

# Load API key
source "$(dirname "$0")/../.env"

RECORDINGS_DIR="/Users/khalil/Library/Application Support/com.khalil.talky/debug_recordings"
RECORDINGS=(
  "f391e372-7d92-4bdf-9f2c-c71ee407a2f4"
  "ade96967-1071-4d1c-8392-9693180160a5"
)

for rec_id in "${RECORDINGS[@]}"; do
  rec_dir="$RECORDINGS_DIR/$rec_id"
  echo "=== Processing $rec_id ==="

  for channel in mic spk; do
    wav="$rec_dir/raw_${channel}.wav"
    mp3="$rec_dir/raw_${channel}.mp3"

    if [ ! -f "$wav" ]; then
      echo "  SKIP: $wav not found"
      continue
    fi

    # Convert to mp3 to fit under 25MB API limit
    echo "  Converting $channel to mp3..."
    ffmpeg -y -i "$wav" -ac 1 -ar 16000 -b:a 64k "$mp3" 2>/dev/null

    size=$(stat -f%z "$mp3")
    echo "  MP3 size: $((size / 1024 / 1024))MB"

    # Send to Whisper API with timestamps
    echo "  Transcribing $channel via Whisper API..."
    response=$(curl -s https://api.openai.com/v1/audio/transcriptions \
      -H "Authorization: Bearer $OPENAI_API_KEY" \
      -F file="@$mp3" \
      -F model="whisper-1" \
      -F response_format="verbose_json" \
      -F timestamp_granularities[]="segment" \
      -F language="en")

    # Save raw response
    echo "$response" > "$rec_dir/whisper_${channel}.json"
    echo "  Saved whisper_${channel}.json"

    # Clean up mp3
    rm "$mp3"
  done

  # Combine into golden_draft_whisper.json
  echo "  Assembling golden_draft_whisper.json..."
  python3 -c "
import json, sys

segments = []
for channel in ['mic', 'spk']:
    source = 'mic' if channel == 'mic' else 'speaker'
    path = '$rec_dir/whisper_' + channel + '.json'
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception as e:
        print(f'  Warning: could not read {path}: {e}', file=sys.stderr)
        continue

    if 'segments' not in data:
        print(f'  Warning: no segments in {path}', file=sys.stderr)
        if 'error' in data:
            print(f'  API error: {data[\"error\"]}', file=sys.stderr)
        continue

    for seg in data['segments']:
        segments.append({
            'text': seg['text'].strip(),
            'source': source,
            'start_ms': int(seg['start'] * 1000),
            'end_ms': int(seg['end'] * 1000),
        })

# Sort by start time, then by source (mic before speaker for same time)
segments.sort(key=lambda s: (s['start_ms'], 0 if s['source'] == 'mic' else 1))

with open('$rec_dir/golden_draft_whisper.json', 'w') as f:
    json.dump(segments, f, indent=2)

print(f'  Written {len(segments)} segments')
"

  echo "  Done: $rec_dir/golden_draft_whisper.json"
  echo ""
done

echo "All done! Review the golden_draft_whisper.json files and save as golden.json when ready."
