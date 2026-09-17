// Best-effort auto-detection so users don't have to configure plumbing.

import { existsSync } from "node:fs"

/** WSL has no audio of its own; WSLg exposes PulseAudio as a Unix socket. */
export function ensureAudioEnvironment(): void {
  if (process.platform !== "linux") return
  if (process.env.PULSE_SERVER) return
  if (existsSync("/mnt/wslg/PulseServer")) process.env.PULSE_SERVER = "unix:/mnt/wslg/PulseServer"
}

/** Is a local STT server answering on the given base URL? */
export async function probeStt(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (response.ok) return true
    // Some servers don't expose /health; a 4xx still means something is listening.
    return response.status < 500
  } catch {
    return false
  }
}
