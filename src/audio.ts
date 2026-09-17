// Cross-platform microphone capture with endpointing.
//
// Terminals have no native mic API, so we drive a recorder subprocess (ffmpeg,
// parecord, arecord or sox — whichever is installed) writing a 16 kHz mono WAV.
// We watch the growing file: the PCM gives us the live level, and a simple
// energy VAD decides where the utterance ends. Recording lives in *our* event
// loop, so one bad recorder can never spin the TUI.

import { spawn, spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { ensureAudioEnvironment } from "./detect"
import { voiceprint } from "./mfcc"
import { decodePcm, periodicity } from "./speech"
import { hadSpeech, initialVadState, SILENCE_HANGOVER_MS, vadStep, type VadConfig } from "./vad"

export interface CaptureHandlers {
  onPhase(name: "speech" | "silence" | "recording" | "transcribing"): void
  onLevel(level: number): void
}

export interface CaptureResult {
  wavPath: string
  hadSpeech: boolean
  /** Stats kept for the hallucination guard downstream. */
  voicedMs: number
  loudest: number
  /** Quasi-periodicity of the clip (0..1); speech is periodic, knocks are not. */
  periodicity: number
  /** MFCC voiceprint, only computed when speaker verification is enabled. */
  print: Float32Array | null
}

export interface CaptureConfig {
  silenceMs: number
  maxMs: number
  startTimeoutMs: number
  /** Voiced milliseconds required before a clip counts as an utterance. */
  minSpeechMs: number
  /** Peak amplitude above which a tick counts as voice. */
  vadThreshold: number
  speaker?: { enabled: boolean }
  inputDevice?: string
}

const RATE = 16_000
const TICK_MS = 80
const WAV_HEADER = 44

export function which(bin: string): boolean {
  // path.delimiter, not ":" — Windows PATH entries contain a drive colon, and
  // splitting on ":" there shreds every entry so nothing is ever found.
  const dirs = (process.env.PATH ?? "").split(delimiter)
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""]
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) if (existsSync(join(dir, bin + ext))) return true
  }
  return false
}

let cachedDevice: string | null | undefined

/** Ask ffmpeg which capture device to use. avfoundation/dshow have no "default". */
function defaultFfmpegDevice(): string | undefined {
  if (cachedDevice !== undefined) return cachedDevice ?? undefined
  cachedDevice = null
  const input = process.platform === "win32" ? "dummy" : ""
  const driver = process.platform === "win32" ? "dshow" : "avfoundation"
  let output = ""
  try {
    const result = spawnSync("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", driver, "-i", input], {
      encoding: "utf8",
      timeout: 4_000,
    })
    output = result.stderr ?? ""
  } catch {
    return undefined
  }
  const lines = output.split("\n")
  let inAudio = false
  for (const line of lines) {
    if (process.platform === "darwin") {
      if (/AVFoundation audio devices:/i.test(line)) {
        inAudio = true
        continue
      }
      const match = inAudio ? line.match(/\[\s*(\d+)\]\s+(.+)$/) : null
      if (match) {
        cachedDevice = `:${match[1]}`
        break
      }
    } else {
      if (/DirectShow audio devices/i.test(line)) {
        inAudio = true
        continue
      }
      const match = inAudio ? line.match(/"([^"]+)"/) : null
      if (match) {
        cachedDevice = `audio=${match[1]}`
        break
      }
    }
  }
  return cachedDevice ?? undefined
}

/** Normalise a device into the form the platform's ffmpeg input expects. */
export function ffmpegDeviceArgs(
  platform: NodeJS.Platform,
  given: string | undefined,
  probed: string | undefined,
): string[] {
  const device = given?.trim()
  switch (platform) {
    case "darwin": {
      // avfoundation wants "video:audio" indices, e.g. ":1".
      const dev = device ? (device.includes(":") ? device : `:${device}`) : (probed ?? ":0")
      return ["-f", "avfoundation", "-i", dev]
    }
    case "win32": {
      // dshow wants the literal device name, e.g. audio="Microphone (Realtek)".
      const dev = device ? (device.startsWith("audio=") ? device : `audio=${device}`) : (probed ?? "audio=default")
      return ["-f", "dshow", "-i", dev]
    }
    default:
      return ["-f", "pulse", "-i", device || "default"]
  }
}

function ffmpegInput(device?: string): string[] {
  return ffmpegDeviceArgs(process.platform, device, defaultFfmpegDevice())
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
    const hint =
      process.platform === "linux"
        ? "install ffmpeg, parecord, arecord or sox"
        : "install ffmpeg — macOS and Windows have no parecord/arecord fallback"
    return Promise.reject(new Error(`no recorder found — ${hint}`))
  }

  return new Promise<CaptureResult>((resolve, reject) => {
    const child = spawn(recorder.cmd, recorder.args, { stdio: ["ignore", "ignore", "pipe"] })
    handlers.onPhase("recording")

    const vadConfig: VadConfig = {
      threshold: config.vadThreshold,
      silenceMs: config.silenceMs,
      hangoverMs: SILENCE_HANGOVER_MS,
      minSpeechMs: config.minSpeechMs,
      startTimeoutMs: config.startTimeoutMs,
      maxMs: config.maxMs,
    }
    let offset = WAV_HEADER
    let state = initialVadState()
    let stopped = false

    const finish = () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      try {
        child.kill("SIGTERM")
      } catch {
        // already gone
      }
      // A single loud tick (a cough, a door, headphone bleed) is not speech:
      // hadSpeech also requires enough voiced audio, so noise never reaches
      // Whisper (which would otherwise invent a sentence).
      const spoken = hadSpeech(state, vadConfig)
      let strength = 0
      let print: Float32Array | null = null
      if (spoken) {
        try {
          const samples = decodePcm(readFileSync(wavPath), WAV_HEADER)
          strength = periodicity(samples, RATE)
          if (config.speaker?.enabled) print = voiceprint(samples, RATE)
        } catch {
          // unreadable clip — leave strength at 0, the guard will drop it
        }
      }
      resolve({
        wavPath,
        hadSpeech: spoken,
        voicedMs: state.voicedMs,
        loudest: state.loudest,
        periodicity: strength,
        print,
      })
    }

    const timer = setInterval(() => {
      const { peak, next } = drainPeak(wavPath, offset)
      offset = next
      handlers.onLevel(Math.min(1, peak * 1.8))

      const step = vadStep(state, peak, TICK_MS, vadConfig)
      state = step.state
      for (const event of step.events) handlers.onPhase(event)
      if (state.done) finish()
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
