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
  (red speaking · amber transcribing · dim silent · violet muted · white pulse
  stopped), in two styles: a **KITT/Knight-Rider scanner** or a live **amplitude wave**.
- **Mute** — one key shuts the microphone off completely: nothing is captured at
  all (not captured-and-discarded), the scanner parks in violet, and the setting
  survives restarts.

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

During the beta the package is published under the `beta` dist-tag so `latest`
stays untouched — install `opencode-dictate@beta` explicitly.

## Controls

| Key | Slash command | Action |
|---|---|---|
| `f9` / `<leader>d` | `/dictate` | record one utterance into the prompt |
| `f10` / `<leader>v` | `/converse` | toggle conversation mode (open mic) |
| `f8` / `<leader>m` | `/mute` | mute / unmute the microphone |
| `f7` | `/indicator` | switch indicator style (scanner ↔ wave) |

All four are also in the command palette. `<leader>` is opencode's leader key.

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
| `command` | command to run for `backend: "command"` (default `dictate`) |
| `silenceMs` / `maxMs` / `startTimeoutMs` | utterance endpointing (defaults 900 / 60000 / 4000) |
| `minSpeechMs` | voiced audio required before a clip is transcribed (default 300) |
| `vadThreshold` | peak amplitude that counts as voice; raise it in a noisy room (default 0.03) |
| `inputGain` / `autoGain` | fixed gain 0..1, or let the plugin trim a hot mic itself (default auto) |
| `speaker` | `{ enabled, threshold, artifactThreshold, minSamples }` — MFCC voiceprint gate (defaults 0.8 / 0.9 / 8) |
| `inputDevice` | recorder device override (e.g. an avfoundation index) |
| `debug` | write a debug log (same as `VOICE_DEBUG=1`) |

Environment variables (`VOICE_STT_URL`, `VOICE_LLM_URL`, `VOICE_SILENCE_MS`, …)
still work and are overridden by plugin options.

**Auto-detection:** if no STT is configured the plugin probes
`http://127.0.0.1:8080/v1` and uses it when a local server answers; on Linux it
also sets `PULSE_SERVER` for WSLg automatically.

**Noise and hallucinations:** Whisper-family models invent phrases ("Thank
you.", "To be continued…") when handed silence or room noise, and cloud
endpoints don't expose the server-side VAD a local server does. The plugin
therefore discards a transcript when the clip's loudest peak never clearly rose
above the noise (below 1.5x `vadThreshold`), and separately discards known
artifacts. A third guard is physical rather than textual: a transcript that could
not have been spoken in the time actually recorded is dropped, measured against
*your* own speaking pace (flag above 2.5x it, never below 8 words/second). If
phantom prompts appear, raise `vadThreshold`; if it stops hearing you, lower it.
Set `debug: true` and the log records every keep/drop with the audio levels so
the threshold can be tuned from data.

**Speaker verification (optional):** with `speaker.enabled`, each clip is turned
into an MFCC voiceprint (no model, no dependencies) and compared by cosine
similarity to a profile that keeps learning as you talk — accepted clips are
folded back in, so it follows your voice when the microphone or your delivery
changes. It accepts everything until `minSamples` utterances are enrolled, then
drops clips below `threshold` (0.8 by default). Whisper's stock phrases ("Thank
you.", "To be continued…") are held to a stricter `artifactThreshold` (0.9),
since they are almost never genuine. The profile lives at
`~/.local/share/opencode/opencode-dictate/voiceprint.json`; delete that file to
re-enroll. This is intentionally simple, so treat the threshold as a soft gate
and tune it from the `debug` log.

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

## Troubleshooting

Start with `debug: true` and watch the log (default
`/tmp/opencode/dictate-plugin.log`, override with `VOICE_DEBUG_LOG`). Every clip
logs why it was kept or dropped — `keep`, `drop weak audio`,
`drop silence hallucination`, `drop impossible speech rate`,
`drop other speaker` — with the audio levels behind the decision.

| Symptom | What to try |
|---|---|
| `no recorder found` | install `ffmpeg`, or `parecord`/`arecord`/`sox` on Linux |
| Never hears you | lower `vadThreshold` (try 0.02); check the logged `peak=` |
| Phantom prompts | raise `vadThreshold`; enable `speaker`; the log names the reason |
| Your own words dropped | lower `speaker.threshold`, or delete the voiceprint to re-enroll |
| Hears other people | enable `speaker` and keep `threshold` at 0.8 or above |
| A recorder left running | can't happen indefinitely: each recorder carries its own deadline (~63s) and stale temp files are swept on the next capture |

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
