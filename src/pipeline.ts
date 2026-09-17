// One utterance: capture -> transcribe -> (optional) clean. This is the seam the
// TUI plugin calls; everything heavy is swappable via config.

import { rmSync } from "node:fs"
import { type VoiceConfig } from "./config"
import { capture, type CaptureHandlers } from "./audio"
import { transcribe } from "./stt"
import { clean } from "./cleanup"
import { isSilenceHallucination, isWeakSpeech } from "./hallucination"
import { enroll, loadProfile, saveProfile, similarity } from "./voiceprint"

export interface ListenOptions {
  control: boolean
  permission: boolean
  /** Optional sink for drop decisions, so they can be tuned from real audio. */
  log?: (message: string) => void
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
    const stats = `voiced=${captured.voicedMs}ms peak=${captured.loudest.toFixed(3)} pitch=${captured.periodicity.toFixed(2)}`
    // The mic never clearly heard speech, so whatever the model said is made up.
    // This catches hallucinations the phrase list cannot know about.
    if (isWeakSpeech(captured, config.vadThreshold * 1.5)) {
      options.log?.(`drop weak audio (${stats}) transcript="${raw}"`)
      return ""
    }
    // Loud enough to be speech, but a known silence artifact.
    if (isSilenceHallucination(raw, captured)) {
      options.log?.(`drop silence hallucination (${stats}) transcript="${raw}"`)
      return ""
    }
    // Speaker check: learn the voice first, then reject other speakers. This is a
    // soft MFCC profile, so it gates only after enough samples and logs its score.
    if (config.speaker.enabled && captured.print) {
      const profile = loadProfile()
      if (profile.count < config.speaker.minSamples) {
        const next = enroll(profile, captured.print)
        saveProfile(next)
        options.log?.(`speaker learning (${next.count}/${config.speaker.minSamples})`)
      } else {
        const score = similarity(captured.print, profile)
        if (score < config.speaker.threshold) {
          options.log?.(`drop other speaker (similarity=${score.toFixed(2)}) transcript="${raw}"`)
          return ""
        }
        options.log?.(`speaker ok (similarity=${score.toFixed(2)})`)
      }
    }
    options.log?.(`keep (${stats}) transcript="${raw}"`)
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
