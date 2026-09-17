#!/usr/bin/env bash
# Record one labelled sample for the offline guard tests.
#
#   ./scripts/record-sample.sh speech 4     # say a sentence
#   ./scripts/record-sample.sh pop 2        # tap/knock the mic
#   ./scripts/record-sample.sh noise 4      # stay silent, let the room do its thing
#
# Samples land in ~/.local/share/opencode/opencode-dictate/samples/<label>/ and
# are analysed with:  bun run samples:analyze
set -euo pipefail

label="${1:-speech}"
seconds="${2:-3}"
root="${SAMPLES_DIR:-$HOME/.local/share/opencode/opencode-dictate/samples}"
dir="$root/$label"
mkdir -p "$dir"

# WSLg exposes PulseAudio as a Unix socket.
if [ -z "${PULSE_SERVER:-}" ] && [ -S /mnt/wslg/PulseServer ]; then
  export PULSE_SERVER="unix:/mnt/wslg/PulseServer"
fi

out="$dir/$(date +%Y%m%d-%H%M%S).wav"
echo "recording ${seconds}s -> $out"
printf 'go: '
for _ in $(seq 1 "$seconds"); do printf '.'; sleep 1; done
printf '\n'

if command -v parecord >/dev/null 2>&1; then
  parecord --format=s16le --rate=16000 --channels=1 --file-format=wav "$out" &
  pid=$!
  sleep "$seconds"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
elif command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -hide_banner -loglevel error -f pulse -i default -ac 1 -ar 16000 -t "$seconds" -y "$out"
else
  echo "need parecord or ffmpeg on PATH" >&2
  exit 1
fi

echo "saved $out"
