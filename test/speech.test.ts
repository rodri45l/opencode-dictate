import { describe, expect, test } from "bun:test"
import { decodePcm, periodicity } from "../src/speech"

const RATE = 16_000

function sine(hz: number, seconds: number, amplitude = 0.3): Float32Array {
  const samples = new Float32Array(Math.floor(RATE * seconds))
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE)
  return samples
}

function noise(seconds: number, amplitude = 0.3, seed = 1): Float32Array {
  const samples = new Float32Array(Math.floor(RATE * seconds))
  let state = seed
  for (let i = 0; i < samples.length; i++) {
    // Deterministic LCG so the test is stable.
    state = (state * 1103515245 + 12345) & 0x7fffffff
    samples[i] = amplitude * ((state / 0x7fffffff) * 2 - 1)
  }
  return samples
}

describe("periodicity", () => {
  test("a voiced tone scores high", () => {
    expect(periodicity(sine(150, 1), RATE)).toBeGreaterThan(0.8)
    expect(periodicity(sine(220, 1), RATE)).toBeGreaterThan(0.8)
  })

  test("white noise scores low", () => {
    expect(periodicity(noise(1), RATE)).toBeLessThan(0.2)
  })

  test("a mic knock (transient) scores low", () => {
    const knock = new Float32Array(RATE)
    knock[8000] = 0.9
    expect(periodicity(knock, RATE)).toBeLessThan(0.15)
  })

  test("digital silence scores zero", () => {
    expect(periodicity(new Float32Array(RATE), RATE)).toBe(0)
  })

  test("too-short input scores zero", () => {
    expect(periodicity(new Float32Array(10), RATE)).toBe(0)
  })
})

describe("decodePcm", () => {
  test("decodes little-endian 16-bit samples after the header", () => {
    const header = Buffer.alloc(44)
    const body = Buffer.alloc(6)
    body.writeInt16LE(32767, 0)
    body.writeInt16LE(-32768, 2)
    body.writeInt16LE(0, 4)
    const samples = decodePcm(Buffer.concat([header, body]), 44)
    expect(samples.length).toBe(3)
    expect(samples[0]).toBeCloseTo(1, 3)
    expect(samples[1]).toBeCloseTo(-1, 3)
    expect(samples[2]).toBe(0)
  })
})
