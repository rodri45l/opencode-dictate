#!/usr/bin/env python3
"""Local decision service: a transcript in, an action + calibrated confidence out.

Laya is inference-only and Python-only, so the plugin talks to it over HTTP on
localhost. Run it beside the STT server:

    ~/.venvs/laya/bin/python servers/laya/decide.py

Configuration (environment):
    LAYA_PORT     default 8090
    LAYA_DEVICE   default cuda, falls back to cpu
    LAYA_MODEL    multilingual (default) | english

Endpoints:
    GET  /health                  -> {"ok": true, "loaded": bool, "model": "..."}
    POST /decide {"text","mode"}  -> {"action","confidence","probabilities","ms"}

The wordings below are the ones that measured best: phrasing the instructions as
an imperative beat phrasing them as a question (5/39 false positives versus 21/39),
and adding worked examples to the criteria made it worse again (32/39). See
scripts/eval-laya.py for the numbers.
"""

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("LAYA_PORT", "8090"))
DEVICE = os.environ.get("LAYA_DEVICE", "cuda")
MODEL = os.environ.get("LAYA_MODEL", "multilingual")

# The same action vocabulary the plugin uses. Laya's "none" is our "prompt".
CONTROL_Q = {
    "action": {
        "type": "choice",
        "instructions": (
            "The speaker is dictating to a coding assistant in hands-free conversation mode. "
            "Decide whether they are giving a control command."
        ),
        "criteria": {
            "none": "an ordinary request or statement to dictate",
            "stop": "tell the assistant to halt immediately",
            "conversation_off": "leave the hands-free conversation mode",
        },
    }
}
PERMISSION_Q = {
    "action": {
        "type": "choice",
        "instructions": (
            "The speaker is replying to a tool-permission prompt. Decide exactly how they answered."
        ),
        "criteria": {
            "none": "not clearly answering the permission question",
            "allow": "approve this one time",
            "always": "approve permanently, do not ask again",
            "deny": "refuse",
        },
    }
}
QUESTIONS = {"control": CONTROL_Q, "permission": PERMISSION_Q}
REMAP = {"none": "prompt"}

_router = None


def router():
    global _router
    if _router is None:
        from laya import Router

        device = DEVICE
        try:
            _router = Router(preload=True, device=device)
        except Exception:
            _router = Router(preload=True, device="cpu")
    return _router


def decide(text: str, mode: str) -> dict:
    question = QUESTIONS.get(mode, CONTROL_Q)
    started = time.time()
    answer = router().predict({"body": text}, question, model=MODEL)["answers"]["action"]
    return {
        "action": REMAP.get(answer.get("choice"), answer.get("choice")),
        "confidence": answer.get("confidence"),
        "probabilities": answer.get("probabilities"),
        "model": MODEL,
        "ms": round((time.time() - started) * 1000, 1),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the journal clean
        pass

    def _send(self, code: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, {"ok": True, "loaded": _router is not None, "model": MODEL})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/decide"):
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            text = (body.get("text") or "").strip()
            if not text:
                self._send(400, {"error": "text is required"})
                return
            self._send(200, decide(text, body.get("mode") or "control"))
        except Exception as error:  # never take the plugin down with us
            self._send(500, {"error": str(error)})


if __name__ == "__main__":
    print(f"laya decision service on :{PORT} (model={MODEL}, device={DEVICE})", flush=True)
    # Load before serving: a cold first request costs ~13 s otherwise.
    router()
    print("model loaded", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
