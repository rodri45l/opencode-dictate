import { describe, expect, test } from "bun:test"
import { PRINT_DIM, voiceprint } from "../src/mfcc"
import { cosine } from "../src/voiceprint"

const RATE = 16_000

/** A crude "vowel": a harmonic stack at a given pitch. */
function vowel(f0: number, seconds: number, amplitude = 0.3): Float32Array {
  const samples = new Float32Array(Math.floor(RATE * seconds))
  for (let i = 0; i < samples.length; i++) {
    let value = 0
    for (let h = 1; h <= 6; h++) value += (amplitude / h) * Math.sin((2 * Math.PI * f0 * h * i) / RATE)
    samples[i] = value / 2
  }
  return samples
}

describe("voiceprint", () => {
  test("is a unit vector of the expected size", () => {
    const print = voiceprint(vowel(150, 1), RATE)
    expect(print).not.toBeNull()
    expect(print!.length).toBe(PRINT_DIM)
    let norm = 0
    for (const value of print!) norm += value * value
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4)
  })

  test("is deterministic", () => {
    const a = voiceprint(vowel(150, 1), RATE)!
    const b = voiceprint(vowel(150, 1), RATE)!
    expect(cosine(a, b)).toBeCloseTo(1, 5)
  })

  test("clips with the same pitch are closer than clips with a different pitch", () => {
    const base = voiceprint(vowel(150, 1), RATE)!
    const near = voiceprint(vowel(155, 1), RATE)!
    const far = voiceprint(vowel(260, 1), RATE)!
    const nearScore = cosine(base, near)
    const farScore = cosine(base, far)
    expect(nearScore).toBeGreaterThan(farScore)
  })

  test("returns null for silence", () => {
    expect(voiceprint(new Float32Array(RATE), RATE)).toBeNull()
  })

  test("returns null when there is too little audio", () => {
    expect(voiceprint(vowel(150, 0.01), RATE)).toBeNull()
  })
})
