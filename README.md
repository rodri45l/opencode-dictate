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

## Configuration

The builtin pipeline is enabled by pointing the plugin at a **speech-to-text
endpoint** (any OpenAI-compatible `/audio/transcriptions`, local or cloud) and,
optionally, an **LLM** for cleanup + voice commands. Set these in the
environment opencode runs in:

| Variable | Meaning |
|---|---|
| `VOICE_STT_URL` | e.g. `http://127.0.0.1:8080/v1` (local whisper server) or `https://api.openai.com/v1` |
| `VOICE_STT_KEY` | API key (omit for a local server) |
| `VOICE_STT_MODEL` | default `whisper-1` |
| `VOICE_LLM_URL` | optional OpenAI-compatible base for cleanup + `[[STOP]]`-style commands |
| `VOICE_LLM_KEY`, `VOICE_LLM_MODEL` | credentials/model for the above |
| `VOICE_SILENCE_MS` | silence that ends an utterance (default 900) |
| `VOICE_MAX_MS` | max utterance length (default 60000) |
| `VOICE_INPUT_DEVICE` | recorder device override (e.g. an avfoundation index) |

Audio is captured with **ffmpeg** (cross-platform), which must be on `PATH`.
If no `VOICE_STT_URL` is set, the plugin falls back to an external `dictate`
command on `PATH` (e.g. a local GPU Whisper build).

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
