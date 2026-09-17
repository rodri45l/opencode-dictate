# Agent notes — opencode-dictate

TUI plugin for opencode that adds hands-free voice conversation mode.

## Layout

- `src/index.ts` — the TUI plugin (exports `{ id, tui }`).
- `examples/tui.json` — minimal config to load the plugin.
- `dist/` — build output (gitignored); published `./tui` export points here.

## Conventions

- TUI plugin contract: default export `{ id, tui }`; `tui` is an async function
  receiving `TuiPluginApi`. Commands/keybinds register via
  `api.keymap.registerLayer({ commands, bindings })`; the status line renders
  through the `session_prompt` / `home_prompt` slots.
- A slash command is only listed if it has a binding (`visibility: "reachable"`),
  so every command needs a keybinding.
- Send prompts with `client.session.promptAsync` (returns immediately; opencode
  queues while busy) — never the blocking `prompt`.
- SolidJS via `@opentui/solid`; `solid-js` and `@opencode-ai/*` are externals.

## Build / verify

```bash
bun run build       # bundles src/index.ts -> dist/index.js
bun run typecheck   # tsc --noEmit
```

## Design goals

- Keep the plugin a **thin orchestrator**: capture + VAD + cleanup + loop + UI.
- Capture and VAD stay local; ASR (lib) and cleanup (LLM) are **swappable** so
  users can use their own GPU or a cloud service.
- Cross-platform target: Linux/WSL, macOS, Windows (capture via `ffmpeg`).
