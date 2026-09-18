/** @jsxImportSource @opentui/solid */

// Local TUI plugin: dictate into the opencode prompt using the local GPU Whisper
// engine + LLM cleanup (~/.local/bin/dictate).
//
// Features:
//  - `/dictate` / <leader>d / f9 : record one utterance into the prompt.
//  - `/converse` / <leader>v / f10 : conversation mode — fully hands-free. Keeps
//    recording utterances and sends each straight to the agent via the SDK
//    (promptAsync), so opencode's own queue holds them while the agent is busy.
//    When the agent asks a question or requests permission, the same voice loop
//    answers it. For questions, the transcript is passed straight through as the
//    free-text answer and the agent reads it (no parsing into option labels).
//    Permissions are answered by voice: the LLM pass classifies the reply into
//    the [[ALLOW]] / [[ALWAYS]] / [[DENY]] sentinels (that API only accepts
//    once/always/reject). No keyboard or mouse required.
//  - Voice kill switch: the local LLM cleanup pass decides when a spoken utterance
//    is a control command and returns a sentinel (conversation mode only, via
//    DICTATE_LLM_CONTROL=1, set in llm_clean.py). "[[STOP]]" aborts the agent;
//    "[[CONVERSATION_OFF]]" leaves hands-free mode entirely, no keyboard needed.
//  - Indicator: centred above the prompt; its colour is the status (red =
//    speaking, amber = transcribing, dim = silent, white pulse = stopped). Two
//    styles: "scanner" (KITT sweep) and "waves" (amplitude bars that rise with
//    your voice — the engine emits PHASE:level:<0..1>). `/indicator` or f7
//    switches; DICTATE_INDICATOR=waves starts in waves.
//  - Voice-mode context: conversation-mode prompts append a short system
//    instruction (VOICE_SYSTEM) telling the agent to avoid the ask/question tool
//    and ask in plain text instead, so the voice loop never has to drive the
//    ask dialog. Injected via the prompt `system` field, which opencode appends.
//
// The session_prompt/home_prompt host slots render in "replace" mode, so this
// plugin re-renders the real prompt via `ui.Prompt` and adds a status line.
// Debug log: /tmp/opencode/dictate-plugin.log

import type { TuiPlugin, TuiPluginApi, TuiPromptRef, TuiSlotContext, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import type { JSX } from "@opentui/solid"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { spawn, type ChildProcess } from "node:child_process"
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { stopActiveRecorders } from "./audio"
import { loadConfig, LOCAL_STT_URL, type VoiceOptions } from "./config"
import { probeStt } from "./detect"
import { listen } from "./pipeline"
import { classifyControl, classifyPermission } from "./sentinels"


const DICTATE_KEYS = ["<leader>d", "f9"]
const CONVERSE_KEYS = ["<leader>v", "f10"]
const INDICATOR_KEYS = ["f7"]
const MUTE_KEYS = ["<leader>m", "f8"]
// In conversation mode each call waits a short while for speech, then returns so
// the loop can cycle (and so the single-threaded daemon is never held for long).
const CONV_ARGS = ["--start-timeout", "4", "--silence-ms", "1100", "--max-seconds", "60"]

// Debug logging is opt-in: VOICE_DEBUG=1 (or VOICE_DEBUG=log) writes to
// VOICE_DEBUG_LOG, otherwise the plugin is silent on disk.
let debugEnabled =
  process.env.VOICE_DEBUG === "1" || process.env.VOICE_DEBUG === "log" || process.env.VOICE_DEBUG === "true"
const DEBUG_LOG = process.env.VOICE_DEBUG_LOG ?? "/tmp/opencode/dictate-plugin.log"
function dbg(message: string): void {
  if (!debugEnabled) return
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // ignore
  }
}
dbg("module imported")

type Status = "idle" | "recording" | "speaking" | "transcribing"

const RED = "#FF5555"
const GREEN = "#9CAF8B"
const YELLOW = "#E5C07B"
const AMBER = "#E0A64B"
const IDLE = "#4E545A"
// Muted: grey already means "listening but silent", and orange/amber is
// transcribing, so mute takes violet — the one hue no other state uses.
const MUTED = "#8A6FD6"
// Scanner flash shown for a moment after a spoken stop.
const ALERT = "#FFFFFF"



// Extra system instruction appended only to conversation-mode prompts (opencode
// appends `system` to the agent prompt). Keeps the agent from using the ask tool,
// which the voice loop cannot drive cleanly.
const VOICE_SYSTEM = [
  "## Hands-free voice mode",
  "This user message came from speech, via opencode conversation mode. The user is speaking and listening.",
  "- Do NOT use the question/ask tool. If you need a decision, ask it in your normal reply as plain text — the user answers by voice.",
  "- Prefer acting over asking; only ask when genuinely blocked.",
  "- Keep replies short and speakable (one to three sentences) unless the user asks for detail.",
].join("\n")

const tui: TuiPlugin = async (api: TuiPluginApi, pluginOptions?: VoiceOptions) => {
  if (pluginOptions?.debug) debugEnabled = true
  dbg("tui() start")
  const voiceConfig = loadConfig(pluginOptions ?? {})
  // Only surface a given pipeline error once, so a broken recorder can't spam.
  let lastVoiceError = ""
  const [builtin, setBuiltin] = createSignal<boolean>(
    voiceConfig.backend === "builtin" || (voiceConfig.backend === "auto" && voiceConfig.stt !== null),
  )
  // Auto-detect a local STT server so no config is needed when one is running.
  if (voiceConfig.backend === "auto" && !voiceConfig.stt) {
    void (async () => {
      if (await probeStt(LOCAL_STT_URL)) {
        voiceConfig.stt = { url: LOCAL_STT_URL, key: "", model: "whisper-1" }
        setBuiltin(true)
        dbg(`auto-detected local STT at ${LOCAL_STT_URL}`)
      }
    })()
  }
  const [status, setStatus] = createSignal<Status>("idle")
  const [convOn, setConvOn] = createSignal(false)
  const [awaiting, setAwaiting] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [alertColor, setAlertColor] = createSignal("")
  // Live input amplitude (0..1) from the engine, and the indicator style.
  const [level, setLevel] = createSignal(0)
  const [indicator, setIndicator] = createSignal(
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.DICTATE_INDICATOR ===
      "waves"
      ? "waves"
      : "scanner",
  )
  // Mute: while on, nothing is captured at all (not captured-and-discarded), so
  // no audio can reach the transcriber. Persisted through the host key-value
  // store so it survives a restart.
  const [muted, setMuted] = createSignal<boolean>(api.kv.get<boolean>("dictate.muted", false))
  let promptRef: TuiPromptRef | undefined
  let sessionId: string | undefined
  let activeChild: ChildProcess | undefined
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  let alertTimer: ReturnType<typeof setTimeout> | undefined

  function insertText(text: string): void {
    const ref = promptRef
    dbg(`insert ref=${!!ref} len=${text.length}`)
    if (!ref) {
      api.ui.toast({ variant: "warning", message: "Dictation: prompt unavailable — click the input and retry" })
      return
    }
    const current = ref.current
    const existing = current.input ?? ""
    const sep = existing.length && !existing.endsWith(" ") ? " " : ""
    ref.set({ ...current, input: `${existing}${sep}${text}`, parts: current.parts ?? [] })
    ref.focus()
  }

  function spawnDictate(conv: boolean, mode?: "permission"): Promise<string> {
    // Preferred: builtin cross-platform pipeline (capture + VAD + transcribe +
    // cleanup), used when an STT endpoint is configured. Falls back to the
    // external `dictate` command otherwise.
    if (builtin() && voiceConfig.stt) {
      return (async () => {
        setStatus("recording")
        try {
          return await listen(
            voiceConfig,
            { control: conv, permission: mode === "permission", log: dbg },
            {
              onPhase: (name) => {
                if (name === "transcribing") setStatus("transcribing")
                else if (name === "speech") setStatus("speaking")
                else setStatus("recording")
              },
              onLevel: (value) => setLevel(value),
            },
          )
        } catch (error) {
          const message = (error as Error).message
          dbg(`pipeline error ${message}`)
          if (message !== lastVoiceError) {
            lastVoiceError = message
            api.ui.toast({ variant: "warning", message: `Voice: ${message}` })
          }
          return ""
        } finally {
          setStatus("idle")
        }
      })()
    }
    return new Promise((resolve, reject) => {
      const base = (globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {}
      const env = {
        ...base,
        PATH: `${join(homedir(), ".local", "bin")}:/usr/local/bin:/usr/bin:/bin:${base.PATH ?? ""}`,
        // Let the LLM cleanup pass emit control sentinels — conversation mode only.
        ...(conv ? { DICTATE_LLM_CONTROL: "1" } : {}),
        ...(mode ? { DICTATE_CONTROL_MODE: mode } : {}),
      }
      const args = conv ? CONV_ARGS : []
      dbg(`spawn conv=${conv}`)
      const child = spawn(voiceConfig.command, args, { env })
      activeChild = child
      let out = ""
      let err = ""
      child.stdout.on("data", (d) => (out += d.toString()))
      child.stderr.on("data", (d) => {
        const line = d.toString()
        err += line
        const marker = line.match(/PHASE:level:([0-9]*\.?[0-9]+)/)
        if (marker) setLevel(Number(marker[1]))
        // Match against the tail of the accumulated stream, not just this chunk:
        // a marker can be split across two stderr reads.
        const tail = err.slice(-40)
        if (tail.includes("PHASE:transcribing")) setStatus("transcribing")
        else if (tail.includes("PHASE:speech")) setStatus("speaking")
        else if (tail.includes("PHASE:silence")) setStatus("recording")
        else if (tail.includes("PHASE:recording")) setStatus("recording")
      })
      child.on("error", (e) => {
        if (activeChild === child) activeChild = undefined
        dbg(`spawn error ${e}`)
        reject(e)
      })
      child.on("close", (code) => {
        if (activeChild === child) activeChild = undefined
        dbg(`close code=${code} outLen=${out.trim().length}`)
        if (code === 0) resolve(out.trim())
        else if (conv) resolve("") // conversation mode: treat errors/no-speech as empty
        else reject(new Error(err.trim().split("\n").filter(Boolean).pop() || `exit ${code}`))
      })
    })
  }

  async function dictate(): Promise<void> {
    dbg(`dictate() status=${status()}`)
    if (muted()) {
      api.ui.toast({ variant: "info", message: "Dictation is muted" })
      return
    }
    if (status() !== "idle") return
    setStatus("recording")
    api.ui.toast({ variant: "info", message: "Dictation: recording — speak, then pause" })
    try {
      const text = await spawnDictate(false)
      if (text) insertText(text)
      else api.ui.toast({ variant: "warning", message: "Dictation: nothing heard" })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      dbg(`dictate error ${message}`)
      api.ui.toast({ variant: "error", message: `Dictation failed: ${message}` })
    } finally {
      setStatus("idle")
    }
  }

  // promptAsync returns as soon as the message is accepted (opencode then runs it,
  // or queues it if busy). The blocking `prompt` waits for the whole turn, which
  // tripped our send timeout and left already-sent prompts looking queued.
  // Send a message to the agent. promptAsync returns as soon as opencode accepts
  // it — opencode then runs it, or holds it in its own queue while the agent is
  // busy. We deliberately do not buffer anything ourselves.
  const promptClient = () =>
    api.client as unknown as { session: { promptAsync: (input: unknown) => Promise<unknown> } }

  // The session_prompt slot only reveals its id once a session view exists, so a
  // brand-new instance sitting on the home screen had no session at all — and
  // every dictated sentence was dropped in silence (the worst failure mode we
  // had). Resolve one on demand: the slot, the current route, or, at home,
  // create a session and navigate to it so dictation works from the first word.
  async function ensureSession(): Promise<string | undefined> {
    if (sessionId) return sessionId
    const route = api.route?.current
    if (route?.name === "session") {
      const fromRoute = (route.params as { sessionID?: string } | undefined)?.sessionID
      if (fromRoute) {
        sessionId = fromRoute
        dbg(`session from route: ${fromRoute}`)
        return fromRoute
      }
    }
    const client = api.client as unknown as {
      session?: {
        create?: (options: { body?: { title?: string }; query: { directory: string } }) => Promise<{
          data?: { id?: string }
        }>
      }
    }
    try {
      const created = await client.session?.create?.({
        body: { title: "Voice" },
        query: { directory: api.state.path.directory },
      })
      const id = created?.data?.id
      if (!id) return undefined
      sessionId = id
      dbg(`session created: ${id}`)
      try {
        api.route?.navigate("session", { sessionID: id })
      } catch (error) {
        dbg(`navigate failed: ${error}`)
      }
      return id
    } catch (error) {
      dbg(`session create failed: ${error}`)
      return undefined
    }
  }

  async function sendPrompt(text: string): Promise<void> {
    const id = await ensureSession()
    if (!id) {
      // Never swallow a transcript silently: say why nothing happened.
      dbg("send aborted: no session available")
      api.ui.toast({ variant: "warning", message: "Dictation: no session to send to" })
      return
    }
    dbg(`send -> ${text.slice(0, 60)}`)
    try {
      await promptClient().session.promptAsync({
        sessionID: id,
        parts: [{ type: "text", text }],
        system: VOICE_SYSTEM,
      })
    } catch (error) {
      dbg(`send failed: ${error}`)
    }
  }

  function pendingQuestion(): QuestionRequest | undefined {
    if (!sessionId) return undefined
    try {
      return api.state.session.question(sessionId)?.[0]
    } catch {
      return undefined
    }
  }

  function pendingPermission(): PermissionRequest | undefined {
    if (!sessionId) return undefined
    try {
      return api.state.session.permission(sessionId)?.[0]
    } catch {
      return undefined
    }
  }

  function refreshAwaiting(): void {
    const question = pendingQuestion()
    if (question) {
      const info = question.questions?.[0]
      setAwaiting(info?.header || info?.question || "question")
      return
    }
    const permission = pendingPermission()
    setAwaiting(permission ? `allow ${permission.permission}?` : "")
  }

  async function answerQuestion(request: QuestionRequest, text: string): Promise<void> {
    // Pass the spoken answer straight through as free text; the agent reads it.
    const questions = request.questions ?? []
    const answers = questions.length > 0 ? questions.map(() => [text]) : [[text]]
    dbg(`answer question ${request.id} heard="${text}" -> ${JSON.stringify(answers)}`)
    try {
      await (api.client as unknown as {
        question: { reply: (input: unknown) => Promise<unknown> }
      }).question.reply({ requestID: request.id, answers })
    } catch (error) {
      dbg(`question reply failed: ${error}`)
    }
  }

  async function answerPermission(request: PermissionRequest, text: string): Promise<void> {
    const reply = classifyPermission(text)
    if (!reply) {
      api.ui.toast({ variant: "warning", message: `Voice answer: say yes, always or no to ${request.permission}` })
      return
    }
    dbg(`answer permission ${request.id} heard="${text}" -> ${reply}`)
    try {
      await (api.client as unknown as {
        permission: { reply: (input: unknown) => Promise<unknown> }
      }).permission.reply({ requestID: request.id, reply })
    } catch (error) {
      dbg(`permission reply failed: ${error}`)
    }
  }

  function flash(message: string): void {
    setNotice(message)
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => setNotice(""), 3000)
  }

  // Transient scanner colour with no text — acknowledges a spoken stop.
  function flashAlert(color: string): void {
    setAlertColor(color)
    if (alertTimer) clearTimeout(alertTimer)
    alertTimer = setTimeout(() => setAlertColor(""), 2000)
  }

  // Spoken kill switch: stop the in-flight work and let the user speak a fresh
  // instruction. Bound to session.abort as a safety stop.
  async function interruptSession(spoken: string): Promise<void> {
    dbg(`voice interrupt: "${spoken}"`)
    flashAlert(ALERT)
    const id = await ensureSession()
    if (!id) return
    try {
      await (api.client as unknown as {
        session: { abort: (input: unknown) => Promise<unknown> }
      }).session.abort({ sessionID: id })
    } catch (error) {
      dbg(`abort failed: ${error}`)
    }
  }

  // Spoken exit from hands-free mode, so the user can go back to the keyboard
  // without touching it.
  function exitConversation(): void {
    dbg("voice: leave conversation mode")
    if (convOn()) toggleConverse()
    else setAwaiting("")
    flash("conversation mode off")
  }

  // One loop drives everything, so the single-threaded daemon is never contested:
  // an interrupt phrase wins; else if a question/permission is pending the
  // utterance is the answer; otherwise it is sent as a prompt.
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  // Generation token for the conversation loop. Starting a new loop bumps it,
  // which invalidates any previous loop still finishing an utterance — otherwise
  // two loops (and two recorders) end up fighting over the microphone.
  let loopToken = 0

  async function voiceLoop(token: number): Promise<void> {
    dbg(`voiceLoop start (${token})`)
    // Guard against spinning: if the recorder yields nothing (no device, error)
    // we must not respawn in a tight loop and freeze the TUI.
    let idleRounds = 0
    while (convOn() && token === loopToken) {
      // Muted: stay in conversation mode but do not even open the microphone.
      if (muted()) {
        setStatus("idle")
        await sleep(250)
        continue
      }
      let text = ""
      // Tell the LLM which control tokens to consider before it transcribes.
      const mode = pendingPermission() ? ("permission" as const) : undefined
      try {
        text = await spawnDictate(true, mode)
      } catch (error) {
        dbg(`voice error ${error}`)
      }
      if (!convOn() || token !== loopToken) break
      const question = pendingQuestion()
      const permission = pendingPermission()
      if (text) {
        dbg(`voice heard: "${text}"`)
        const control = classifyControl(text)
        if (control === "conversation-off") exitConversation()
        else if (control === "stop") await interruptSession(text)
        else if (question) await answerQuestion(question, text)
        else if (permission) await answerPermission(permission, text)
        else await sendPrompt(text)
      }
      refreshAwaiting()
      setStatus("idle")
      idleRounds = text ? 0 : idleRounds + 1
      await sleep(idleRounds > 2 ? 1500 : 250)
    }
    setStatus("idle")
    dbg("voiceLoop end")
  }

  function toggleConverse(): void {
    const on = !convOn()
    setConvOn(on)
    dbg(`conversation ${on}`)
    api.ui.toast({ variant: on ? "success" : "info", message: on ? "Conversation mode ON" : "Conversation mode OFF" })
    if (on) {
      refreshAwaiting()
      // Only ever one loop: bumping the token makes any earlier loop exit after
      // its in-flight capture instead of starting another one alongside this.
      loopToken += 1
      void voiceLoop(loopToken)
    } else {
      // Invalidate the running loop, then end its capture now — it checks the
      // token when the capture returns, so the recorder is not left holding the
      // microphone either way.
      loopToken += 1
      setAwaiting("")
      stopActiveRecorders()
      try {
        activeChild?.kill()
      } catch {
        // ignore
      }
    }
  }

  // Amplitude visualiser: a row of bars whose height tracks how loudly you are
  // speaking, shaped into a moving wave. The engine emits PHASE:level:<0..1>.
  function Waves(props: { color: string; level: number; alert?: boolean; frozen?: boolean }): JSX.Element {
    const WIDTH = 13
    const BLOCKS = ["▁", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
    const [tick, setTick] = createSignal(0)
    onMount(() => {
      const timer = setInterval(() => setTick((v) => v + 1), 80)
      onCleanup(() => clearInterval(timer))
    })
    let smoothed = 0
    const cells = () => {
      // Muted: a flat, motionless line in the mute colour.
      if (props.frozen) {
        const still: JSX.Element[] = []
        for (let i = 0; i < WIDTH; i++) still.push(<span style={{ fg: props.color }}>{BLOCKS[1]}</span>)
        return still
      }
      const target = props.alert
        ? 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(tick() * 1.0))
        : Math.max(0, Math.min(1, props.level))
      // Fast attack, slow decay — like a VU meter.
      smoothed = target > smoothed ? target : smoothed * 0.82
      const out: JSX.Element[] = []
      for (let i = 0; i < WIDTH; i++) {
        const envelope = 0.35 + 0.65 * Math.abs(Math.sin(i * 0.7 + tick() * 0.35))
        const index = Math.max(0, Math.min(8, Math.round(smoothed * envelope * 8)))
        out.push(<span style={{ fg: props.color }}>{BLOCKS[index]}</span>)
      }
      return out
    }
    return <text>{cells()}</text>
  }

  function switchIndicator(): void {
    const next = indicator() === "scanner" ? "waves" : "scanner"
    setIndicator(next)
    api.ui.toast({ message: `Indicator: ${next}` })
  }

  // There is no button to click in the TUI, so mute is a command + keybinding and
  // the indicator itself is the button face: grey and still while muted.
  function toggleMute(): void {
    const next = !muted()
    setMuted(next)
    api.kv.set("dictate.muted", next)
    // Mute now, not at the end of the utterance: stop the recorder mid-capture.
    if (next) stopActiveRecorders()
    setStatus("idle")
    setLevel(0)
    dbg(`muted ${next}`)
    api.ui.toast({ variant: next ? "info" : "success", message: next ? "Dictation muted" : "Dictation unmuted" })
  }

  // KITT / Knight Rider sweeping scanner. Its colour IS the status: red while
  // you are speaking, amber while transcribing, dim while listening in silence
  // or idle (the engine emits PHASE:speech / PHASE:silence for this).
  function Scanner(props: { color: string; alert?: boolean; frozen?: boolean }): JSX.Element {
    const WIDTH = 13
    const TAIL = 4
    const [tick, setTick] = createSignal(0)
    onMount(() => {
      const timer = setInterval(() => setTick((v) => v + 1), 80)
      onCleanup(() => clearInterval(timer))
    })
    const shade = (level: number): string => {
      const base = props.color
      const rgb = [1, 3, 5].map((i) => parseInt(base.slice(i, i + 2), 16))
      const k = 0.12 + 0.88 * level
      return `#${rgb.map((v) => Math.round(v * k).toString(16).padStart(2, "0")).join("")}`
    }
    const cells = () => {
      // Muted: the sweep parks dead centre, keeping its gradient and tail —
      // recognisably the scanner, just stopped.
      if (props.frozen) {
        const pos = (WIDTH - 1) / 2
        const still: JSX.Element[] = []
        for (let i = 0; i < WIDTH; i++) {
          const level = Math.max(0, 1 - Math.abs(i - pos) / TAIL)
          still.push(<span style={{ fg: shade(level) }}>{"█"}</span>)
        }
        return still
      }
      // Alert: the whole bar pulses together (a strobe), which reads very
      // differently from the normal left-right sweep.
      if (props.alert) {
        const level = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(tick() * 1.0))
        const out: JSX.Element[] = []
        for (let i = 0; i < WIDTH; i++) out.push(<span style={{ fg: shade(level) }}>{"█"}</span>)
        return out
      }
      const period = 2 * WIDTH - 2
      const t = tick() % period
      const pos = t < WIDTH ? t : period - t
      const out: JSX.Element[] = []
      for (let i = 0; i < WIDTH; i++) {
        const level = Math.max(0, 1 - Math.abs(i - pos) / TAIL)
        out.push(<span style={{ fg: shade(level) }}>{"█"}</span>)
      }
      return out
    }
    return <text>{cells()}</text>
  }

  function Indicator(): JSX.Element {
    // Text is only for things the scanner cannot express: a transient notice or
    // a pending question. Recording vs transcribing is the scanner colour.
    const label = () => {
      if (notice()) return notice()
      if (convOn() && awaiting()) return `? ${awaiting()} — speak`
      return ""
    }
    const color = () => (notice() ? RED : awaiting() ? YELLOW : GREEN)
    // speech = red, transcribing = amber, listening-but-silent / idle = dim.
    const scannerColor = () => {
      if (muted()) return MUTED
      if (alertColor()) return alertColor()
      return status() === "speaking" ? RED : status() === "transcribing" ? AMBER : IDLE
    }
    // width="100%" matters: without it the row collapses and nothing shows. The
    // composer gives the slot zero width and lets the prompt size itself, so an
    // unsized sibling row would be laid out at width 0.
    return (
      <box flexDirection="column" width="100%" marginBottom={1}>
        {/* Centred over the prompt rather than indented with it. */}
        <box flexDirection="row" width="100%" gap={2} justifyContent="center">
          <Show when={convOn()}>
            <Show
              when={indicator() === "waves"}
              fallback={<Scanner color={scannerColor()} alert={alertColor() !== ""} frozen={muted()} />}
            >
              <Waves color={scannerColor()} level={level()} alert={alertColor() !== ""} frozen={muted()} />
            </Show>
          </Show>
          <Show when={label() !== ""}>
            <text fg={color()}>{label()}</text>
          </Show>
        </box>
      </box>
    )
  }

  const bind = (ref: TuiPromptRef | undefined, hostRef?: (r: TuiPromptRef | undefined) => void) => {
    promptRef = ref
    hostRef?.(ref)
  }

  // 1) Commands + keybindings first, so dictation works even if the slot fails.
  try {
    const keymap = api.keymap as unknown as { registerLayer?: (layer: unknown) => unknown }
    if (typeof keymap?.registerLayer !== "function") throw new Error("no registerLayer")
    keymap.registerLayer({
      commands: [
        {
          name: "dictate.record",
          title: "Dictate",
          category: "Dictation",
          namespace: "palette",
          slashName: "dictate",
          run: () => void dictate(),
        },
        {
          name: "dictate.converse",
          title: "Dictate: toggle conversation mode",
          category: "Dictation",
          namespace: "palette",
          slashName: "converse",
          run: () => toggleConverse(),
        },
        {
          name: "dictate.indicator",
          title: "Dictate: switch indicator (scanner / waves)",
          category: "Dictation",
          namespace: "palette",
          slashName: "indicator",
          run: () => switchIndicator(),
        },
        {
          name: "dictate.mute",
          title: "Dictate: mute the microphone",
          category: "Dictation",
          namespace: "palette",
          slashName: "mute",
          run: () => toggleMute(),
        },
      ],
      bindings: [
        ...DICTATE_KEYS.map((key) => ({ key, cmd: "dictate.record", desc: "Dictate into the prompt" })),
        ...CONVERSE_KEYS.map((key) => ({ key, cmd: "dictate.converse", desc: "Toggle conversation mode" })),
        ...INDICATOR_KEYS.map((key) => ({ key, cmd: "dictate.indicator", desc: "Switch indicator style" })),
        ...MUTE_KEYS.map((key) => ({ key, cmd: "dictate.mute", desc: "Mute / unmute the microphone" })),
      ],
    })
    dbg("registerLayer ok")
  } catch (error) {
    dbg(`registerLayer failed: ${error}`)
    api.command?.register(() => [
      {
        title: "Dictate",
        value: "dictate.record",
        category: "Dictation",
        slash: { name: "dictate" },
        onSelect: () => void dictate(),
      },
      {
        title: "Dictate: toggle conversation mode",
        value: "dictate.converse",
        category: "Dictation",
        slash: { name: "converse" },
        onSelect: () => toggleConverse(),
      },
      {
        title: "Dictate: switch indicator (scanner / waves)",
        value: "dictate.indicator",
        category: "Dictation",
        slash: { name: "indicator" },
        onSelect: () => switchIndicator(),
      },
      {
        title: "Dictate: mute the microphone",
        value: "dictate.mute",
        category: "Dictation",
        slash: { name: "mute" },
        onSelect: () => toggleMute(),
      },
    ])
  }

  // 2) Slot for the prompt ref + status line.
  try {
    const slot: TuiSlotPlugin = {
      order: 50,
      slots: {
        session_prompt(_ctx: TuiSlotContext, input: {
          session_id: string
          visible?: boolean
          disabled?: boolean
          on_submit?: () => void
          ref?: (r: TuiPromptRef | undefined) => void
        }): JSX.Element {
          dbg("slot session_prompt called")
          sessionId = input.session_id
          refreshAwaiting()
          try {
            return (
              <box flexDirection="column" width="100%">
                <Indicator />
                <api.ui.Prompt
                  sessionID={input.session_id}
                  visible={input.visible}
                  disabled={input.disabled}
                  onSubmit={input.on_submit}
                  ref={(r) => bind(r, input.ref)}
                  right={<api.ui.Slot name="session_prompt_right" session_id={input.session_id} />}
                />
              </box>
            )
          } catch (error) {
            // Never take the prompt down with us; log so the failure is visible.
            dbg(`session_prompt render failed: ${error}`)
            return <api.ui.Prompt sessionID={input.session_id} ref={(r) => bind(r, input.ref)} />
          }
        },
        home_prompt(_ctx: TuiSlotContext, input: { ref?: (r: TuiPromptRef | undefined) => void }): JSX.Element {
          dbg("slot home_prompt called")
          try {
            return (
              <box flexDirection="column" width="100%">
                <Indicator />
                <api.ui.Prompt ref={(r) => bind(r, input.ref)} right={<api.ui.Slot name="home_prompt_right" />} />
              </box>
            )
          } catch (error) {
            dbg(`home_prompt render failed: ${error}`)
            return <api.ui.Prompt ref={(r) => bind(r, input.ref)} />
          }
        },
      },
    }
    api.slots.register(slot)
    dbg("slots registered")
  } catch (error) {
    dbg(`slots failed: ${error}`)
  }

  // 3) Track pending questions / permissions so the loop can answer them.
  try {
    const bus = api.event as unknown as { on: (type: string, handler: () => void) => () => void }
    const on = (type: string, handler: () => void) => {
      try {
        bus.on(type, handler)
      } catch (error) {
        dbg(`event ${type} unsupported: ${error}`)
      }
    }
    on("session.status", () => refreshAwaiting())
    for (const type of [
      "question.asked",
      "question.replied",
      "question.rejected",
      "permission.asked",
      "permission.replied",
    ]) {
      on(type, () => refreshAwaiting())
    }
    dbg("event hooks registered")
  } catch (error) {
    dbg(`event hooks failed: ${error}`)
  }

  onCleanup(() => {
    if (noticeTimer) clearTimeout(noticeTimer)
    if (alertTimer) clearTimeout(alertTimer)
    try {
      activeChild?.kill()
    } catch {
      // ignore
    }
  })
}

export default { id: "opencode-dictate", tui }
