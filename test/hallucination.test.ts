import { describe, expect, test } from "bun:test"
import {
  isArtifact,
  isSilenceHallucination,
  isWeakSpeech,
  normalizeTranscript,
  WEAK_PEAK,
  WEAK_VOICED_MS,
} from "../src/hallucination"

// Weak audio: quiet, short, and not periodic.
const WEAK = { voicedMs: 400, loudest: 0.05, periodicity: 0.05, clipped: 0 }
// Clear speech: loud, long, strongly periodic, not saturated.
const STRONG = { voicedMs: 900, loudest: 0.25, periodicity: 0.6, clipped: 0 }

describe("normalizeTranscript", () => {
  test("strips punctuation and collapses whitespace", () => {
    expect(normalizeTranscript("Thank you!!")).toBe("thank you")
    expect(normalizeTranscript("  THANKS,   for watching. ")).toBe("thanks for watching")
  })
})

describe("isArtifact", () => {
  test("recognises artifacts regardless of the audio", () => {
    expect(isArtifact("Thank you.")).toBe(true)
    expect(isArtifact("TO BE CONTINUED...")).toBe(true)
    expect(isArtifact("you")).toBe(true)
  })

  test("does not flag real prompts", () => {
    expect(isArtifact("stop the server")).toBe(false)
    expect(isArtifact("open the config file")).toBe(false)
  })
})

describe("isSilenceHallucination", () => {
  test("drops known artifacts from weak audio", () => {
    expect(isSilenceHallucination("Thank you.", WEAK)).toBe(true)
    expect(isSilenceHallucination("Thanks for watching!", WEAK)).toBe(true)
    expect(isSilenceHallucination("To be continued...", WEAK)).toBe(true)
    expect(isSilenceHallucination("you", WEAK)).toBe(true)
    expect(isSilenceHallucination("", WEAK)).toBe(true)
  })

  test("keeps a genuine 'thank you' spoken clearly", () => {
    expect(isSilenceHallucination("Thank you.", STRONG)).toBe(false)
  })

  test("drops an artifact from a loud but aperiodic mic knock", () => {
    // The finger-tap case: loud and long enough, but no pitch at all.
    const knock = { voicedMs: 900, loudest: 0.5, periodicity: 0.05, clipped: 0 }
    expect(isSilenceHallucination("Thank you.", knock)).toBe(true)
  })

  test("keeps phrases that are not silence artifacts", () => {
    expect(isSilenceHallucination("Open the config file", WEAK)).toBe(false)
    expect(isSilenceHallucination("stop the server", WEAK)).toBe(false)
  })

  test("treats a loud-but-brief clip as weak", () => {
    const brief = { voicedMs: WEAK_VOICED_MS - 1, loudest: 0.4, periodicity: 0.6, clipped: 0 }
    expect(isSilenceHallucination("thank you", brief)).toBe(true)
  })

  test("treats a quiet-but-long clip as weak", () => {
    const quiet = { voicedMs: 1500, loudest: WEAK_PEAK - 0.01, periodicity: 0.6, clipped: 0 }
    expect(isSilenceHallucination("thanks", quiet)).toBe(true)
  })

  test("a long, loud, periodic clip passes the guard", () => {
    const clear = { voicedMs: WEAK_VOICED_MS, loudest: WEAK_PEAK, periodicity: 0.6, clipped: 0 }
    expect(isSilenceHallucination("thanks", clear)).toBe(false)
  })
})

describe("isWeakSpeech", () => {
  test("drops any transcript when the mic never got loud", () => {
    expect(isWeakSpeech({ voicedMs: 900, loudest: 0.03, periodicity: 0.6, clipped: 0 }, 0.05)).toBe(true)
  })

  test("drops any transcript from aperiodic audio", () => {
    expect(isWeakSpeech({ voicedMs: 900, loudest: 0.5, periodicity: 0.05, clipped: 0 }, 0.05)).toBe(true)
  })

  test("drops a saturated mic knock even though it is loud and periodic", () => {
    // The observed pop: peak 1.0, pitch 0.60, yet the input was clipping.
    expect(isWeakSpeech({ voicedMs: 1600, loudest: 1, periodicity: 0.6, clipped: 0.4 }, 0.05)).toBe(true)
  })

  test("keeps clearly spoken audio", () => {
    expect(isWeakSpeech({ voicedMs: 900, loudest: 0.2, periodicity: 0.5, clipped: 0 }, 0.05)).toBe(false)
  })

  test("uses the threshold as an exclusive bound", () => {
    expect(isWeakSpeech({ voicedMs: 900, loudest: 0.05, periodicity: 0.6, clipped: 0 }, 0.05)).toBe(false)
    expect(isWeakSpeech({ voicedMs: 900, loudest: 0.0499, periodicity: 0.6, clipped: 0 }, 0.05)).toBe(true)
  })
})
