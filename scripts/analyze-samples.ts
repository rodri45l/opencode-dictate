// Replay recorded samples through the real guards, so thresholds can be tuned
// against actual audio instead of guesswork.
//
//   bun run samples:analyze
//
// Reads ~/.local/share/opencode/opencode-dictate/samples/<label>/*.wav and
// prints, per clip, the same numbers the pipeline logs (voiced, peak, pitch,
// clip) plus the voiceprint similarity and the verdict the guards would give.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { clippingRatio, decodePcm, periodicity } from "../src/speech"
import { voiceprint } from "../src/mfcc"
import { isSilenceHallucination, isWeakSpeech } from "../src/hallucination"
import { loadProfile, similarity } from "../src/voiceprint"
import { initialVadState, SILENCE_HANGOVER_MS, vadStep, type VadConfig } from "../src/vad"

const RATE = 16_000
const TICK_MS = 80
const CHUNK = (TICK_MS / 1000) * RATE
const WAV_HEADER = 44
const THRESHOLD = Number(process.env.VOICE_VAD_THRESHOLD ?? "0.05")

const vad: VadConfig = {
  threshold: THRESHOLD,
  silenceMs: 900,
  hangoverMs: SILENCE_HANGOVER_MS,
  minSpeechMs: 300,
  startTimeoutMs: 4_000,
  maxMs: 60_000,
}

const root = process.env.SAMPLES_DIR ?? join(homedir(), ".local", "share", "opencode", "opencode-dictate", "samples")

function analyze(path: string) {
  const samples = decodePcm(readFileSync(path), WAV_HEADER)
  let state = initialVadState()
  for (let offset = 0; offset + CHUNK <= samples.length; offset += CHUNK) {
    let peak = 0
    for (let i = offset; i < offset + CHUNK; i++) {
      const value = Math.abs(samples[i])
      if (value > peak) peak = value
    }
    state = vadStep(state, peak, TICK_MS, vad).state
  }
  return {
    voicedMs: state.voicedMs,
    loudest: state.loudest,
    pitch: periodicity(samples, RATE),
    clip: clippingRatio(samples),
    print: voiceprint(samples, RATE),
  }
}

function labels(): string[] {
  try {
    return readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory())
  } catch {
    return []
  }
}

const profile = loadProfile()
console.log(`profile: ${profile.count} sample(s) enrolled`)
console.log(`vad threshold ${THRESHOLD}\n`)

let total = 0
let dropped = 0
let i = 0

for (const label of labels()) {
  const dir = join(root, label)
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".wav")).sort()) {
    const path = join(dir, file)
    const stats = analyze(path)
    const score = stats.print ? similarity(stats.print, profile) : null

    // The audio-level guards (a pop never reaches the transcript step).
    const audio = {
      voicedMs: stats.voicedMs,
      loudest: stats.loudest,
      periodicity: stats.pitch,
      clipped: stats.clip,
    }
    const weak = isWeakSpeech(audio, THRESHOLD * 1.5)
    const hallucination = isSilenceHallucination("Thank you.", audio)
    const verdict = weak ? "DROP weak/clipped" : hallucination ? "DROP artifact" : "audio ok"

    const similarityText = score === null ? "  n/a" : score.toFixed(2)
    console.log(
      [
        label.padEnd(7),
        file.padEnd(18),
        `voiced=${String(stats.voicedMs).padStart(5)}ms`,
        `peak=${stats.loudest.toFixed(3)}`,
        `pitch=${stats.pitch.toFixed(2)}`,
        `clip=${stats.clip.toFixed(3)}`,
        `sim=${similarityText}`,
        verdict,
      ].join("  "),
    )

    total++
    if (verdict !== "audio ok") dropped++
    i++
  }
}

if (total === 0) {
  console.log("no samples yet — record some with: ./scripts/record-sample.sh speech 4")
} else {
  console.log(`\n${dropped}/${total} clips would be dropped by the audio guards`)
}
