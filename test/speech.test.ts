import { describe, expect, test } from "bun:test"
import { clippingRatio, decodePcm, meterLevel, periodicity, wavFromPcm } from "../src/speech"

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

describe("clippingRatio", () => {
  test("clean speech-like audio does not clip", () => {
    expect(clippingRatio(sine(150, 1, 0.4))).toBe(0)
  })

  test("a saturated signal is fully clipped", () => {
    expect(clippingRatio(new Float32Array(1000).fill(1))).toBe(1)
  })

  test("reports the share of samples pinned at full scale", () => {
    const samples = new Float32Array(1000)
    for (let i = 0; i < 250; i++) samples[i] = -1
    expect(clippingRatio(samples)).toBeCloseTo(0.25, 6)
  })

  test("empty input is not clipped", () => {
    expect(clippingRatio(new Float32Array(0))).toBe(0)
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

describe("meterLevel", () => {
  test("stays still on room tone", () => {
    expect(meterLevel(0)).toBe(0)
    expect(meterLevel(0.004)).toBe(0)
  })

  test("lifts quiet speech into view", () => {
    // A trimmed mic leaves an ordinary sentence peaking near 0.1, which the old
    // linear map drew at 0.18 — visually a flat line.
    expect(meterLevel(0.1)).toBeGreaterThan(0.6)
  })

  test("clamps at full scale and rises with loudness", () => {
    expect(meterLevel(1)).toBe(1)
    expect(meterLevel(0.05)).toBeLessThan(meterLevel(0.2))
  })
})

describe("wavFromPcm", () => {
  test("wraps raw PCM in a valid 16-bit mono WAV header", () => {
    const pcm = Buffer.alloc(3200, 1)
    const wav = wavFromPcm(pcm, 16_000, 1)
    expect(wav.length).toBe(44 + pcm.length)
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF")
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE")
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length) // data size
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length) // riff size
  })

  test("decodes back to the original samples", () => {
    const pcm = Buffer.alloc(8)
    pcm.writeInt16LE(1234, 0)
    pcm.writeInt16LE(-1234, 2)
    const samples = decodePcm(wavFromPcm(pcm), 44)
    expect(samples[0]).toBeCloseTo(1234 / 32768, 6)
    expect(samples[1]).toBeCloseTo(-1234 / 32768, 6)
  })
})
