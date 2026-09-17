#!/usr/bin/env python3
"""Minimal OpenAI-compatible speech-to-text server (dependency-free).

Serves POST /v1/audio/transcriptions using faster-whisper, so opencode-dictate's
builtin pipeline can talk to a local model exactly like it talks to a cloud API.

    pip install faster-whisper
    python server.py                       # 127.0.0.1:8080, cuda if available
    WHISPER_MODEL=large-v3 WHISPER_DEVICE=cuda python server.py

Config (env):
    WHISPER_MODEL   model name/size               (default: large-v3)
    WHISPER_DEVICE  auto | cuda | cpu             (default: auto)
    WHISPER_COMPUTE ctranslate2 compute type      (default: float16 on cuda, int8 on cpu)
    VOICE_STT_PORT  listen port                   (default: 8080)

Then point the plugin at it:
    VOICE_STT_URL=http://127.0.0.1:8080/v1 VOICE_STT_MODEL=whisper-1
"""

import json
import os
import tempfile
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "")
PORT = int(os.environ.get("VOICE_STT_PORT", "8080"))


def load_model() -> WhisperModel:
    device = DEVICE
    if device == "auto":
        try:
            import ctranslate2

            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            device = "cpu"
    compute = COMPUTE or ("float16" if device == "cuda" else "int8")
    print(f"loading {MODEL} on {device} ({compute})…", flush=True)
    model = WhisperModel(MODEL, device=device, compute_type=compute)
    print("ready", flush=True)
    return model


MODEL_INSTANCE = load_model()


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/health"):
            self._json(200, {"status": "ok"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self.path.startswith("/v1/audio/transcriptions"):
            return self._json(404, {"error": "not found"})

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        message = BytesParser(policy=email_policy).parsebytes(
            b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
        )

        audio = None
        language = None
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if name in ("file", "audio"):
                audio = part.get_payload(decode=True)
            elif name == "language":
                raw = part.get_payload(decode=True)
                if raw:
                    language = raw.decode().strip() or None

        if not audio:
            return self._json(400, {"error": "no audio file"})

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            handle.write(audio)
            path = handle.name
        try:
            # Silero VAD + no_speech_threshold are what stop Whisper from
            # hallucinating "Thank you." / "Thanks for watching!" on near-silent
            # or noisy clips. condition_on_previous_text=False prevents one bad
            # decode from seeding the next.
            segments, _info = MODEL_INSTANCE.transcribe(
                path,
                language=language,
                beam_size=1,
                temperature=0.0,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
                no_speech_threshold=0.6,
                condition_on_previous_text=False,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
        finally:
            os.unlink(path)

        self._json(200, {"text": text})

    def log_message(self, *_args) -> None:
        return


if __name__ == "__main__":
    print(f"listening on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
