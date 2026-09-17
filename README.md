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

You only need to point the plugin at **speech-to-text** — cleanup and voice
commands reuse the LLM opencode is already configured with. Configure it in
`tui.json` via plugin options:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-dictate", { "stt": "http://127.0.0.1:8080/v1" }]
  ]
}
```

```jsonc
// or the object form
["opencode-dictate", { "stt": { "url": "https://api.openai.com/v1", "key": "sk-…", "model": "whisper-1" } }]
```

| Option | Meaning |
|---|---|
| `stt` | `"http://…/v1"` or `{ url, key, model }` — any OpenAI-compatible `/audio/transcriptions` |
| `llm` | *optional* override; default is the LLM opencode uses (`small_model`, else `model`) |
| `backend` | `"builtin"` \| `"command"` \| `"auto"` (default `auto`) |
| `silenceMs` / `maxMs` | utterance endpointing (defaults 900 / 60000) |
| `inputDevice` | recorder device override (e.g. an avfoundation index) |

Environment variables (`VOICE_STT_URL`, `VOICE_LLM_URL`, `VOICE_SILENCE_MS`, …)
still work and are overridden by plugin options.

**Auto-detection:** if no STT is configured the plugin probes
`http://127.0.0.1:8080/v1` and uses it when a local server answers; on Linux it
also sets `PULSE_SERVER` for WSLg automatically.

**Recorders:** the plugin uses the first of `ffmpeg`, `parecord`, `arecord`,
`sox` found on `PATH`. `ffmpeg` is the only cross-platform option, so macOS and
Windows need it installed; on macOS grant the terminal microphone permission,
and on Windows the plugin auto-selects the first DirectShow audio device (or
pass `inputDevice: "Microphone (…)"`). Set `VOICE_DEBUG=1` to log to
`VOICE_DEBUG_LOG` (default `/tmp/opencode/dictate-plugin.log`).

With `backend: "command"` the plugin instead runs an external `dictate` command
(e.g. a local GPU build).

See `servers/faster-whisper/` for a dependency-free local STT server.

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
| Linux / WSL | working (`ffmpeg`, `parecord`, `arecord` or `sox`) |
| macOS | implemented (`ffmpeg avfoundation`, auto-picks the first audio device; needs mic permission) |
| Windows | implemented (`ffmpeg dshow`, auto-picks the first audio device) |

macOS and Windows are code-complete but untested on real hardware here — the
device auto-detection has not been run on those platforms.

## License

MIT — see [LICENSE](./LICENSE).
