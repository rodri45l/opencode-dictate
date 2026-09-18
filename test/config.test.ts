import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { base, loadConfig } from "../src/config"

// Passing `llm` keeps loadConfig off the real opencode config on disk.
const LLM = { url: "http://127.0.0.1:9999/v1", key: "", model: "test" }

const VOICE_VARS = [
  "VOICE_STT_URL",
  "VOICE_STT_KEY",
  "VOICE_STT_MODEL",
  "VOICE_LLM_URL",
  "VOICE_LLM_KEY",
  "VOICE_LLM_MODEL",
  "VOICE_BACKEND",
  "VOICE_COMMAND",
  "VOICE_SILENCE_MS",
  "VOICE_MAX_MS",
  "VOICE_START_TIMEOUT_MS",
  "VOICE_MIN_SPEECH_MS",
  "VOICE_VAD_THRESHOLD",
  "VOICE_SPEAKER",
  "VOICE_SPEAKER_THRESHOLD",
  "VOICE_SPEAKER_MIN_SAMPLES",
]

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const name of VOICE_VARS) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
})

afterEach(() => {
  for (const name of VOICE_VARS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

describe("base", () => {
  test("trims trailing slashes", () => {
    expect(base("http://x/v1/")).toBe("http://x/v1")
    expect(base("http://x/v1///")).toBe("http://x/v1")
    expect(base("http://x/v1")).toBe("http://x/v1")
  })
})

describe("loadConfig", () => {
  test("applies documented defaults", () => {
    const config = loadConfig({ llm: LLM })
    expect(config.stt).toBeNull()
    expect(config.backend).toBe("auto")
    expect(config.command).toBe("dictate")
    expect(config.silenceMs).toBe(900)
    expect(config.maxMs).toBe(60_000)
    expect(config.startTimeoutMs).toBe(4_000)
    expect(config.minSpeechMs).toBe(300)
    expect(config.vadThreshold).toBe(0.03)
    expect(config.speaker).toEqual({ enabled: false, threshold: 0.8, artifactThreshold: 0.9, minSamples: 8 })
  })

  test("accepts an STT url string and normalises it", () => {
    const config = loadConfig({ llm: LLM, stt: "http://127.0.0.1:8080/v1/" })
    expect(config.stt).toEqual({ url: "http://127.0.0.1:8080/v1", key: "", model: "whisper-1" })
  })

  test("accepts an STT object", () => {
    const config = loadConfig({ llm: LLM, stt: { url: "https://api.openai.com/v1", key: "sk-x", model: "whisper-1" } })
    expect(config.stt).toEqual({ url: "https://api.openai.com/v1", key: "sk-x", model: "whisper-1" })
  })

  test("falls back to environment variables", () => {
    process.env.VOICE_STT_URL = "http://env:1234/v1"
    process.env.VOICE_STT_KEY = "env-key"
    process.env.VOICE_BACKEND = "command"
    process.env.VOICE_COMMAND = "my-dictate"
    process.env.VOICE_SILENCE_MS = "1234"
    const config = loadConfig({ llm: LLM })
    expect(config.stt).toEqual({ url: "http://env:1234/v1", key: "env-key", model: "whisper-1" })
    expect(config.backend).toBe("command")
    expect(config.command).toBe("my-dictate")
    expect(config.silenceMs).toBe(1234)
  })

  test("options win over environment variables", () => {
    process.env.VOICE_SILENCE_MS = "1234"
    process.env.VOICE_COMMAND = "from-env"
    const config = loadConfig({ llm: LLM, silenceMs: 500, command: "from-option" })
    expect(config.silenceMs).toBe(500)
    expect(config.command).toBe("from-option")
  })

  test("ignores unparseable numerics", () => {
    process.env.VOICE_SILENCE_MS = "not-a-number"
    expect(loadConfig({ llm: LLM }).silenceMs).toBe(900)
  })

  test("a custom llm marks the provider as custom", () => {
    const config = loadConfig({ llm: "http://localhost:11434/v1/" })
    expect(config.llm).toEqual({ url: "http://localhost:11434/v1", key: "", model: "gpt-4o-mini", provider: "custom" })
  })
})
