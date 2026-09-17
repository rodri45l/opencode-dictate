// Configuration for the voice pipeline, resolved from the environment.
// Everything is optional; a sensible default is chosen where possible.

export interface SttConfig {
  /** OpenAI-compatible /audio/transcriptions endpoint (local server or cloud). */
  url: string
  key: string
  model: string
}

export interface LlmConfig {
  /** OpenAI-compatible chat/completions endpoint, for cleanup + control sentinels. */
  url: string
  key: string
  model: string
}

export interface VoiceConfig {
  /** Hard override for how audio is recorded (shell-ish argv template). */
  recorder: string | null
  /** Speech-to-text. Null disables the builtin backend. */
  stt: SttConfig | null
  /** Optional cleanup LLM. Null = use the raw transcript (no voice commands). */
  llm: LlmConfig | null
  /** Milliseconds of silence that ends an utterance. */
  silenceMs: number
  /** Hard cap on a single utterance. */
  maxMs: number
  /** How long to wait for speech to start before giving up. */
  startTimeoutMs: number
}

function env(name: string): string {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] ?? ""
  ).trim()
}

function num(name: string, fallback: number): number {
  const value = Number(env(name))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** Trim a trailing slash so we can append paths consistently. */
export function base(url: string): string {
  return url.replace(/\/+$/, "")
}

export function loadConfig(): VoiceConfig {
  const sttUrl = env("VOICE_STT_URL")
  const llmUrl = env("VOICE_LLM_URL")

  return {
    recorder: env("VOICE_RECORDER") || null,
    stt: sttUrl
      ? { url: base(sttUrl), key: env("VOICE_STT_KEY"), model: env("VOICE_STT_MODEL") || "whisper-1" }
      : null,
    llm: llmUrl
      ? { url: base(llmUrl), key: env("VOICE_LLM_KEY"), model: env("VOICE_LLM_MODEL") || "gpt-4o-mini" }
      : null,
    silenceMs: num("VOICE_SILENCE_MS", 900),
    maxMs: num("VOICE_MAX_MS", 60_000),
    startTimeoutMs: num("VOICE_START_TIMEOUT_MS", 4_000),
  }
}
