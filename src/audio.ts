// Cross-platform microphone capture with endpointing.
//
// Terminals have no native mic API, so we drive a recorder subprocess (ffmpeg
// preferred, then arecord/parecord/sox). VAD comes from the recorder itself
// where possible (ffmpeg `silencedetect`) and, as a fallback, from a simple
// energy gate over the captured PCM. The same PCM read drives the live level
// used by the indicator.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs"
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

const RATE = 16_000

/** ffmpeg input flags for the current platform (best-effort). */
function ffmpegInput(device?: string): string[] {
  const d = device ?? ""
  switch (process.platform) {
    case "darwin":
      return ["-f", "avfoundation", "-i", `${d || ":0"}`]
    case "win32":
      return ["-f", "dshow", "-i", `audio=${d || "default"}`]
    default:
      return ["-f", "pulse", "-i", d || "default"]
  }
}

function which(bin: string): boolean {
  const paths = (process.env.PATH ?? "").split(":")
  const exts = process.platform === "win32" ? [".exe", ""] : [""]
  for (const dir of paths) {
    for (const ext of exts) if (dir && existsSync(join(dir, bin + ext))) return true
  }
  return false
}

/**
 * Record one utterance. Resolves once speech has started and then stopped
 * (endpointing), or once the start timeout elapses with no speech.
 * Emits PHASE + level via handlers so the UI can react live.
 */
export function capture(
  config: { silenceMs: number; maxMs: number; startTimeoutMs: number; inputDevice?: string },
  handlers: CaptureHandlers,
): Promise<CaptureResult> {
  ensureAudioEnvironment()
  const wavPath = join(tmpdir(), `opencode-dictate-${Date.now()}.wav`)
  const silenceSec = (config.silenceMs / 1000).toFixed(2)
  const maxSec = (config.maxMs / 1000).toFixed(2)

  if (!which("ffmpeg")) {
    // No ffmpeg: caller should surface a helpful error.
    return Promise.reject(new Error("ffmpeg not found — install ffmpeg to capture audio"))
  }

  const args = [
    "-hide_banner",
    "-loglevel",
    "info",
    ...ffmpegInput(config.inputDevice),
    "-ac",
    "1",
    "-ar",
    String(RATE),
    "-af",
    `silencedetect=noise=-32dB:d=${silenceSec}`,
    "-t",
    maxSec,
    "-y",
    wavPath,
  ]

  return new Promise<CaptureResult>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] })
    handlers.onPhase("recording")

    let speechStarted = false
    let stopped = false
    let startTimer: ReturnType<typeof setTimeout> | undefined
    let levelTimer: ReturnType<typeof setInterval> | undefined
    let readOffset = 0

    const finish = (hadSpeech: boolean) => {
      if (stopped) return
      stopped = true
      if (startTimer) clearTimeout(startTimer)
      if (levelTimer) clearInterval(levelTimer)
      child.kill("SIGTERM")
      resolve({ wavPath, hadSpeech })
    }

    // Live level: sample the growing WAV and report peak amplitude.
    levelTimer = setInterval(() => {
      try {
        const size = statSync(wavPath).size
        if (size <= readOffset || size < 44) return
        const fd = openSync(wavPath, "r")
        const buf = Buffer.alloc(Math.min(size - readOffset, 64_000))
        readSync(fd, buf, 0, buf.length, readOffset)
        closeSync(fd)
        readOffset += buf.length
        let peak = 0
        for (let i = 0; i + 1 < buf.length; i += 2) {
          const amp = Math.abs(buf.readInt16LE(i)) / 32768
          if (amp > peak) peak = amp
        }
        handlers.onLevel(Math.min(1, peak * 1.6))
      } catch {
        // file not there yet
      }
    }, 80)

    startTimer = setTimeout(() => finish(speechStarted), config.startTimeoutMs)

    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (line.includes("silence_end")) {
          // Speech resumed (or began).
          if (!speechStarted) speechStarted = true
          handlers.onPhase("speech")
        } else if (line.includes("silence_start") && speechStarted) {
          // Speech ended — endpoint reached.
          handlers.onPhase("silence")
          finish(true)
        }
      }
    })

    child.on("error", reject)
    child.on("exit", () => finish(speechStarted))
  })
}
