// Cross-platform microphone capture with endpointing.
//
// Terminals have no native mic API, so we drive a recorder subprocess (ffmpeg,
// parecord, arecord or sox — whichever is installed) writing a 16 kHz mono WAV.
// We watch the growing file: the PCM gives us the live level, and a simple
// energy VAD decides where the utterance ends. Recording lives in *our* event
// loop, so one bad recorder can never spin the TUI.

import { spawn } from "node:child_process"
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureAudioEnvironment } from "./detect"

export interface CaptureHandlers {
  onPhase(name: "speech" | "silence" | "recording" | "transcribing"): void
  onLevel(level: number): void
}

export interface CaptureResult {
  wavPath: string
  hadSpeech: boolean
}

export interface CaptureConfig {
  silenceMs: number
  maxMs: number
  startTimeoutMs: number
  /** Voiced milliseconds required before a clip counts as an utterance. */
  minSpeechMs: number
  inputDevice?: string
}

const RATE = 16_000
const TICK_MS = 80
const WAV_HEADER = 44
// Short pauses between words are not "finished speaking". Only report silence
// once a dip lasts this long, otherwise the indicator flickers to idle mid-word.
const SILENCE_HANGOVER_MS = 350

function which(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(":")
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""]
  for (const dir of dirs) {
    for (const ext of exts) if (dir && existsSync(join(dir, bin + ext))) return true
  }
  return false
}

function ffmpegInput(device?: string): string[] {
  const d = device ?? ""
  switch (process.platform) {
    case "darwin":
      return ["-f", "avfoundation", "-i", d || ":0"]
    case "win32":
      return ["-f", "dshow", "-i", `audio=${d || "default"}`]
    default:
      return ["-f", "pulse", "-i", d || "default"]
  }
}

interface Recorder {
  cmd: string
  args: string[]
}

function pickRecorder(config: CaptureConfig, wavPath: string): Recorder | null {
  const maxSec = (config.maxMs / 1000).toFixed(0)
  if (which("ffmpeg")) {
    return {
      cmd: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        ...ffmpegInput(config.inputDevice),
        "-ac",
        "1",
        "-ar",
        String(RATE),
        "-t",
        maxSec,
        "-y",
        wavPath,
      ],
    }
  }
  // PulseAudio / ALSA recorders (Linux, incl. WSLg).
  if (which("parecord")) {
    return {
      cmd: "parecord",
      args: ["--format=s16le", `--rate=${RATE}`, "--channels=1", "--file-format=wav", wavPath],
    }
  }
  if (which("arecord")) {
    return { cmd: "arecord", args: ["-f", "S16LE", "-r", String(RATE), "-c", "1", "-t", "wav", wavPath] }
  }
  if (which("sox")) {
    return { cmd: "sox", args: ["-d", "-c", "1", "-r", String(RATE), "-t", "wav", wavPath] }
  }
  return null
}

/** Read new 16-bit samples from the growing WAV and return the peak (0..1). */
function drainPeak(path: string, offset: number): { peak: number; next: number } {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return { peak: 0, next: offset }
  }
  if (size <= offset || size <= WAV_HEADER) return { peak: 0, next: offset }
  const length = Math.min(size - offset, 128_000)
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, "r")
  try {
    readSync(fd, buffer, 0, length, offset)
  } finally {
    closeSync(fd)
  }
  let peak = 0
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const amp = Math.abs(buffer.readInt16LE(i)) / 32768
    if (amp > peak) peak = amp
  }
  return { peak, next: offset + length }
}

export function capture(config: CaptureConfig, handlers: CaptureHandlers): Promise<CaptureResult> {
  ensureAudioEnvironment()
  const wavPath = join(tmpdir(), `opencode-dictate-${Date.now()}.wav`)
  const recorder = pickRecorder(config, wavPath)
  if (!recorder) {
    return Promise.reject(new Error("no recorder found — install ffmpeg, parecord, arecord or sox"))
  }

  return new Promise<CaptureResult>((resolve, reject) => {
    const child = spawn(recorder.cmd, recorder.args, { stdio: ["ignore", "ignore", "pipe"] })
    handlers.onPhase("recording")

    const threshold = Number(process.env.VOICE_VAD_THRESHOLD ?? "0.025") || 0.025
    let offset = WAV_HEADER
    let spoken = false
    let voicedMs = 0
    let loudest = 0
    let quietFor = 0
    let elapsed = 0
    let stopped = false
    let silent = false

    // A single loud tick (a cough, a door, headphone bleed) is not speech. Only
    // report an utterance once enough voiced audio accumulated — otherwise we
    // hand pure noise to Whisper and it invents a sentence.
    const finish = () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      try {
        child.kill("SIGTERM")
      } catch {
        // already gone
      }
      resolve({ wavPath, hadSpeech: spoken && voicedMs >= config.minSpeechMs })
    }

    const timer = setInterval(() => {
      const { peak, next } = drainPeak(wavPath, offset)
      offset = next
      elapsed += TICK_MS

      const level = Math.min(1, peak * 1.8)
      handlers.onLevel(level)
      const voicing = peak > threshold

      if (voicing) {
        voicedMs += TICK_MS
        if (peak > loudest) loudest = peak
        quietFor = 0
        // Announce speech on the first voice and again whenever speech resumes
        // after a pause, so the indicator goes back to red for the whole turn.
        if (!spoken || silent) {
          spoken = true
          silent = false
          handlers.onPhase("speech")
        }
      } else if (spoken) {
        quietFor += TICK_MS
        if (!silent && quietFor >= SILENCE_HANGOVER_MS) {
          silent = true
          handlers.onPhase("silence")
        }
        if (quietFor >= config.silenceMs) return finish()
      } else if (elapsed >= config.startTimeoutMs) {
        return finish()
      }

      if (elapsed >= config.maxMs) finish()
    }, TICK_MS)

    child.on("error", (error) => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      reject(error)
    })
    child.on("exit", () => finish())
  })
}
