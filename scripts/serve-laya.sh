#!/usr/bin/env bash
# Run the local decision service. Laya needs torch, so it uses its own venv,
# which reuses the whisper venv's torch rather than downloading a second copy.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${LAYA_VENV:-$HOME/.venvs/laya}"
exec "$VENV/bin/python" "$here/servers/laya/decide.py"
