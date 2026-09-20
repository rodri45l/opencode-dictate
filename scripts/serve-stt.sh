#!/usr/bin/env bash
# Run the local faster-whisper STT server that opencode-dictate talks to.
#
# This is the thing a daemon should run: it loads the model once, serves an
# OpenAI-compatible /v1/audio/transcriptions endpoint, and stays up. Config via
# env (all optional):
#
#   WHISPER_VENV    python venv holding faster-whisper   (default: ~/.venvs/whisper)
#   WHISPER_MODEL   model name/size                      (default: large-v3)
#   WHISPER_DEVICE  auto | cuda | cpu                    (default: cuda)
#   WHISPER_COMPUTE compute type                         (default: float16 on cuda)
#   VOICE_STT_PORT  listen port                          (default: 8080)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${WHISPER_VENV:-$HOME/.venvs/whisper}"

if [[ ! -x "${VENV}/bin/python" ]]; then
  echo "no python at ${VENV}/bin/python — set WHISPER_VENV" >&2
  exit 1
fi

# faster-whisper's CUDA runtime (cuBLAS/cuDNN) ships inside the venv; ctranslate2
# loads it from LD_LIBRARY_PATH.
SITE="$("${VENV}/bin/python" -c 'import site; print(site.getsitepackages()[0])')"
export LD_LIBRARY_PATH="${SITE}/nvidia/cublas/lib:${SITE}/nvidia/cudnn/lib:${LD_LIBRARY_PATH:-}"
export WHISPER_MODEL="${WHISPER_MODEL:-large-v3}"
export WHISPER_DEVICE="${WHISPER_DEVICE:-cuda}"
export VOICE_STT_PORT="${VOICE_STT_PORT:-8080}"

exec "${VENV}/bin/python" "${ROOT}/servers/faster-whisper/server.py"
