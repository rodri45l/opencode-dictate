# opencode-dictate

**Hands-free voice conversation mode for [opencode](https://opencode.ai).** Speak your
prompts, let the agent answer your permission prompts and questions by voice, and
watch a little status scanner react to your voice — no keyboard required.

> Early development. The API and config may change. Linux/WSL first; macOS and
> Windows are on the roadmap (see [Cross-platform](#cross-platform)).

## What it does

- **Dictate into the prompt** — record one utterance, it lands in the input.
- **Conversation mode** — keep talking; each utterance is sent straight to the
  agent. While the agent is busy, opencode's own queue holds them.
- **Answer by voice** — when the agent asks a question or requests a permission,
  speak your answer: it is submitted for you (`question.reply` / `permission.reply`).
- **Voice kill switch** — say *"stop"* to abort the agent; *"stop conversation mode"*
  to leave hands-free mode. Decisions are made by an LLM, not keyword matching.
- **Status indicator** — centred above the prompt, coloured by state
  (red speaking · amber transcribing · dim silent · white pulse stopped), in two
  styles: a **KITT/Knight-Rider scanner** or a live **amplitude wave**.

## Requirements

- opencode with TUI plugin support (`plugin` in `tui.json`).
- A **speech-to-text backend** (see below) — local or cloud.
- An **OpenAI-compatible LLM** for transcript cleanup + control sentinels
  (optional but recommended; without it, raw transcripts are used and voice
  commands such as "stop" are unavailable).

## Install

```bash
opencode plugin opencode-dictate -g      # installs the npm package and updates config
```

or add it to `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-dictate"]
}
```

## Configuration (WIP)

The backend and cleanup are meant to be **swappable commands**, so you can use your
own GPU or an external service:

```jsonc
{
  "voice": {
    // record one utterance -> print transcript on stdout,
    // emit PHASE:speech|silence|level on stderr
    "backend": "whisper-server",
    "backendUrl": "http://127.0.0.1:8080/v1/audio/transcriptions",
    // optional: clean the transcript and classify control commands
    "cleanup": "opencode-go/deepseek-v4.1-flash"
  }
}
```

## Architecture

The plugin is a thin TUI layer that orchestrates two pluggable pieces:

```
plugin:  capture (local recorder) + VAD (endpointing) + cleanup + loop + UI
         └── audio -> transcript   (local whisper server | cloud API)
```

- **Capture + VAD stay local** (mic access is local by nature; Silero/energy VAD is
  cheap and gives conversation mode its utterance boundaries).
- **ASR is swappable** — a local GPU server or a cloud API.
- **Cleanup + control sentinels** are an LLM step (local or cloud).

## Cross-platform

| OS | Status |
|---|---|
| Linux / WSL | working (reference backend: local GPU Whisper) |
| macOS | planned (capture via `ffmpeg avfoundation`) |
| Windows | planned (capture via `ffmpeg dshow`) |

## License

MIT — see [LICENSE](./LICENSE).
