// One utterance: capture -> transcribe -> (optional) clean. This is the seam the
// TUI plugin calls; everything heavy is swappable via config.

import { rmSync } from "node:fs"
import { type VoiceConfig } from "./config"
import { capture, type CaptureHandlers } from "./audio"
import { transcribe } from "./stt"
import { clean } from "./cleanup"
import { isSilenceHallucination } from "./hallucination"

export interface ListenOptions {
  control: boolean
  permission: boolean
}

export async function listen(
  config: VoiceConfig,
  options: ListenOptions,
  handlers: CaptureHandlers,
): Promise<string> {
  if (!config.stt) throw new Error("no speech-to-text configured — set VOICE_STT_URL")

  const captured = await capture(config, handlers)
  if (!captured.hadSpeech) return ""
  const { wavPath } = captured
  handlers.onPhase("transcribing")

  try {
    const raw = await transcribe(wavPath, config.stt)
    if (!raw) return ""
    // Cloud Whisper invents phrases like "Thank you." from noise; drop those
    // when the clip was too weak to actually be the phrase.
    if (isSilenceHallucination(raw, captured)) return ""
    if (!config.llm) return raw
    return await clean(raw, config.llm, { control: options.control, permission: options.permission })
  } finally {
    try {
      rmSync(wavPath, { force: true })
    } catch {
      // best effort cleanup
    }
  }
}
