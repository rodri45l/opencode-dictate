#!/usr/bin/env bash
# Build the bundled recorder for the host platform into bin/<os>-<arch>/.
#
# Each platform is built on its own machine (the frameworks and SDKs differ
# anyway): Linux here, macOS on the Mac. The resulting binaries are small enough
# to ship all together in one npm package, which keeps installation to a single
# `npm install` with no optional-dependency matrix and no postinstall scripts.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/recorder/recorder.c"
[ -f "$src" ] || { echo "recorder/recorder.c is missing" >&2; exit 1; }
[ -f "$here/recorder/miniaudio.h" ] || { echo "recorder/miniaudio.h is missing" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin; cc="${CC:-clang}" ;;
  Linux) os=linux; cc="${CC:-cc}" ;;
  *) echo "unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) arch="$(uname -m)" ;;
esac

out="$here/bin/${os}-${arch}"
mkdir -p "$out"
name="$out/opencode-dictate-recorder"

if [ "$os" = darwin ]; then
  # Build both architectures so an Intel Mac is covered from the same machine.
  if [ "${1:-}" = "--both-arches" ]; then
    for a in arm64 x86_64; do
      d="$here/bin/darwin-$([ "$a" = arm64 ] && echo arm64 || echo x64)"
      mkdir -p "$d"
      "$cc" -O2 -arch "$a" -o "$d/opencode-dictate-recorder" "$src" \
        -framework CoreAudio -framework AudioToolbox -framework CoreFoundation
      echo "built $d/opencode-dictate-recorder"
    done
    exit 0
  fi
  "$cc" -O2 -o "$name" "$src" -framework CoreAudio -framework AudioToolbox -framework CoreFoundation
else
  "$cc" -O2 -o "$name" "$src" -lm -lpthread -ldl
fi

echo "built $name"
file "$name" 2>/dev/null || true
