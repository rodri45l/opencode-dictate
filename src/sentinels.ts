// Spoken control tokens emitted by the cleanup LLM. The model makes the semantic
// decision; the plugin only matches the token, so there are no phrase lists here.

export const STOP_SENTINEL = /\[\[\s*stop\s*\]\]/i
export const CONVERSATION_OFF_SENTINEL = /\[\[\s*conversation[_\s-]?off\s*\]\]/i
export const ALLOW_SENTINEL = /\[\[\s*allow\s*\]\]/i
export const ALWAYS_SENTINEL = /\[\[\s*always\s*\]\]/i
export const DENY_SENTINEL = /\[\[\s*deny\s*\]\]/i

/** Which spoken control command (if any) a cleaned transcript carries. */
export type ControlKind = "stop" | "conversation-off" | null

export function classifyControl(text: string): ControlKind {
  // Leaving the mode is checked first: "stop conversation mode" contains "stop".
  if (CONVERSATION_OFF_SENTINEL.test(text)) return "conversation-off"
  if (STOP_SENTINEL.test(text)) return "stop"
  return null
}

/** Which tool-permission answer (if any) a cleaned transcript carries. */
export type PermissionReply = "once" | "always" | "reject" | null

export function classifyPermission(text: string): PermissionReply {
  if (ALWAYS_SENTINEL.test(text)) return "always"
  if (DENY_SENTINEL.test(text)) return "reject"
  if (ALLOW_SENTINEL.test(text)) return "once"
  return null
}

// ---------------------------------------------------------------------------
// Structured output
//
// A local model with constrained decoding can return the decision as a typed
// value instead of hoping it emits a token inside prose. We keep the token
// representation internally, so the rest of the pipeline is unchanged.
// ---------------------------------------------------------------------------

/** Actions the cleanup model may choose in structured mode. */
export const CLEAN_ACTIONS = ["none", "stop", "conversation_off", "allow", "always", "deny"] as const
export type CleanAction = (typeof CLEAN_ACTIONS)[number]

/** The actions that make sense in the current mode — narrower than the full set. */
export function allowedActions(options: { control: boolean; permission: boolean }): CleanAction[] {
  const allowed: CleanAction[] = ["none"]
  if (options.control) allowed.push("stop", "conversation_off")
  if (options.permission) allowed.push("allow", "always", "deny")
  return allowed
}

/** Sentinel token for an action, so downstream matching stays as it was. */
export function actionToken(action: CleanAction): string {
  switch (action) {
    case "stop":
      return "[[STOP]]"
    case "conversation_off":
      return "[[CONVERSATION_OFF]]"
    case "allow":
      return "[[ALLOW]]"
    case "always":
      return "[[ALWAYS]]"
    case "deny":
      return "[[DENY]]"
    default:
      return ""
  }
}

/** Which action a cleaned string carries (the token is appended by cleanup). */
export function actionFromText(text: string): CleanAction {
  if (text.includes("[[STOP]]")) return "stop"
  if (text.includes("[[CONVERSATION_OFF]]")) return "conversation_off"
  if (text.includes("[[ALLOW]]")) return "allow"
  if (text.includes("[[ALWAYS]]")) return "always"
  if (text.includes("[[DENY]]")) return "deny"
  return "none"
}
