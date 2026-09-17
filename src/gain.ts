// Input gain control. A hot microphone (especially the RDP source under WSLg)
// clips, and clipped audio wrecks the VAD, the pitch estimate and the voiceprint
// — so the plugin trims the level itself instead of asking the user to.
//
// The gain is applied by the recorder (parecord --volume / ffmpeg volume / sox
// vol) and adapted from what we actually captured: back off when the clip is
// saturated, creep up when it is too quiet. The value persists across runs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const DEFAULT_GAIN = 0.8
export const MIN_GAIN = 0.2
export const MAX_GAIN = 1
/** Above this share of saturated samples we clearly need to back off. */
export const CLIP_DETECT = 0.005
/** Below this peak the input is unnecessarily quiet. */
export const QUIET_PEAK = 0.12
const DOWN = 0.7
const UP = 1.15

export const GAIN_PATH = join(homedir(), ".local", "share", "opencode", "opencode-dictate", "audio.json")

export function clampGain(gain: number): number {
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain))
}

/** Next gain given what the last capture looked like. Pure, so it is testable. */
export function adaptGain(gain: number, clipped: number, peak: number): number {
  if (clipped >= CLIP_DETECT) return clampGain(gain * DOWN)
  if (peak < QUIET_PEAK) return clampGain(gain * UP)
  return clampGain(gain)
}

export function loadGain(path = GAIN_PATH): number {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { gain?: number }
    if (typeof raw?.gain === "number") return clampGain(raw.gain)
  } catch {
    // no saved gain yet
  }
  return DEFAULT_GAIN
}

export function saveGain(gain: number, path = GAIN_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ gain: clampGain(gain) }, null, 2)}\n`)
  } catch {
    // best effort: losing the value just means re-adapting
  }
}
