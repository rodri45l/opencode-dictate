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
