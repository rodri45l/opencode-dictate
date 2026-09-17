// Cloud STT endpoints (any OpenAI-compatible Whisper) hallucinate a small set of
// phrases when handed near-silence or room noise. Unlike a local faster-whisper
// server we cannot enable their server-side VAD, so we defend on our side: drop
// those outputs, but only when the captured audio was too weak to be that phrase
// — so a genuine "thank you" still gets through.

export interface AudioStats {
  /** Milliseconds of voiced audio in the clip. */
  voicedMs: number
  /** Loudest peak amplitude (0..1) in the clip. */
  loudest: number
}

/** Peak below this means nothing clearly speech-like was captured. */
export const WEAK_PEAK = 0.1
/** Below this much voiced audio a "transcript" is almost certainly invented. */
export const WEAK_VOICED_MS = 600

const SILENCE_HALLUCINATIONS = new Set([
  "",
  "thank you",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching everyone",
  "please subscribe",
  "subscribe",
  "you",
  "bye",
  "okay",
  "ok",
  "oh",
  "i m sorry",
  "sorry",
  "amara org",
  "subtitles by",
  "subs by",
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
 * True when a transcript looks like a silence artifact and the audio it came
 * from was too weak to plausibly be that phrase.
 */
export function isSilenceHallucination(text: string, stats: AudioStats): boolean {
  const normalized = normalizeTranscript(text)
  if (!SILENCE_HALLUCINATIONS.has(normalized)) return false
  return stats.loudest < WEAK_PEAK || stats.voicedMs < WEAK_VOICED_MS
}
