# Contributing

Small, focused pull requests are welcome. Most useful first: reproduce the problem
with the debug log, because the plugin logs a decision line for every utterance.

## Development loop

```bash
git clone https://github.com/rodri45l/opencode-dictate
cd opencode-dictate
bun test           # 106 tests, no network, no microphone needed
bun run typecheck
bun run build      # builds dist/index.js and the TUI entry via scripts/build-tui.mjs
```

To run your changes in opencode, point `tui.json` at the source instead of the
published package:

```bash
mkdir -p ~/.config/opencode/tui-plugins/opencode-dictate
cp src/* ~/.config/opencode/tui-plugins/opencode-dictate/
```

```jsonc
"plugin": [["./tui-plugins/opencode-dictate/index.tsx", { "debug": true }]]
```

Restart opencode after copying — a file plugin is loaded per process.

## The recorder

`recorder/recorder.c` is a small miniaudio (MIT-0) program that writes 16 kHz mono
PCM to stdout and stops itself on a wall-clock deadline. Build it for your machine
with `scripts/build-recorder.sh`; the binaries live in `bin/<os>-<arch>/` and are
shipped in the npm package.

Two rules it must keep, both learned the hard way:

- **Never buffer.** Stream and flush every callback. ffmpeg's file buffering on
  macOS left the VAD blind for ~8 seconds per utterance.
- **Time out on the clock, not on audio.** If the OS withholds the microphone no
  callback ever arrives, and waiting for samples hangs forever.

## Writing a TUI plugin (the trap we fell into)

opencode applies its Solid JSX transform only to files **outside** `node_modules`:

```
bun-plugin-solid onLoad filter: /^(?!.*node_modules).*\.[cm]?[jt]sx?$/
```

So a plugin installed from npm that ships raw `.tsx` is loaded untransformed, binds
to its own copy of the runtime, and the host cannot render its slots — the logic
runs while the UI silently never draws. That is why this package ships a compiled
entry (`dist/tui.js`, built by `scripts/build-tui.mjs` with `babel-preset-solid`,
`moduleName: "@opentui/solid"`, `generate: "universal"`) and keeps the runtime
external, so the host maps it to its own instance.
