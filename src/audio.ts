// Cross-platform microphone capture with endpointing.
//
// Terminals have no native mic API, so we drive a recorder subprocess (ffmpeg,
// parecord, arecord or sox — whichever is installed) writing a 16 kHz mono WAV.
// We watch the growing file: the PCM gives us the live level, and a simple
// energy VAD decides where the utterance ends. Recording lives in *our* event
// loop, so one bad recorder can never spin the TUI.

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { ensureAudioEnvironment } from "./detect"
import { adaptGain, clampGain, CLIP_DETECT, loadGain, saveGain } from "./gain"
import { voiceprint } from "./mfcc"
import { clippingRatio, decodePcm, periodicity } from "./speech"
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
  /** Share of samples at full scale; a mic knock saturates the input. */
  clipped: number
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
  /** Fixed input gain 0..1; when set, automatic adaptation is disabled. */
  inputGain?: number
  /** Adapt the input gain from clipping/level (default true). */
  autoGain?: boolean
  inputDevice?: string
}

const RATE = 16_000
const TICK_MS = 80
const WAV_HEADER = 44
const TEMP_PREFIX = "opencode-dictate-"
/**
 * Temp WAVs older than this were left by a run that died mid-capture and could
 * not unlink them. A live utterance is hard-capped at maxMs (60s) plus the
 * recorder's deadline, so anything past two minutes is certainly garbage.
 */
const STALE_MS = 2 * 60_000
/** Grace period after a capture's own deadline before we force it to stop. */
const WATCHDOG_SLACK_MS = 5_000

// Every recorder we start is tracked here, so a capture can never be abandoned
// holding the microphone: leaving conversation mode or the TUI dying outright
// kills whatever is still running.
const live = new Set<ChildProcess>()
let reaperArmed = false

function armReaper(): void {
  if (reaperArmed) return
  reaperArmed = true
  process.on("exit", () => {
    for (const child of live) {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
    }
    live.clear()
  })
}

/** SIGTERM now, SIGKILL shortly after — recorders must never survive a stop. */
function killRecorder(child: ChildProcess): void {
  if (!live.delete(child)) return
  try {
    child.kill("SIGTERM")
  } catch {
    // already gone
  }
  const hard = setTimeout(() => {
    try {
      child.kill("SIGKILL")
    } catch {
      // reaped between the two signals
    }
  }, 400)
  hard.unref?.()
}

/** Stop every in-flight recorder (used when conversation mode is turned off). */
export function stopActiveRecorders(): void {
  for (const child of [...live]) killRecorder(child)
}

/** Delete temp WAVs an earlier crashed run never cleaned up. */
function sweepStaleTemps(): void {
  const dir = tmpdir()
  const cutoff = Date.now() - STALE_MS
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(".wav")) continue
      const path = join(dir, name)
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
      } catch {
        // vanished under us
      }
    }
  } catch {
    // unreadable tmpdir — nothing to sweep
  }
}

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

/**
 * Give a recorder a deadline of its own. Killing by signal is not enough: if the
 * TUI dies abruptly (Ctrl+D through the WSL relay SIGKILLs it) nothing runs our
 * cleanup, and an untouched recorder keeps the microphone and its file forever.
 * GNU timeout enforces the limit itself and forwards the SIGTERM we send, so a
 * stranded recorder still stops on its own. `hasTimeout` is injectable for tests.
 */
export function withDeadline(recorder: Recorder, maxSec: string, hasTimeout = which("timeout")): Recorder {
  if (!hasTimeout) return recorder
  return { cmd: "timeout", args: ["-k", "3", maxSec, recorder.cmd, ...recorder.args] }
}

export function pickRecorder(config: CaptureConfig, wavPath: string, gain: number): Recorder | null {
  const maxSec = (config.maxMs / 1000).toFixed(0)
  const factor = gain.toFixed(2)
  if (which("ffmpeg")) {
    return {
      cmd: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        ...ffmpegInput(config.inputDevice),
        "-af",
        `volume=${factor}`,
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
  // PulseAudio / ALSA recorders (Linux, incl. WSLg). parecord takes linear gain
  // 0..65536, so we can keep a hot RDP microphone out of clipping before it is
  // written; arecord has no gain option.
  if (which("parecord")) {
    // parecord has no duration option, so the deadline comes from the wrapper.
    return withDeadline(
      {
        cmd: "parecord",
        args: [
          "--format=s16le",
          `--rate=${RATE}`,
          "--channels=1",
          `--volume=${Math.round(gain * 65536)}`,
          "--file-format=wav",
          wavPath,
        ],
      },
      maxSec,
    )
  }
  if (which("arecord")) {
    // -d is arecord's own duration in seconds; -t selects the file type.
    return { cmd: "arecord", args: ["-f", "S16LE", "-r", String(RATE), "-c", "1", "-t", "wav", "-d", maxSec, wavPath] }
  }
  if (which("sox")) {
    // "trim 0 <sec>" ends the recording after the deadline.
    return {
      cmd: "sox",
      args: ["-d", "-c", "1", "-r", String(RATE), "-t", "wav", wavPath, "trim", "0", maxSec, "vol", factor],
    }
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
  armReaper()
  sweepStaleTemps()
  const wavPath = join(tmpdir(), `${TEMP_PREFIX}${Date.now()}.wav`)
  // A fixed gain wins; otherwise trim automatically so a hot mic never clips.
  const fixed = typeof config.inputGain === "number" ? clampGain(config.inputGain) : undefined
  const gain = fixed ?? (config.autoGain === false ? 1 : loadGain())
  const recorder = pickRecorder(config, wavPath, gain)
  if (!recorder) {
    const hint =
      process.platform === "linux"
        ? "install ffmpeg, parecord, arecord or sox"
        : "install ffmpeg — macOS and Windows have no parecord/arecord fallback"
    return Promise.reject(new Error(`no recorder found — ${hint}`))
  }

  return new Promise<CaptureResult>((resolve, reject) => {
    const child = spawn(recorder.cmd, recorder.args, { stdio: ["ignore", "ignore", "pipe"] })
    live.add(child)
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
      clearTimeout(watchdog)
      killRecorder(child)
      // A single loud tick (a cough, a door, headphone bleed) is not speech:
      // hadSpeech also requires enough voiced audio, so noise never reaches
      // Whisper (which would otherwise invent a sentence).
      const spoken = hadSpeech(state, vadConfig)
      let strength = 0
      let clipped = 0
      let print: Float32Array | null = null
      try {
        const samples = decodePcm(readFileSync(wavPath), WAV_HEADER)
        clipped = clippingRatio(samples)
        if (spoken) {
          strength = periodicity(samples, RATE)
          if (config.speaker?.enabled) print = voiceprint(samples, RATE)
        }
      } catch {
        // unreadable clip — leave strength at 0, the guard will drop it
      }
      // Adapt the gain for next time: back off when saturated, creep up when quiet.
      if (fixed === undefined && config.autoGain !== false && (spoken || clipped >= CLIP_DETECT)) {
        const next = adaptGain(gain, clipped, state.loudest)
        if (Math.abs(next - gain) > 1e-6) saveGain(next)
      }
      resolve({
        wavPath,
        hadSpeech: spoken,
        voicedMs: state.voicedMs,
        loudest: state.loudest,
        periodicity: strength,
        clipped,
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

    // Belt and braces: if the tick loop ever stops making progress, stop anyway
    // rather than holding the microphone and writing an ever-growing file.
    const watchdog = setTimeout(finish, config.maxMs + WATCHDOG_SLACK_MS)
    watchdog.unref?.()

    child.on("error", (error) => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      clearTimeout(watchdog)
      live.delete(child)
      reject(error)
    })
    child.on("exit", () => finish())
  })
}
