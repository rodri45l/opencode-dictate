import { describe, expect, test } from "bun:test"
import { pickRecorder, withDeadline, type CaptureConfig } from "../src/audio"

const config: CaptureConfig = {
  silenceMs: 900,
  maxMs: 60_000,
  startTimeoutMs: 4000,
  minSpeechMs: 300,
  vadThreshold: 0.05,
}

describe("withDeadline", () => {
  test("wraps the recorder so it stops itself", () => {
    const wrapped = withDeadline({ cmd: "parecord", args: ["--channels=1"] }, "60", true)
    expect(wrapped.cmd).toBe("timeout")
    expect(wrapped.args).toEqual(["-k", "3", "60", "parecord", "--channels=1"])
  })

  test("leaves the recorder as-is when timeout is unavailable", () => {
    const plain = { cmd: "parecord", args: ["--channels=1"] }
    expect(withDeadline(plain, "60", false)).toBe(plain)
  })
})

describe("pickRecorder", () => {
  // Whichever recorder this machine has, it must be unable to outlive the
  // utterance — otherwise a killed TUI leaves it holding the microphone.
  test("always returns a recorder that can stop itself", () => {
    const recorder = pickRecorder(config, 0.5)
    if (!recorder) return
    const bounded =
      recorder.cmd === "timeout" ||
      recorder.args.includes("-t") ||
      recorder.args.includes("-d") ||
      recorder.args.includes("trim")
    expect(bounded).toBe(true)
  })

  // Capture reads PCM from stdout, never from a file: ffmpeg on macOS buffers
  // file output in ~256 KB blocks, which leaves a file-polling VAD blind for the
  // first ~8 seconds of every utterance.
  test("streams raw PCM to stdout and never writes a file", () => {
    const recorder = pickRecorder(config, 0.5)
    if (!recorder) return
    const args = recorder.cmd === "timeout" ? recorder.args.slice(3) : recorder.args
    const streams = args.includes("-") || args.includes("--raw")
    expect(streams).toBe(true)
    expect(args.some((a) => a.endsWith(".wav"))).toBe(false)
  })
})
