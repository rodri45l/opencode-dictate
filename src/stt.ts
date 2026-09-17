// Speech-to-text against any OpenAI-compatible /audio/transcriptions endpoint
// (a local whisper.cpp/faster-whisper server, or a cloud provider).

import { readFileSync } from "node:fs"
import type { SttConfig } from "./config"

function endpoint(url: string): string {
  return url.includes("/audio/transcriptions") ? url : `${url}/audio/transcriptions`
}

export async function transcribe(wavPath: string, stt: SttConfig): Promise<string> {
  const audio = readFileSync(wavPath)
  const form = new FormData()
  form.append("model", stt.model)
  form.append("file", new Blob([audio], { type: "audio/wav" }), "utterance.wav")

  const response = await fetch(endpoint(stt.url), {
    method: "POST",
    headers: stt.key ? { Authorization: `Bearer ${stt.key}` } : {},
    body: form,
  })
  if (!response.ok) throw new Error(`STT HTTP ${response.status} ${response.statusText}`)
  const body = (await response.json()) as { text?: string }
  return (body.text ?? "").trim()
}
