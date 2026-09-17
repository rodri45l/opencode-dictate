import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { adaptGain, clampGain, DEFAULT_GAIN, loadGain, MAX_GAIN, MIN_GAIN, saveGain } from "../src/gain"

describe("clampGain", () => {
  test("keeps the gain inside the allowed range", () => {
    expect(clampGain(0.5)).toBe(0.5)
    expect(clampGain(0.01)).toBe(MIN_GAIN)
    expect(clampGain(2)).toBe(MAX_GAIN)
  })
})

describe("adaptGain", () => {
  test("backs off when the input clipped", () => {
    expect(adaptGain(0.8, 0.02, 0.9)).toBeCloseTo(0.56, 5)
  })

  test("backs off on a light knock too", () => {
    // The observed knock clipped 0.001 — under the old 0.005 bar, so the gain
    // never moved. It must react now.
    expect(adaptGain(0.8, 0.001, 0.9)).toBeCloseTo(0.56, 5)
  })

  test("creeps up when the input is too quiet", () => {
    expect(adaptGain(0.8, 0, 0.05)).toBeCloseTo(0.92, 5)
  })

  test("holds steady when the level is good", () => {
    expect(adaptGain(0.8, 0, 0.3)).toBe(0.8)
  })

  test("never leaves the allowed range", () => {
    expect(adaptGain(MIN_GAIN, 0.5, 0.9)).toBe(MIN_GAIN)
    expect(adaptGain(MAX_GAIN, 0, 0.01)).toBe(MAX_GAIN)
  })
})

describe("persistence", () => {
  test("defaults when nothing is saved", () => {
    expect(loadGain(join(tmpdir(), "dictate-gain-none.json"))).toBe(DEFAULT_GAIN)
  })

  test("round-trips through disk", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dictate-gain-")), "audio.json")
    saveGain(0.55, path)
    expect(loadGain(path)).toBeCloseTo(0.55, 5)
  })
})
