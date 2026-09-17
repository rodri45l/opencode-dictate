import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_RATE_LIMIT,
  isImplausibleRate,
  learnRate,
  loadRate,
  rateLimit,
  saveRate,
  wordCount,
} from "../src/rate"

describe("wordCount", () => {
  test("counts words after normalising punctuation", () => {
    expect(wordCount("I'm going to go to the next episode.")).toBe(8)
    expect(wordCount("  Okay,  perfect.  Thank you. ")).toBe(4)
  })
})

describe("isImplausibleRate", () => {
  test("drops the sentence invented from 560ms of noise", () => {
    // The phantom that reached the prompt: 9 words from 0.56s = 16 words/s.
    expect(isImplausibleRate("I'm going to go to the next episode.", 560)).toBe(true)
  })

  test("keeps real speech, including the fastest measured", () => {
    // 14 words in 2.16s = 6.5 words/second — fast, but genuinely said.
    expect(
      isImplausibleRate("You can search somewhere in this computer, because we recorded a few sentences before.", 2160),
    ).toBe(false)
    expect(isImplausibleRate("Okay, perfect. Thank you.", 1040)).toBe(false)
  })

  test("ignores transcripts too short to judge", () => {
    expect(isImplausibleRate("Okay.", 320)).toBe(false)
    expect(isImplausibleRate("Thank you.", 400)).toBe(false)
  })

  test("drops a sentence with no voiced audio at all", () => {
    expect(isImplausibleRate("Thanks for watching the whole video everyone", 0)).toBe(true)
  })

  test("judges each speaker by the limit they were given", () => {
    const twelve = "one two three four five six seven eight nine ten eleven twelve"
    expect(isImplausibleRate(twelve, 1000, 10)).toBe(true)
    expect(isImplausibleRate(twelve, 1000, 14)).toBe(false)
  })
})

describe("rateLimit", () => {
  test("defaults until the speaker's own pace is known", () => {
    expect(rateLimit({ rate: 0, samples: 0 })).toBe(DEFAULT_RATE_LIMIT)
    expect(rateLimit({ rate: 5, samples: 2 })).toBe(DEFAULT_RATE_LIMIT)
  })

  test("allows for a fast speaker's own pace", () => {
    // 5 words/second measured, so 12.5 is the ceiling — capped so the guard lives.
    expect(rateLimit({ rate: 5, samples: 10 })).toBe(12)
  })

  test("never falls below the default floor", () => {
    expect(rateLimit({ rate: 1, samples: 10 })).toBe(DEFAULT_RATE_LIMIT)
  })
})

describe("learnRate", () => {
  test("learns the speaker's pace from an accepted utterance", () => {
    const next = learnRate({ rate: 0, samples: 0 }, "Okay, perfect. Thank you.", 1040, DEFAULT_RATE_LIMIT)
    expect(next.samples).toBe(1)
    expect(next.rate).toBeCloseTo(3.85, 2)
  })

  test("averages with what it already knew", () => {
    const next = learnRate({ rate: 4, samples: 3 }, "Okay, perfect. Thank you.", 1040, DEFAULT_RATE_LIMIT)
    expect(next.samples).toBe(4)
    expect(next.rate).toBeCloseTo((4 * 3 + 3.846) / 4, 3)
  })

  test("never learns from an impossible clip", () => {
    const profile = { rate: 3, samples: 5 }
    expect(learnRate(profile, "I'm going to go to the next episode.", 560, DEFAULT_RATE_LIMIT)).toEqual(profile)
  })

  test("ignores transcripts too short to measure", () => {
    const profile = { rate: 3, samples: 5 }
    expect(learnRate(profile, "Okay.", 320, DEFAULT_RATE_LIMIT)).toEqual(profile)
  })
})

describe("persistence", () => {
  test("defaults when nothing is saved", () => {
    expect(loadRate(join(tmpdir(), "dictate-rate-none.json"))).toEqual({ rate: 0, samples: 0 })
  })

  test("round-trips through disk", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dictate-rate-")), "speech-rate.json")
    saveRate({ rate: 3.5, samples: 7 }, path)
    expect(loadRate(path)).toEqual({ rate: 3.5, samples: 7 })
  })
})
