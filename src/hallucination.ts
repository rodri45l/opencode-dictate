// Cloud STT endpoints (any OpenAI-compatible Whisper) hallucinate a small set of
// phrases when handed near-silence or room noise. Unlike a local faster-whisper
// server we cannot enable their server-side VAD, so we defend on our side: drop
// those outputs, but only when the captured audio was too weak to be that phrase
// — so a genuine "thank you" still gets through.

import { ARTIFACT_PERIODICITY, CLIPPING_RATIO, MIN_PERIODICITY } from "./speech"

export interface AudioStats {
  /** Milliseconds of voiced audio in the clip. */
  voicedMs: number
  /** Loudest peak amplitude (0..1) in the clip. */
  loudest: number
  /** Quasi-periodicity (0..1); speech is periodic, a mic knock is not. */
  periodicity: number
  /** Share of samples at full scale; a knock saturates, speech mostly doesn't. */
  clipped: number
}

/** Peak below this means nothing clearly speech-like was captured. */
export const WEAK_PEAK = 0.1
/** Below this much voiced audio a "transcript" is almost certainly invented. */
export const WEAK_VOICED_MS = 600

// Whisper was trained on subtitled video, so on silence/noise it emits closing
// credits rather than nothing. This list can never be complete — it is backed by
// the "mic never got loud" rule below, which catches phrases not listed here.
const SILENCE_HALLUCINATIONS = new Set([
  "",
  "thank you",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching everyone",
  "thank you for watching this video",
  "to be continued",
  "continued",
  "to be continued in the next episode",
  "see you next time",
  "see you in the next video",
  "please subscribe",
  "subscribe",
  "like and subscribe",
  "you",
  "bye",
  "bye bye",
  "okay",
  "ok",
  "oh",
  "i m sorry",
  "sorry",
  "amara org",
  "subtitles by",
  "subs by",
  "subtitle",
  "www",
])

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * True when a transcript has no words at all — "." or "…" alone. Whisper emits
 * these for noise, they are never dictation, and the speaking-rate guard cannot
 * see them because it only inspects transcripts that contain words.
 */
export function isWordless(text: string): boolean {
  return normalizeTranscript(text).length === 0
}

/**
 * True when a transcript looks like a silence artifact and the audio it came
 * from was too weak to plausibly be that phrase.
 */
/** Is this text a known Whisper silence artifact, regardless of the audio? */
export function isArtifact(text: string): boolean {
  return SILENCE_HALLUCINATIONS.has(normalizeTranscript(text))
}

export function isSilenceHallucination(text: string, stats: AudioStats): boolean {
  if (!isArtifact(text)) return false
  // A finger tap on the mic is loud, so loudness alone would keep it; it is not
  // periodic, which is what actually separates it from someone saying the phrase.
  return stats.loudest < WEAK_PEAK || stats.voicedMs < WEAK_VOICED_MS || stats.periodicity < ARTIFACT_PERIODICITY
}

/**
 * A transcript is invented if the microphone never clearly heard speech. This
 * catches hallucinations the phrase list misses, without needing to know what
 * the model decided to say.
 */
export function isWeakSpeech(stats: AudioStats, minPeak: number): boolean {
  // A saturated clip is a knock/tap, however loud and periodic it looks.
  return stats.loudest < minPeak || stats.periodicity < MIN_PERIODICITY || stats.clipped >= CLIPPING_RATIO
}
