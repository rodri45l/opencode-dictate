// Pure utterance-endpointing state machine. Kept free of process/IO concerns so
// it can be unit-tested without spawning a recorder.

export interface VadConfig {
  /** Peak amplitude (0..1) above which a tick counts as voice. */
  threshold: number
  /** Quiet time that ends the utterance. */
  silenceMs: number
  /** Quiet time before "silence" is reported; shorter gaps are just pauses. */
  hangoverMs: number
  /** Voiced time required before a clip counts as speech at all. */
  minSpeechMs: number
  /** Give up if nothing is said within this long. */
  startTimeoutMs: number
  /** Hard cap on a single utterance. */
  maxMs: number
}

export interface VadState {
  spoken: boolean
  voicedMs: number
  /** Loudest peak seen, used to tell real speech from a noisy room. */
  loudest: number
  quietFor: number
  elapsed: number
  /** Set once a pause has been reported, so speech can be re-announced. */
  silent: boolean
  done: boolean
}

export type VadEvent = "speech" | "silence"

/** Short gaps between words are not "finished speaking". */
export const SILENCE_HANGOVER_MS = 350

export function initialVadState(): VadState {
  return { spoken: false, voicedMs: 0, loudest: 0, quietFor: 0, elapsed: 0, silent: false, done: false }
}

export function vadStep(
  state: VadState,
  peak: number,
  tickMs: number,
  config: VadConfig,
): { state: VadState; events: VadEvent[] } {
  const next: VadState = { ...state, elapsed: state.elapsed + tickMs }
  const events: VadEvent[] = []

  if (peak > config.threshold) {
    next.voicedMs += tickMs
    if (peak > next.loudest) next.loudest = peak
    next.quietFor = 0
    // Announce on the first voice and again when speech resumes after a pause,
    // so the status colour covers the whole turn rather than its first tick.
    if (!next.spoken || next.silent) {
      next.spoken = true
      next.silent = false
      events.push("speech")
    }
  } else if (next.spoken) {
    next.quietFor += tickMs
    if (!next.silent && next.quietFor >= config.hangoverMs) {
      next.silent = true
      events.push("silence")
    }
    if (next.quietFor >= config.silenceMs) next.done = true
  } else if (next.elapsed >= config.startTimeoutMs) {
    next.done = true
  }

  if (next.elapsed >= config.maxMs) next.done = true
  return { state: next, events }
}

/** Enough voiced audio to be worth transcribing (noise must not reach Whisper). */
export function hadSpeech(state: VadState, config: VadConfig): boolean {
  return state.spoken && state.voicedMs >= config.minSpeechMs
}
