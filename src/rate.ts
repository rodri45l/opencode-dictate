// Speaking-rate guard, learned per user.
//
// Whisper turns a short noise burst into a whole sentence ("I'm going to go to
// the next episode." from 560ms of room noise). The giveaway is physical: that
// sentence could not have been spoken in the time we recorded voice. A fixed
// ceiling would punish fast talkers and miss slow ones, so the limit is derived
// from how *this* user actually speaks, measured from utterances that already
// passed every other guard.
//
// The learned pace only ever raises the limit above the default floor; the guard
// itself is never switched off, so a polluted profile cannot disable it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { normalizeTranscript } from "./hallucination"

export interface RateProfile {
  /** Mean words per second for this speaker. */
  rate: number
  /** How many utterances the mean is based on. */
  samples: number
}

/** Used until the user's own pace is known: below every measured real speaker. */
export const DEFAULT_RATE_LIMIT = 8
/** The user is flagged only well above their own pace. */
const LIMIT_FACTOR = 2.5
/** The guard must never disappear, however fast someone talks. */
const MAX_RATE_LIMIT = 12
/** Utterances needed before the learned pace is trusted. */
const MIN_RATE_SAMPLES = 3
/** Below this many words a rate estimate is too noisy to judge or learn from. */
export const MIN_WORDS_FOR_RATE = 4

export const RATE_PATH = join(homedir(), ".local", "share", "opencode", "opencode-dictate", "speech-rate.json")

/** Words in a transcript, counted after normalisation. */
export function wordCount(text: string): number {
  return normalizeTranscript(text).split(" ").filter(Boolean).length
}

/** Words per second for an utterance, or 0 when it cannot be measured. */
export function rateOf(words: number, voicedMs: number): number {
  return voicedMs > 0 ? words / (voicedMs / 1000) : 0
}

/** The limit to apply right now, given what we know about this speaker. */
export function rateLimit(profile: RateProfile): number {
  if (profile.samples < MIN_RATE_SAMPLES || !(profile.rate > 0)) return DEFAULT_RATE_LIMIT
  return Math.min(MAX_RATE_LIMIT, Math.max(DEFAULT_RATE_LIMIT, profile.rate * LIMIT_FACTOR))
}

/** True when the transcript is longer than the recorded speech could contain. */
export function isImplausibleRate(text: string, voicedMs: number, limit = DEFAULT_RATE_LIMIT): boolean {
  const words = wordCount(text)
  if (words < MIN_WORDS_FOR_RATE) return false
  if (voicedMs <= 0) return true
  return words / (voicedMs / 1000) > limit
}

/**
 * Fold an accepted utterance into the speaker's pace. Only plausible clips are
 * learned from, so a hallucination can never teach the guard to accept more.
 */
export function learnRate(profile: RateProfile, text: string, voicedMs: number, limit: number): RateProfile {
  const words = wordCount(text)
  if (words < MIN_WORDS_FOR_RATE) return profile
  const rate = rateOf(words, voicedMs)
  if (rate <= 0 || rate > limit) return profile
  const samples = profile.samples + 1
  return { rate: (profile.rate * profile.samples + rate) / samples, samples }
}

export function loadRate(path = RATE_PATH): RateProfile {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<RateProfile>
    if (typeof raw?.rate === "number" && typeof raw?.samples === "number") {
      return { rate: raw.rate, samples: raw.samples }
    }
  } catch {
    // no profile yet
  }
  return { rate: 0, samples: 0 }
}

export function saveRate(profile: RateProfile, path = RATE_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`)
  } catch {
    // best effort — losing a sample only delays personalisation
  }
}
