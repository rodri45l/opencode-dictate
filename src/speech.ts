// Cheap speech-presence test: voiced speech is quasi-periodic (pitch 80-400 Hz)
// while a finger tap on the mic, a door, or a fan is broadband and aperiodic.
// Loudness alone cannot separate them — a mic bump is *loud*.
//
// We estimate the normalised autocorrelation peak in the pitch range, averaged
// over frames with enough energy. Speech lands well above the thresholds below;
// transients and noise land near zero.

/** Frames quieter than this RMS are ignored (silence). */
const ENERGY_FLOOR = 0.01
const FRAME_MS = 32

/** Below this, a clip has essentially no voiced content and is not speech. */
export const MIN_PERIODICITY = 0.15
/** Below this, a known silence artifact is considered invented. */
export const ARTIFACT_PERIODICITY = 0.3
/**
 * Fraction of samples pinned at full scale that means the mic was knocked.
 * Measured on real audio: speech transients clip at most ~0.0004, while mic
 * knocks ranged 0.001 (a light tap) to 0.012 (a hard one). 0.001 catches the
 * light tap and still leaves 2.5x headroom over the loudest real syllable.
 */
export const CLIPPING_RATIO = 0.001
const FULL_SCALE = 0.98

/** Peaks this small are room tone, not voice — the meter should stay still. */
const METER_FLOOR = 0.004
/**
 * The wave meter reads captured peaks, which are small in practice: once the
 * input gain has trimmed a hot microphone, an ordinary sentence peaks near 0.1
 * and a linear mapping leaves the bars flat. A square root gives loudness the
 * perceptual curve the eye expects, so quiet speech visibly moves the wave.
 */
const METER_BOOST = 2.2

/** Map a raw peak (0..1) to a 0..1 value for the wave indicator. */
export function meterLevel(peak: number): number {
  if (!(peak > METER_FLOOR)) return 0
  const normalized = (peak - METER_FLOOR) / (1 - METER_FLOOR)
  return Math.min(1, Math.sqrt(normalized) * METER_BOOST)
}

function bestCorrelation(samples: Float32Array, start: number, frame: number, minLag: number, maxLag: number): number {
  let energy0 = 0
  for (let i = start; i < start + frame; i++) energy0 += samples[i] * samples[i]
  if (energy0 <= 0) return 0

  let best = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0
    let energy1 = 0
    for (let i = start; i < start + frame; i++) {
      dot += samples[i] * samples[i + lag]
      energy1 += samples[i + lag] * samples[i + lag]
    }
    const norm = Math.sqrt(energy0 * energy1)
    if (norm > 0) {
      const r = dot / norm
      if (r > best) best = r
    }
  }
  return best
}

/** Mean normalised autocorrelation peak over voiced frames, 0..1. */
export function periodicity(samples: Float32Array, rate: number): number {
  const frame = Math.max(1, Math.floor((FRAME_MS / 1000) * rate))
  const minLag = Math.max(1, Math.floor(rate / 400))
  const maxLag = Math.floor(rate / 80)
  if (samples.length < frame + maxLag) return 0

  let total = 0
  let counted = 0
  for (let start = 0; start + frame + maxLag <= samples.length; start += frame) {
    let energy = 0
    for (let i = start; i < start + frame; i++) energy += samples[i] * samples[i]
    if (Math.sqrt(energy / frame) < ENERGY_FLOOR) continue
    counted++
    total += bestCorrelation(samples, start, frame, minLag, maxLag)
  }
  return counted === 0 ? 0 : total / counted
}

/**
 * Share of samples sitting at full scale. A knock or a hard tap saturates the
 * input — speech, even loud speech, rarely does for long. This is what lets us
 * tell a mic bump from someone actually talking into it.
 */
export function clippingRatio(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let clipped = 0
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) >= FULL_SCALE) clipped++
  return clipped / samples.length
}

/** Decode 16-bit little-endian PCM (mono) into -1..1 floats. */
export function decodePcm(buffer: Buffer, headerBytes: number): Float32Array {
  const count = Math.max(0, Math.floor((buffer.length - headerBytes) / 2))
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i++) samples[i] = buffer.readInt16LE(headerBytes + i * 2) / 32768
  return samples
}

/** Wrap raw 16-bit PCM in a minimal WAV container, for upload to the STT API. */
export function wavFromPcm(pcm: Buffer, rate = 16_000, channels = 1): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = rate * channels * 2
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(channels * 2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
