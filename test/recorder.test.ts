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
    const recorder = pickRecorder(config, "/tmp/dictate-recorder-test.wav", 0.5)
    if (!recorder) return
    const bounded =
      recorder.cmd === "timeout" ||
      recorder.args.includes("-t") ||
      recorder.args.includes("-d") ||
      recorder.args.includes("trim")
    expect(bounded).toBe(true)
  })
})
