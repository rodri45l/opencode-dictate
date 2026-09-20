// One utterance: capture -> transcribe -> (optional) clean. This is the seam the
// TUI plugin calls; everything heavy is swappable via config.

import { type VoiceConfig } from "./config"
import { capture, type CaptureHandlers } from "./audio"
import { transcribe } from "./stt"
import { clean } from "./cleanup"
import { isArtifact, isSilenceHallucination, isWeakSpeech, isWordless } from "./hallucination"
import { actionFromText, withAction, type CleanAction } from "./sentinels"
import { isImplausibleRate, learnRate, loadRate, rateLimit, saveRate } from "./rate"
import { enroll, loadProfile, saveProfile, similarity } from "./voiceprint"

export interface ListenOptions {
  control: boolean
  permission: boolean
  /** Optional sink for drop decisions, so they can be tuned from real audio. */
  log?: (message: string) => void
}

/**
 * Ask the local decision service what it thinks, without ever letting it break
 * the pipeline: a missing or slow service is a missing opinion, not an error.
 */
async function askGate(
  config: VoiceConfig,
  text: string,
  mode: "control" | "permission",
): Promise<{ action: CleanAction; confidence: number } | null> {
  if (!config.gate?.url) return null
  try {
    const response = await fetch(`${config.gate.url}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mode }),
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { action?: string; confidence?: number }
    const action = (body.action === "prompt" ? "none" : body.action) as CleanAction | undefined
    return {
      action: action ?? "none",
      confidence: typeof body.confidence === "number" ? body.confidence : 0,
    }
  } catch {
    return null
  }
}


export async function listen(
  config: VoiceConfig,
  options: ListenOptions,
  handlers: CaptureHandlers,
): Promise<string> {
  if (!config.stt) throw new Error("no speech-to-text configured — set VOICE_STT_URL")

  const listenStarted = Date.now()
  const captured = await capture(config, handlers)
  // How long the microphone was open for this utterance: this includes the
  // end-of-speech silence window, which is the largest controllable cost we have.
  const listenMs = Date.now() - listenStarted
  // The clip lives only in memory, so a discard needs no cleanup.
  if (!captured.hadSpeech) return ""
  handlers.onPhase("transcribing")

  const sttStarted = Date.now()
  const raw = await transcribe(captured.wav, config.stt)
  const sttMs = Date.now() - sttStarted
  if (!raw) return ""
  const stats =
    `voiced=${captured.voicedMs}ms peak=${captured.loudest.toFixed(3)} ` +
    `pitch=${captured.periodicity.toFixed(2)} clip=${captured.clipped.toFixed(3)} ` +
    `gain=${captured.gain.toFixed(3)}`
  // Noise that produced no words at all — nothing to send, whoever said it.
  if (isWordless(raw)) {
    options.log?.(`drop wordless transcript (${stats}) transcript="${raw}"`)
    return ""
  }
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
  // A whole sentence cannot fit in the voice we recorded: the model invented
  // it. This catches sign-off phrases the artifact list has never seen, with the
  // limit set from how fast this user actually talks.
  const rateProfile = loadRate()
  const limit = rateLimit(rateProfile)
  if (isImplausibleRate(raw, captured.voicedMs, limit)) {
    options.log?.(`drop impossible speech rate (limit=${limit.toFixed(1)}/s, ${stats}) transcript="${raw}"`)
    return ""
  }
  // Speaker check: learn the voice first, then reject other speakers. This is a
  // soft MFCC profile, so it gates only after enough samples and logs its score.
  if (config.speaker.enabled && captured.print) {
    const profile = loadProfile()
    if (profile.count < config.speaker.minSamples) {
      // Never learn from a saturated clip. Clipping distorts the MFCCs enough to
      // poison the profile — it later scored the user's own voice negative, and
      // every utterance was rejected as another speaker.
      if (captured.clipped > 0) {
        options.log?.(`speaker skip (saturated clip, ${stats})`)
      } else {
        // Score before enrolling: shows how consistent the voice is, which is
        // what the threshold has to sit below.
        const agreement = profile.count === 0 ? 1 : similarity(captured.print, profile)
        const next = enroll(profile, captured.print)
        saveProfile(next)
        options.log?.(
          `speaker learning (${next.count}/${config.speaker.minSamples}, similarity=${agreement.toFixed(2)})`,
        )
      }
    } else {
      const score = similarity(captured.print, profile)
      // "Thank you." and friends are Whisper's default output for anything
      // voice-like, so demand far more evidence that it was really the user.
      const required = isArtifact(raw)
        ? Math.max(config.speaker.threshold, config.speaker.artifactThreshold)
        : config.speaker.threshold
      if (score < required) {
        options.log?.(`drop other speaker (similarity=${score.toFixed(2)} < ${required}) transcript="${raw}"`)
        return ""
      }
      // Keep learning. The profile follows the voice as the microphone moves or
      // delivery drifts, so a frozen average cannot start rejecting you.
      saveProfile(enroll(profile, captured.print))
      options.log?.(`speaker ok (similarity=${score.toFixed(2)})`)
    }
  }
  // Everything below this point is the user actually speaking, so it is safe to
  // learn their pace from it (a hallucination cannot get here).
  saveRate(learnRate(rateProfile, raw, captured.voicedMs, limit))
  options.log?.(`keep (${stats}) transcript="${raw}"`)

  // The local decision model runs alongside the LLM. In shadow mode (the
  // default) its verdict is only recorded, so the two can be compared on real
  // speech before anything depends on it.
  const gate = await askGate(config, raw, options.permission ? "permission" : "control")

  const cleanStarted = Date.now()
  const cleaned = config.llm
    ? await clean(raw, config.llm, { control: options.control, permission: options.permission })
    : raw
  options.log?.(`timing listen=${listenMs}ms stt=${sttMs}ms clean=${config.llm ? Date.now() - cleanStarted : 0}ms`)

  const llmAction = actionFromText(cleaned)
  const decisive =
    gate !== null && config.gate !== null && !config.gate.shadow && gate.confidence >= config.gate.threshold
  const action = decisive ? gate.action : llmAction
  // Record the decision and, when a gate is configured, both opinions: that is
  // the labelled pair a future trained model would be built from.
  options.log?.(
    `action=${action} llm=${llmAction}` +
      (gate ? ` gate=${gate.action}@${gate.confidence.toFixed(2)}` : "") +
      ` source=${decisive ? "gate" : "llm"} transcript="${raw}"`,
  )
  return decisive ? withAction(cleaned, gate.action) : cleaned
}
