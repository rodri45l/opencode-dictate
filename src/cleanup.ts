// Optional LLM post-processing: clean the transcript for a coding context and
// classify spoken control commands into sentinels the plugin matches exactly.
// The model makes the decision; we only match tokens.

import { randomUUID } from "node:crypto"
import type { LlmConfig } from "./config"

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

export async function clean(text: string, llm: LlmConfig, options: CleanOptions): Promise<string> {
  const parts = [BASE]
  if (options.control) parts.push(CONTROL)
  if (options.permission) parts.push(PERMISSION)

  // The opencode.ai gateway routes per session and supports reasoning_effort;
  // keep the cleanup cheap by leaving thinking off.
  const gateway = llm.url.includes("opencode.ai")
  const response = await fetch(`${llm.url}/chat/completions`, {
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
      max_tokens: 1024,
      ...(gateway ? { reasoning_effort: "none" } : {}),
      messages: [
        { role: "system", content: parts.join("\n\n") },
        { role: "user", content: text },
      ],
    }),
  })
  if (!response.ok) throw new Error(`LLM HTTP ${response.status} ${response.statusText}`)
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return (body.choices?.[0]?.message?.content ?? "").trim() || text
}
