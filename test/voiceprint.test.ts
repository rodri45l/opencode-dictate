import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cosine, emptyProfile, enroll, loadProfile, saveProfile, similarity } from "../src/voiceprint"

describe("cosine", () => {
  test("scores identical, orthogonal and opposite vectors", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 6)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6)
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 6)
  })

  test("handles mismatched or empty input", () => {
    expect(cosine([1, 2], [1])).toBe(0)
    expect(cosine([], [])).toBe(0)
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })
})

describe("profile", () => {
  test("an empty profile accepts everything", () => {
    expect(similarity([0.5, 0.5], emptyProfile())).toBe(1)
  })

  test("enrolling builds a unit centroid", () => {
    const first = enroll(emptyProfile(), [1, 0])
    expect(first.count).toBe(1)
    expect(first.centroid).toEqual([1, 0])

    const second = enroll(first, [0, 1])
    expect(second.count).toBe(2)
    const norm = Math.hypot(...second.centroid)
    expect(norm).toBeCloseTo(1, 6)
  })

  test("repeated samples of one voice stay similar to the profile", () => {
    let profile = emptyProfile()
    for (let i = 0; i < 6; i++) profile = enroll(profile, [0.9, 0.1, 0.2])
    expect(similarity([0.9, 0.1, 0.2], profile)).toBeGreaterThan(0.99)
    expect(similarity([0.1, 0.2, 0.9], profile)).toBeLessThan(0.9)
  })

  test("round-trips through disk", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dictate-vp-")), "voiceprint.json")
    const profile = enroll(enroll(emptyProfile(), [0.5, 0.5]), [0.6, 0.4])
    saveProfile(profile, path)
    const loaded = loadProfile(path)
    expect(loaded.count).toBe(2)
    expect(loaded.centroid).toEqual(profile.centroid)
  })

  test("a missing profile is empty rather than an error", () => {
    expect(loadProfile(join(tmpdir(), "dictate-does-not-exist.json")).count).toBe(0)
  })
})
