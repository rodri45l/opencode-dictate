import { describe, expect, test } from "bun:test"
import { isSilenceHallucination, normalizeTranscript, WEAK_PEAK, WEAK_VOICED_MS } from "../src/hallucination"

const WEAK = { voicedMs: 400, loudest: 0.05 }
const STRONG = { voicedMs: 900, loudest: 0.25 }

describe("normalizeTranscript", () => {
  test("strips punctuation and collapses whitespace", () => {
    expect(normalizeTranscript("Thank you!!")).toBe("thank you")
    expect(normalizeTranscript("  THANKS,   for watching. ")).toBe("thanks for watching")
  })
})

describe("isSilenceHallucination", () => {
  test("drops known artifacts from weak audio", () => {
    expect(isSilenceHallucination("Thank you.", WEAK)).toBe(true)
    expect(isSilenceHallucination("Thanks for watching!", WEAK)).toBe(true)
    expect(isSilenceHallucination("you", WEAK)).toBe(true)
    expect(isSilenceHallucination("", WEAK)).toBe(true)
  })

  test("keeps a genuine 'thank you' spoken clearly", () => {
    expect(isSilenceHallucination("Thank you.", STRONG)).toBe(false)
  })

  test("keeps phrases that are not silence artifacts", () => {
    expect(isSilenceHallucination("Open the config file", WEAK)).toBe(false)
    expect(isSilenceHallucination("stop the server", WEAK)).toBe(false)
  })

  test("treats a loud-but-brief clip as weak", () => {
    const brief = { voicedMs: WEAK_VOICED_MS - 1, loudest: 0.4 }
    expect(isSilenceHallucination("thank you", brief)).toBe(true)
  })

  test("treats a quiet-but-long clip as weak", () => {
    const quiet = { voicedMs: 1500, loudest: WEAK_PEAK - 0.01 }
    expect(isSilenceHallucination("thanks", quiet)).toBe(true)
  })

  test("a long, loud clip passes the guard", () => {
    expect(isSilenceHallucination("thanks", { voicedMs: WEAK_VOICED_MS, loudest: WEAK_PEAK })).toBe(false)
  })
})
