// Configuration for the voice pipeline.
//
// Precedence: plugin options (from tui.json) > environment > auto/default.
// Everything is optional; sensible defaults are chosen where possible.

import { resolveOpencodeLlm } from "./llm"

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
  /** Provider id, e.g. "opencode-go", "deepseek", or "custom". */
  provider: string
}

export interface VoiceOptions {
  /** "http://…/v1" or { url, key, model } */
  stt?: string | { url?: string; key?: string; model?: string }
  /** Optional override; by default the LLM opencode is configured with is used. */
  llm?: string | { url?: string; key?: string; model?: string }
  /** Force the builtin pipeline or an external recorder/transcriber command. */
  backend?: "builtin" | "command"
  /** Command to run for backend "command" (default: "dictate" on PATH). */
  command?: string
  silenceMs?: number
  maxMs?: number
  startTimeoutMs?: number
  /** Recorder device override (e.g. an avfoundation index). */
  inputDevice?: string
}

export interface VoiceConfig {
  stt: SttConfig | null
  llm: LlmConfig | null
  backend: "builtin" | "command" | "auto"
  /** Command used by backend "command". */
  command: string
  silenceMs: number
  maxMs: number
  startTimeoutMs: number
  inputDevice?: string
}

/** Default local STT server (the reference faster-whisper server). */
export const LOCAL_STT_URL = "http://127.0.0.1:8080/v1"

function env(name: string): string {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] ?? ""
  ).trim()
}

function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback
}

/** Trim a trailing slash so we can append paths consistently. */
export function base(url: string): string {
  return url.replace(/\/+$/, "")
}

function sttFrom(value: VoiceOptions["stt"]): SttConfig | null {
  if (!value) return null
  if (typeof value === "string") return { url: base(value), key: "", model: "whisper-1" }
  if (!value.url) return null
  return { url: base(value.url), key: value.key ?? "", model: value.model ?? "whisper-1" }
}

function llmFrom(value: VoiceOptions["llm"]): LlmConfig | null {
  if (!value) return null
  if (typeof value === "string") return { url: base(value), key: "", model: "gpt-4o-mini", provider: "custom" }
  if (!value.url) return null
  return { url: base(value.url), key: value.key ?? "", model: value.model ?? "gpt-4o-mini", provider: "custom" }
}

export function loadConfig(options: VoiceOptions = {}): VoiceConfig {
  const envStt = env("VOICE_STT_URL")
  const envLlm = env("VOICE_LLM_URL")

  // STT: options > env > null (the plugin probes the local server, then falls
  // back to the external command).
  const stt =
    sttFrom(options.stt) ??
    (envStt ? { url: base(envStt), key: env("VOICE_STT_KEY"), model: env("VOICE_STT_MODEL") || "whisper-1" } : null)

  // LLM: options > env > whatever opencode itself is configured with.
  const llm =
    llmFrom(options.llm) ??
    (envLlm
      ? {
          url: base(envLlm),
          key: env("VOICE_LLM_KEY"),
          model: env("VOICE_LLM_MODEL") || "gpt-4o-mini",
          provider: "custom",
        }
      : resolveOpencodeLlm())

  return {
    stt,
    llm,
    backend: options.backend ?? ((env("VOICE_BACKEND") as VoiceConfig["backend"]) || "auto"),
    command: options.command ?? (env("VOICE_COMMAND") || "dictate"),
    silenceMs: num(options.silenceMs ?? Number(env("VOICE_SILENCE_MS")), 900),
    maxMs: num(options.maxMs ?? Number(env("VOICE_MAX_MS")), 60_000),
    startTimeoutMs: num(options.startTimeoutMs ?? Number(env("VOICE_START_TIMEOUT_MS")), 4_000),
    inputDevice: options.inputDevice ?? (env("VOICE_INPUT_DEVICE") || undefined),
  }
}
