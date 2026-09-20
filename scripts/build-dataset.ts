// Build a labelled dataset for the action classifier from real usage + curated cases.
//
// The debug log already holds the audio decisions; with `action=` now logged too,
// every utterance records what the model decided, so this grows by itself.
// Older lines predate that, but a transcript that was sent as a prompt *is* a
// prompt, so they are recoverable as positives for the `prompt` class — which is
// exactly the class a false positive would come from.
//
// Output is written outside the repo: it contains real speech, which should not
// be published even though the repository is public.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

type Mode = "control" | "permission" | "unknown"
type Action = "prompt" | "stop" | "conversation_off" | "allow" | "always" | "deny" | "nonspeech"

interface Row {
  text: string
  action: Action
  mode: Mode
  source: "log" | "curated"
  at?: string
}

const LOGS = process.argv.slice(2)
const DEFAULT_LOG = "/tmp/opencode/dictate-plugin.log"
const logs = LOGS.length > 0 ? LOGS : [DEFAULT_LOG]
const OUT = join(homedir(), ".local", "share", "opencode", "opencode-dictate", "dataset.jsonl")

/** Transcripts are logged last on the line and may contain quotes. */
function transcriptOf(line: string): string | null {
  const key = ' transcript="'
  const at = line.lastIndexOf(key)
  if (at < 0) return null
  return line.slice(at + key.length).replace(/"\s*$/, "")
}

function parseLog(path: string, rows: Row[]): number {
  if (!existsSync(path)) {
    console.log(`  skipped (missing): ${path}`)
    return 0
  }
  const lines = readFileSync(path, "utf-8").split("\n")
  let pending: { text: string; at: string } | null = null
  let added = 0

  for (const line of lines) {
    const at = line.slice(0, 24).trim()

    if (line.includes("keep (") || line.includes("drop ")) {
      const text = transcriptOf(line)
      if (!text) continue
      if (line.includes("drop ")) {
        // Not speech at all — useful as a negative, but not for action labels.
        rows.push({ text, action: "nonspeech", mode: "unknown", source: "log", at })
        added += 1
        pending = null
        continue
      }
      pending = { text, at }
      continue
    }

    // A decision line wins: it says what the model actually chose.
    if (pending && line.includes("action=")) {
      const action = (line.match(/action=([a-z_]+)/)?.[1] ?? "prompt") as Action
      const mode: Mode =
        action === "allow" || action === "always" || action === "deny" ? "permission" : "control"
      rows.push({ text: pending.text, action, mode, source: "log", at: pending.at })
      added += 1
      pending = null
      continue
    }

    // Otherwise a transcript that made it to the assistant was, by definition,
    // a prompt (no control action fired).
    if (pending && line.includes("send ->")) {
      rows.push({ text: pending.text, action: "prompt", mode: "control", source: "log", at: pending.at })
      added += 1
      pending = null
    }
  }
  return added
}

const rows: Row[] = []
for (const path of logs) {
  const n = parseLog(path, rows)
  console.log(`  ${path}: ${n} row(s)`)
}

const curated = join(import.meta.dir, "..", "data", "action-cases.jsonl")
if (existsSync(curated)) {
  let n = 0
  for (const line of readFileSync(curated, "utf-8").split("\n")) {
    if (!line.trim()) continue
    const c = JSON.parse(line) as { text: string; mode: Mode; action: Action }
    rows.push({ text: c.text, action: c.action, mode: c.mode, source: "curated" })
    n += 1
  }
  console.log(`  curated cases: ${n} row(s)`)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")

const tally = (pick: (r: Row) => string) =>
  Object.entries(
    rows.reduce<Record<string, number>>((acc, r) => {
      const k = pick(r)
      acc[k] = (acc[k] ?? 0) + 1
      return acc
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join("  ")

console.log(`\n  wrote ${rows.length} rows -> ${OUT}`)
console.log(`  by action: ${tally((r) => r.action)}`)
console.log(`  by source: ${tally((r) => r.source)}`)
console.log(`  by mode:   ${tally((r) => r.mode)}`)
