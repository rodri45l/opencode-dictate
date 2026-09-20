import { describe, expect, test } from "bun:test"
import { parseCleanResponse } from "../src/cleanup"
import { actionToken, allowedActions } from "../src/sentinels"

const both = { control: true, permission: true }
const controlOnly = { control: true, permission: false }
const permissionOnly = { control: false, permission: true }
const neither = { control: false, permission: false }

describe("parseCleanResponse", () => {
  test("text plus a none action stays plain text", () => {
    expect(parseCleanResponse('{"text": "Stop the server.", "action": "none"}', both)).toBe("Stop the server.")
  })

  test("a command action becomes its sentinel token", () => {
    expect(parseCleanResponse('{"text":"stop it","action":"stop"}', controlOnly)).toBe("stop it [[STOP]]")
    expect(parseCleanResponse('{"text":"stop conversation mode","action":"conversation_off"}', controlOnly)).toBe(
      "stop conversation mode [[CONVERSATION_OFF]]",
    )
    expect(parseCleanResponse('{"text":"always","action":"always"}', permissionOnly)).toBe("always [[ALWAYS]]")
    expect(parseCleanResponse('{"text":"no","action":"deny"}', permissionOnly)).toBe("no [[DENY]]")
  })

  test("the action set is scoped to the mode", () => {
    // A stop cannot arrive while answering a permission prompt, nor a permission
    // answer during free conversation — those are ignored rather than acted on.
    expect(parseCleanResponse('{"text":"stop","action":"stop"}', permissionOnly)).toBe("stop")
    expect(parseCleanResponse('{"text":"yes","action":"allow"}', controlOnly)).toBe("yes")
  })

  test("survives fenced or wrapped JSON", () => {
    expect(parseCleanResponse('```json\n{"text":"hello","action":"none"}\n```', both)).toBe("hello")
    expect(parseCleanResponse('Sure: {"text":"hello","action":"none"} done', both)).toBe("hello")
  })

  test("falls back to the prose reply when there is no JSON", () => {
    expect(parseCleanResponse("Fix the bug [[STOP]]", both)).toBe("Fix the bug [[STOP]]")
    expect(parseCleanResponse("Fix the bug", both)).toBe("Fix the bug")
  })

  test("ignores an action outside the vocabulary", () => {
    expect(parseCleanResponse('{"text":"hmm","action":"launch"}', both)).toBe("hmm")
  })

  test("an empty text still yields the token", () => {
    expect(parseCleanResponse('{"text":"","action":"stop"}', controlOnly)).toBe("[[STOP]]")
  })
})

describe("allowedActions and actionToken", () => {
  test("nothing but none when no mode is active", () => {
    expect(allowedActions(neither)).toEqual(["none"])
  })

  test("control mode allows the stop family", () => {
    expect(allowedActions(controlOnly)).toEqual(["none", "stop", "conversation_off"])
  })

  test("permission mode allows the reply family", () => {
    expect(allowedActions(permissionOnly)).toEqual(["none", "allow", "always", "deny"])
  })

  test("every action maps to the token the pipeline already matches", () => {
    expect(actionToken("stop")).toBe("[[STOP]]")
    expect(actionToken("conversation_off")).toBe("[[CONVERSATION_OFF]]")
    expect(actionToken("allow")).toBe("[[ALLOW]]")
    expect(actionToken("always")).toBe("[[ALWAYS]]")
    expect(actionToken("deny")).toBe("[[DENY]]")
    expect(actionToken("none")).toBe("")
  })
})

describe("fail-closed behaviour", () => {
  test("in structured mode a malformed reply cannot act", () => {
    // llama.cpp/Ollama can ignore the schema and still return 200, so a reply we
    // asked to be JSON must not be trusted to carry a command.
    expect(parseCleanResponse("stop it now [[STOP]]", controlOnly, { structured: true })).toBe("stop it now")
    expect(parseCleanResponse("yes, always [[ALWAYS]]", permissionOnly, { structured: true })).toBe("yes, always")
  })

  test("in prose mode a token is still honoured", () => {
    expect(parseCleanResponse("stop it now [[STOP]]", controlOnly, { structured: false })).toBe("stop it now [[STOP]]")
    expect(parseCleanResponse("stop it now [[STOP]]", controlOnly)).toBe("stop it now [[STOP]]")
  })

  test("valid JSON keeps its action regardless", () => {
    expect(parseCleanResponse('{"text":"stop","action":"stop"}', controlOnly, { structured: true })).toBe("stop [[STOP]]")
  })
})
