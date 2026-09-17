// Storage and comparison for voiceprints. Enrollment is online: we keep the
// mean of the normalised prints we have accepted, so the profile sharpens as the
// user talks instead of needing a dedicated recording step.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface VoiceProfile {
  version: 1
  count: number
  centroid: number[]
  updatedAt: string
}

export const DEFAULT_PROFILE_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "opencode-dictate",
  "voiceprint.json",
)

export function emptyProfile(): VoiceProfile {
  return { version: 1, count: 0, centroid: [], updatedAt: new Date().toISOString() }
}

export function loadProfile(path = DEFAULT_PROFILE_PATH): VoiceProfile {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as VoiceProfile
    if (raw?.version === 1 && Array.isArray(raw.centroid)) return raw
  } catch {
    // no profile yet
  }
  return emptyProfile()
}

export function saveProfile(profile: VoiceProfile, path = DEFAULT_PROFILE_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`)
  } catch {
    // best effort; a profile we cannot write just means learning restarts
  }
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

/** Similarity of a print to the enrolled profile; 1 when nothing is enrolled. */
export function similarity(print: ArrayLike<number>, profile: VoiceProfile): number {
  if (profile.count === 0 || profile.centroid.length === 0) return 1
  return cosine(print, profile.centroid)
}

/** Fold a new print into the running centroid (mean of normalised prints). */
export function enroll(profile: VoiceProfile, print: ArrayLike<number>): VoiceProfile {
  const count = profile.count + 1
  const centroid = new Array<number>(print.length)
  let norm = 0
  for (let i = 0; i < print.length; i++) {
    const mean = ((profile.centroid[i] ?? 0) * profile.count + print[i]) / count
    centroid[i] = mean
    norm += mean * mean
  }
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < centroid.length; i++) centroid[i] /= norm
  return { version: 1, count, centroid, updatedAt: new Date().toISOString() }
}
