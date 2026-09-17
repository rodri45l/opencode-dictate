import { describe, expect, test } from "bun:test"
import { hadSpeech, initialVadState, vadStep, type VadConfig, type VadEvent, type VadState } from "../src/vad"

const CONFIG: VadConfig = {
  threshold: 0.02,
  silenceMs: 900,
  hangoverMs: 350,
  minSpeechMs: 300,
  startTimeoutMs: 4_000,
  maxMs: 60_000,
}

const TICK = 80
const LOUD = 0.5

function run(steps: number, peak: number, state: VadState, config = CONFIG) {
  const events: VadEvent[] = []
  for (let i = 0; i < steps; i++) {
    const step = vadStep(state, peak, TICK, config)
    state = step.state
    events.push(...step.events)
  }
  return { state, events }
}

describe("vadStep", () => {
  test("stays quiet when nobody speaks and times out", () => {
    const { state, events } = run(50, 0, initialVadState())
    expect(events).toEqual([])
    expect(state.spoken).toBe(false)
    expect(state.done).toBe(true)
    expect(hadSpeech(state, CONFIG)).toBe(false)
  })

  test("announces speech on the first voiced tick", () => {
    const { state, events } = run(1, LOUD, initialVadState())
    expect(events).toEqual(["speech"])
    expect(state.spoken).toBe(true)
  })

  test("sustained speech is enough to be transcribed", () => {
    const { state } = run(5, LOUD, initialVadState()) // 400ms voiced
    expect(hadSpeech(state, CONFIG)).toBe(true)
  })

  test("a single blip is not speech", () => {
    const blip = run(1, LOUD, initialVadState())
    const quiet = run(20, 0, blip.state)
    // The event fires for the UI, but it must not be sent to Whisper.
    expect(blip.events).toEqual(["speech"])
    expect(hadSpeech(quiet.state, CONFIG)).toBe(false)
    expect(quiet.state.done).toBe(true)
  })

  test("short gaps between words do not report silence", () => {
    let state = run(5, LOUD, initialVadState()).state
    const gap = run(4, 0, state) // 320ms < 350ms hangover
    expect(gap.events).toEqual([])
    expect(gap.state.silent).toBe(false)
  })

  test("a long enough pause reports silence, then resumes", () => {
    let state = run(5, LOUD, initialVadState()).state
    const pause = run(5, 0, state) // 400ms >= hangover
    expect(pause.events).toEqual(["silence"])
    expect(pause.state.done).toBe(false)

    const resumed = run(1, LOUD, pause.state)
    expect(resumed.events).toEqual(["speech"])
    expect(resumed.state.silent).toBe(false)
  })

  test("ends the utterance after silenceMs of quiet", () => {
    let state = run(5, LOUD, initialVadState()).state
    const { state: ended, events } = run(Math.ceil(CONFIG.silenceMs / TICK), 0, state)
    expect(events).toEqual(["silence"])
    expect(ended.done).toBe(true)
  })

  test("never exceeds maxMs", () => {
    const config = { ...CONFIG, maxMs: 240 }
    const { state } = run(4, LOUD, initialVadState(), config)
    expect(state.done).toBe(true)
  })

  test("tracks the loudest peak for the hallucination guard", () => {
    let state = initialVadState()
    state = vadStep(state, 0.2, TICK, CONFIG).state
    state = vadStep(state, 0.6, TICK, CONFIG).state
    state = vadStep(state, 0.3, TICK, CONFIG).state
    expect(state.loudest).toBe(0.6)
  })

  test("does not mutate the state passed in", () => {
    const before = initialVadState()
    const snapshot = { ...before }
    vadStep(before, LOUD, TICK, CONFIG)
    expect(before).toEqual(snapshot)
  })
})
