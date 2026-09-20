// Optional LLM post-processing: clean the transcript for a coding context and
// classify spoken control commands into sentinels the plugin matches exactly.
// The model makes the decision; we only match tokens.
//
// Two response modes:
//   prose      — the model answers in text and may embed a sentinel token. Cloud
//                gateways vary in structured-output support, so this stays the
//                fallback for them.
//   structured — the model answers with JSON {"text","action"}, constrained to the
//                actions that make sense in this mode. A local server with a JSON
//                schema or grammar cannot return an invalid option, which is a large
//                part of why running the model locally is worth it.

import { randomUUID } from "node:crypto"
import type { LlmConfig } from "./config"
import { actionToken, allowedActions, type CleanAction } from "./sentinels"

const BASE = [
  "You clean up raw speech-to-text for a software engineer.",
  "Fix punctuation and casing, remove filler words, and correct software terms misheard as English homophones (\"Jason\"->JSON, \"cash\"->cache, \"pie\"->pi, \"bullion\"->boolean).",
  "Do not answer questions, do not add commentary, do not translate. Output only the cleaned text.",
].join(" ")

const CONTROL = [
  "CONTROL MODE: the speaker may be giving the assistant a short command.",
  "Emit [[CONVERSATION_OFF]] ONLY if they ask to leave the handsfree conversation mode itself (e.g. \"stop conversation mode\").",
  "Emit [[STOP]] ONLY if they tell the assistant to stop what it is doing right now (e.g. \"stop\", \"stop it\", \"para\", \"hold on\").",
  "Otherwise output the cleaned transcript with no token. Sentences that merely contain these words are prompts (e.g. \"stop the server\", \"how do I stop the process\"). When unsure, output the cleaned transcript.",
].join(" ")

const PERMISSION = [
  "The speaker is replying to a tool-permission prompt. Output EXACTLY ONE token:",
  "[[ALLOW]] to approve once, [[ALWAYS]] to approve permanently, [[DENY]] to refuse.",
  "If it is not clearly one of these, output the cleaned transcript instead.",
].join(" ")

export interface CleanOptions {
  control: boolean
  permission: boolean
}

/** The JSON contract, described in words for models that ignore response_format. */
function structuredRules(options: CleanOptions): string {
  return [
    "Reply with a single JSON object and nothing else:",
    `{"text": "<cleaned transcript>", "action": "<one of: ${allowedActions(options).join(" | ")}>"}`,
    'Put the cleaned transcript in "text"; never include the action word inside it.',
    'Use "none" unless the speaker is clearly giving one of the other commands.',
    'When unsure, use "none" — a normal prompt must survive as a normal prompt.',
  ].join(" ")
}

/** Models sometimes fence their JSON or wrap it in a sentence. */
function asJsonObject(content: string): Record<string, unknown> | null {
  const parse = (candidate: string): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(candidate) as unknown
      return value && typeof value === "object" ? (value as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const direct = parse(content)
  if (direct) return direct
  const start = content.indexOf("{")
  const end = content.lastIndexOf("}")
  return start >= 0 && end > start ? parse(content.slice(start, end + 1)) : null
}

/**
 * The model's reply -> the string the rest of the pipeline expects: cleaned text
 * with a sentinel token appended when there is one. Pure, so it is testable
 * without a server.
 */
/** Sentinel-shaped text, used to strip tokens we must not trust. */
const TOKEN_PATTERN = /\[\[(STOP|CONVERSATION_OFF|ALLOW|ALWAYS|DENY)\]\]/gi

/**
 * The model's reply -> the string the rest of the pipeline expects: cleaned text
 * with a sentinel token appended when there is one.
 *
 * `structured` says whether we asked for JSON. That matters when the reply does
 * NOT validate: constrained decoding silently fails open on llama.cpp and Ollama
 * (the schema is not always enforced, and a broken grammar still returns 200), so
 * a malformed reply in structured mode must not be able to trigger an action. In
 * prose mode a token inside the text is legitimate, and that path is unchanged.
 */
export function parseCleanResponse(
  content: string,
  options: CleanOptions,
  { structured = false }: { structured?: boolean } = {},
): string {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
  const parsed = asJsonObject(trimmed)
  if (parsed && typeof parsed.text === "string") {
    const action = typeof parsed.action === "string" ? (parsed.action as CleanAction) : "none"
    // Defensive: an action outside this mode's set is ignored, never acted on.
    const token = allowedActions(options).includes(action) ? actionToken(action) : ""
    const text = parsed.text.trim()
    if (!text) return token
    return token ? `${text} ${token}` : text
  }
  if (structured) {
    return trimmed.replace(TOKEN_PATTERN, "").replace(/\s+/g, " ").trim()
  }
  return trimmed
}

/** Structured output only where it can be relied on: an endpoint we control. */
function useStructured(llm: LlmConfig): boolean {
  if (llm.structured === false) return false
  if (llm.structured === true) return true
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(llm.url)
}

function schemaFor(options: CleanOptions): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      text: { type: "string" },
      action: { type: "string", enum: allowedActions(options) },
    },
    required: ["text", "action"],
    additionalProperties: false,
  }
}

// Which request shape this endpoint accepted, so a server that rejects structured
// output is probed once rather than on every utterance.
let structuredMode: "schema" | "object" | "off" | null = null

async function request(llm: LlmConfig, system: string, text: string, responseFormat: unknown): Promise<Response> {
  const gateway = llm.url.includes("opencode.ai")
  return fetch(`${llm.url}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "opencode-dictate/0.1",
      ...(llm.key ? { Authorization: `Bearer ${llm.key}` } : {}),
      ...(gateway ? { "x-opencode-session": randomUUID() } : {}),
    },
    body: JSON.stringify({
      model: llm.model,
      temperature: 0,
      max_tokens: 512,
      ...(gateway ? { reasoning_effort: "none" } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
    }),
  })
}

export async function clean(text: string, llm: LlmConfig, options: CleanOptions): Promise<string> {
  const parts = [BASE]
  if (options.control) parts.push(CONTROL)
  if (options.permission) parts.push(PERMISSION)
  const structured = useStructured(llm) && structuredMode !== "off"
  if (structured) parts.push(structuredRules(options))
  const system = parts.join("\n\n")

  const attempts: Array<{ mode: "schema" | "object" | "off"; format: unknown }> = []
  if (structured) {
    if (structuredMode === "schema") {
      attempts.push({ mode: "schema", format: strictSchema(options) })
    } else if (structuredMode === "object") {
      attempts.push({ mode: "object", format: { type: "json_object" } })
    } else {
      attempts.push({ mode: "schema", format: strictSchema(options) })
      attempts.push({ mode: "object", format: { type: "json_object" } })
    }
  }
  attempts.push({ mode: "off", format: undefined })

  let lastError: unknown = null
  for (const attempt of attempts) {
    try {
      const response = await request(llm, system, text, attempt.format)
      if (!response.ok) {
        lastError = new Error(`LLM HTTP ${response.status} ${response.statusText}`)
        continue
      }
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = (body.choices?.[0]?.message?.content ?? "").trim()
      if (structured && structuredMode === null && attempt.mode !== "off") structuredMode = attempt.mode
      if (!content) return text
      return parseCleanResponse(content, options, { structured: attempt.mode !== "off" })
    } catch (error) {
      lastError = error
    }
  }

  if (structured) structuredMode = "off"
  throw lastError instanceof Error ? lastError : new Error("LLM request failed")
}

function strictSchema(options: CleanOptions): unknown {
  return {
    type: "json_schema",
    json_schema: { name: "dictate_cleanup", strict: true, schema: schemaFor(options) },
  }
}
