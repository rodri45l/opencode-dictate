// Cross-platform microphone capture with endpointing.
//
// Terminals have no native mic API, so we drive a recorder subprocess (ffmpeg,
// parecord, arecord or sox — whichever is installed) and read 16 kHz mono PCM
// from its stdout. Streaming matters: ffmpeg on macOS buffers *file* output in
// ~256 KB blocks, so a VAD polling the file sees nothing for the first ~8 seconds
// of every capture (found on the macOS test — the indicator stayed grey while the
// mic was fine). Reading the pipe streams in real time, and nothing touches disk.
// Recording lives in *our* event loop, so one bad recorder can never spin the TUI.

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ensureAudioEnvironment } from "./detect"
import { adaptGain, CLIP_DETECT, loadGain, MAX_GAIN, saveGain } from "./gain"
import { voiceprint } from "./mfcc"
import { clippingRatio, decodePcm, meterLevel, periodicity, wavFromPcm } from "./speech"
import { hadSpeech, initialVadState, SILENCE_HANGOVER_MS, vadStep, type VadConfig } from "./vad"

export interface CaptureHandlers {
  onPhase(name: "speech" | "silence" | "recording" | "transcribing"): void
  onLevel(level: number): void
}

export interface CaptureResult {
  /** The utterance as a WAV, assembled in memory — no temp file anywhere. */
  wav: Buffer
  hadSpeech: boolean
  /** Stats kept for the hallucination guard downstream. */
  voicedMs: number
  loudest: number
  /** Quasi-periodicity of the clip (0..1); speech is periodic, knocks are not. */
  periodicity: number
  /** Share of samples at full scale; a mic knock saturates the input. */
  clipped: number
  /** Input gain applied to this capture, so the log can explain the levels. */
  gain: number
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
/** Bytes of 16-bit mono audio in one VAD tick (80 ms). */
const TICK_BYTES = Math.round((TICK_MS / 1000) * RATE) * 2
/** Windows drained per tick: macOS delivers ~1.4 s at a time, so we must catch up. */
const MAX_WINDOWS_PER_TICK = 25
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

/**
 * The recorder that ships inside this package, if one is built for this platform.
 *
 * It exists so installing the plugin is enough: miniaudio (MIT-0) talks to
 * CoreAudio/ALSA/PulseAudio/WASAPI directly, so nobody has to `brew install
 * ffmpeg` first. System tools stay as fallbacks for platforms we do not build for.
 */
export function bundledRecorder(config: CaptureConfig, gain: number): Recorder | null {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null
  if (!os) return null
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  let path: string
  try {
    path = fileURLToPath(new URL(`../bin/${os}-${arch}/opencode-dictate-recorder`, import.meta.url))
  } catch {
    return null
  }
  if (!existsSync(path)) return null
  // It stops itself, so no external deadline wrapper is needed.
  const args = ["--seconds", (config.maxMs / 1000).toFixed(0), "--gain", gain.toFixed(2)]
  // Device is optional: without it the recorder uses whatever the OS currently
  // treats as the default input, re-resolved on every capture — so plugging in a
  // microphone mid-session just works. An override may be an index (":1" or "1")
  // or a name substring, and a name is safer because indices get renumbered.
  const device = config.inputDevice?.trim()
  const index = device?.startsWith(":") ? device.slice(1) : device
  if (index && /^\d+$/.test(index)) args.push("--device-index", index)
  else if (device) args.push("--device-name", device)
  return { cmd: path, args }
}

export function pickRecorder(config: CaptureConfig, gain: number): Recorder | null {
  const maxSec = (config.maxMs / 1000).toFixed(0)
  const factor = gain.toFixed(2)
  // Prefer the recorder we ship: nothing to install, and it streams live.
  const bundled = bundledRecorder(config, gain)
  if (bundled) return bundled
  // Every recorder writes raw 16-bit mono PCM to stdout, never to a file: a pipe
  // streams immediately on every platform, while ffmpeg on macOS flushes file
  // output in ~256 KB blocks (≈8 s), which starves a file-polling VAD.
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
        "-f",
        "s16le",
        "-",
      ],
    }
  }
  // PulseAudio / ALSA recorders (Linux, incl. WSLg). parecord takes linear gain
  // 0..65536, so a hot RDP microphone is kept out of clipping before it is read;
  // arecord has no gain option.
  if (which("parecord")) {
    // --raw with no file writes to stdout; parecord has no duration option, so
    // the deadline comes from the wrapper.
    return withDeadline(
      {
        cmd: "parecord",
        args: ["--raw", "--format=s16le", `--rate=${RATE}`, "--channels=1", `--volume=${Math.round(gain * 65536)}`],
      },
      maxSec,
    )
  }
  if (which("arecord")) {
    // -t raw with "-" streams to stdout; -d is arecord's own deadline.
    return { cmd: "arecord", args: ["-f", "S16LE", "-r", String(RATE), "-c", "1", "-t", "raw", "-d", maxSec, "-"] }
  }
  if (which("sox")) {
    // "-" streams to stdout; "trim 0 <sec>" ends it at the deadline.
    return { cmd: "sox", args: ["-d", "-c", "1", "-r", String(RATE), "-t", "raw", "-", "trim", "0", maxSec, "vol", factor] }
  }
  return null
}

export function capture(config: CaptureConfig, handlers: CaptureHandlers): Promise<CaptureResult> {
  ensureAudioEnvironment()
  armReaper()
  // A fixed gain wins; otherwise trim automatically so a hot mic never clips.
  // An explicit setting is honoured rather than clamped up to the adaptive
  // floor: a very hot source needs far more attenuation than the floor allows,
  // and rounding 0.02 up to 0.05 silently defeated the option.
  const fixed =
    typeof config.inputGain === "number" ? Math.min(MAX_GAIN, Math.max(0.005, config.inputGain)) : undefined
  const gain = fixed ?? (config.autoGain === false ? 1 : loadGain())
  const recorder = pickRecorder(config, gain)
  if (!recorder) {
    const hint =
      process.platform === "linux"
        ? "install ffmpeg, parecord, arecord or sox"
        : "install ffmpeg — macOS and Windows have no parecord/arecord fallback"
    return Promise.reject(new Error(`no recorder found — ${hint}`))
  }

  return new Promise<CaptureResult>((resolve, reject) => {
    const child = spawn(recorder.cmd, recorder.args, { stdio: ["ignore", "pipe", "pipe"] })
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

    const chunks: Buffer[] = []
    let pending: Buffer = Buffer.alloc(0)
    let state = initialVadState()
    let stopped = false
    let errorText = ""

    child.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    })
    // Keep the recorder's own complaint: without it a failure is invisible, and
    // "no audio" looks identical to a quiet room.
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errorText.length < 2_048) errorText += chunk.toString()
    })

    const finish = () => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      clearTimeout(watchdog)
      killRecorder(child)

      const raw = Buffer.concat(chunks)
      if (raw.length === 0 && errorText.trim()) {
        reject(new Error(`recorder produced no audio (${recorder.cmd}): ${errorText.trim()}`))
        return
      }

      const wav = wavFromPcm(raw, RATE)
      // A single loud tick (a cough, a door, headphone bleed) is not speech:
      // hadSpeech also requires enough voiced audio, so noise never reaches
      // Whisper (which would otherwise invent a sentence).
      const spoken = hadSpeech(state, vadConfig)
      let strength = 0
      let clipped = 0
      let print: Float32Array | null = null
      try {
        const samples = decodePcm(wav, WAV_HEADER)
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
        wav,
        hadSpeech: spoken,
        voicedMs: state.voicedMs,
        loudest: state.loudest,
        periodicity: strength,
        clipped,
        gain,
        print,
      })
    }

    const tick = (peak: number): boolean => {
      const step = vadStep(state, peak, TICK_MS, vadConfig)
      state = step.state
      for (const event of step.events) handlers.onPhase(event)
      return state.done
    }

    const timer = setInterval(() => {
      // Drain whole 80 ms windows. A recorder can deliver ~1.4 s at once, so
      // catching up keeps the VAD in step with real time.
      let windows = 0
      let lastPeak = 0
      while (windows < MAX_WINDOWS_PER_TICK && pending.length >= TICK_BYTES) {
        const slice = pending.subarray(0, TICK_BYTES)
        pending = pending.subarray(TICK_BYTES)
        let peak = 0
        for (let i = 0; i + 1 < slice.length; i += 2) {
          const amp = Math.abs(slice.readInt16LE(i)) / 32768
          if (amp > peak) peak = amp
        }
        lastPeak = peak
        windows += 1
        if (tick(peak)) {
          handlers.onLevel(meterLevel(peak))
          finish()
          return
        }
      }
      if (windows === 0) {
        // Nothing arrived this tick: advance as silence so the start timeout and
        // end-of-speech logic still run when a recorder stalls.
        tick(0)
      }
      handlers.onLevel(meterLevel(lastPeak))
      if (state.done) finish()
    }, TICK_MS)

    // Belt and braces: if the tick loop ever stops making progress, stop anyway
    // rather than holding the microphone.
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
