// Reuse the LLM opencode itself is configured with, so users only have to set
// up speech-to-text. opencode does not expose a generic completion call to
// plugins, so we resolve the model + credential it already stores and call the
// provider's OpenAI-compatible endpoint directly.
//
// Resolution: prefers `small_model` (cheap, used for titles) then `model`, from
// ~/.config/opencode/opencode.json; the key comes from opencode's auth.json.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { LlmConfig } from "./config"

const OPENCODE_CONFIG = join(homedir(), ".config", "opencode", "opencode.json")
const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json")

// OpenAI-compatible base URLs for the providers we can drive directly.
const BASES: Record<string, string> = {
  "opencode-go": "https://opencode.ai/zen/go/v1",
  opencode: "https://opencode.ai/zen/v1",
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** The LLM opencode is configured with, or null if we can't drive it. */
export function resolveOpencodeLlm(): LlmConfig | null {
  const config = readJson(OPENCODE_CONFIG)
  const ref = String(config.small_model ?? config.model ?? "")
  if (!ref.includes("/")) return null

  const [provider, ...rest] = ref.split("/")
  const model = rest.join("/")
  const url = BASES[provider]
  if (!url || !model) return null

  const auth = readJson(AUTH_FILE)[provider] as { key?: string } | undefined
  if (!auth?.key) return null

  return { url, key: auth.key, model, provider }
}
