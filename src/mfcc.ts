// A voiceprint from raw audio, with no model and no dependencies: the classic
// MFCC front-end (frame -> FFT -> mel filterbank -> log -> DCT), averaged over
// voiced frames and L2-normalised. Two clips of the same voice land close in
// this space; another speaker, a fan, or a mic knock land far away.
//
// It is deliberately simple. It is not as sharp as a neural speaker embedding,
// so it gates softly and learns a running centroid instead of a single template.

const FRAME_MS = 25
const HOP_MS = 10
const FFT_SIZE = 512
const FILTERS = 26
const CEPS = 13
const LOW_HZ = 50
const ENERGY_FLOOR = 0.01

/** Coefficients kept for the print (C1..C12; C0 is loudness/channel). */
export const PRINT_DIM = CEPS - 1

/** In-place iterative radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wRe = Math.cos(angle)
    const wIm = Math.sin(angle)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]
        const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm
        const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe
        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + half] = uRe - vRe
        im[i + k + half] = uIm - vIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1)
}

interface Filterbank {
  start: Int32Array
  weights: Float32Array[]
}

function buildFilterbank(rate: number, bins: number): Filterbank {
  const lowMel = hzToMel(LOW_HZ)
  const highMel = hzToMel(rate / 2)
  const points = new Float32Array(FILTERS + 2)
  for (let i = 0; i < points.length; i++) {
    const mel = lowMel + ((highMel - lowMel) * i) / (FILTERS + 1)
    points[i] = Math.floor(((melToHz(mel) / rate) * (bins * 2 - 2)) / 2)
  }
  const start = new Int32Array(FILTERS)
  const weights: Float32Array[] = []
  for (let f = 0; f < FILTERS; f++) {
    const left = points[f]
    const center = points[f + 1]
    const right = points[f + 2]
    const from = Math.max(0, Math.min(bins - 1, left))
    const to = Math.max(from, Math.min(bins - 1, right))
    const w = new Float32Array(to - from + 1)
    for (let b = from; b <= to; b++) {
      const rising = center > left ? (b - left) / (center - left) : 0
      const falling = right > center ? (right - b) / (right - center) : 0
      w[b - from] = Math.max(0, Math.min(rising, falling))
    }
    start[f] = from
    weights.push(w)
  }
  return { start, weights }
}

function dctInPlace(values: Float32Array): Float32Array {
  const out = new Float32Array(CEPS)
  for (let c = 0; c < CEPS; c++) {
    let sum = 0
    for (let k = 0; k < values.length; k++) sum += values[k] * Math.cos((Math.PI * c * (k + 0.5)) / values.length)
    out[c] = sum
  }
  return out
}

/**
 * Mean C1..C12 over voiced frames, L2-normalised, or null if the clip has too
 * little voiced audio to characterise a speaker.
 */
export function voiceprint(samples: Float32Array, rate: number): Float32Array | null {
  const frame = Math.floor((FRAME_MS / 1000) * rate)
  const hop = Math.floor((HOP_MS / 1000) * rate)
  if (samples.length < frame * 3) return null

  const bins = FFT_SIZE / 2
  const { start, weights } = buildFilterbank(rate, bins)
  const window = new Float32Array(frame)
  for (let i = 0; i < frame; i++) window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (frame - 1))

  const acc = new Float64Array(PRINT_DIM)
  let used = 0

  for (let offset = 0; offset + frame <= samples.length; offset += hop) {
    let energy = 0
    for (let i = 0; i < frame; i++) energy += samples[offset + i] * samples[offset + i]
    if (Math.sqrt(energy / frame) < ENERGY_FLOOR) continue

    const re = new Float32Array(FFT_SIZE)
    const im = new Float32Array(FFT_SIZE)
    for (let i = 0; i < frame; i++) re[i] = samples[offset + i] * window[i]
    fft(re, im)

    const mel = new Float32Array(FILTERS)
    for (let f = 0; f < FILTERS; f++) {
      let sum = 0
      const w = weights[f]
      for (let b = 0; b < w.length; b++) {
        const bin = start[f] + b
        sum += w[b] * (re[bin] * re[bin] + im[bin] * im[bin])
      }
      mel[f] = Math.log(sum + 1e-10)
    }

    const ceps = dctInPlace(mel)
    for (let c = 1; c < CEPS; c++) acc[c - 1] += ceps[c]
    used++
  }

  if (used < 3) return null

  const print = new Float32Array(PRINT_DIM)
  let norm = 0
  for (let i = 0; i < PRINT_DIM; i++) {
    print[i] = acc[i] / used
    norm += print[i] * print[i]
  }
  norm = Math.sqrt(norm)
  if (norm === 0) return null
  for (let i = 0; i < PRINT_DIM; i++) print[i] /= norm
  return print
}
