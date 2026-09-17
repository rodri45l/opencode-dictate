import { describe, expect, test } from "bun:test"
import { classifyControl, classifyPermission } from "../src/sentinels"

describe("classifyControl", () => {
  test("detects leaving conversation mode", () => {
    expect(classifyControl("[[CONVERSATION_OFF]]")).toBe("conversation-off")
    expect(classifyControl("[[conversation off]]")).toBe("conversation-off")
    expect(classifyControl("sure [[conversation-off]]")).toBe("conversation-off")
  })

  test("detects stop", () => {
    expect(classifyControl("[[STOP]]")).toBe("stop")
    expect(classifyControl("okay [[stop]] now")).toBe("stop")
  })

  test("conversation-off wins over stop", () => {
    // "stop conversation mode" emits the off token only.
    expect(classifyControl("[[CONVERSATION_OFF]]")).toBe("conversation-off")
  })

  test("plain prompts carry no control token", () => {
    expect(classifyControl("stop the server please")).toBeNull()
    expect(classifyControl("how do I stop the process?")).toBeNull()
    expect(classifyControl("")).toBeNull()
  })
})

describe("classifyPermission", () => {
  test("maps each token", () => {
    expect(classifyPermission("[[ALLOW]]")).toBe("once")
    expect(classifyPermission("[[ALWAYS]]")).toBe("always")
    expect(classifyPermission("[[DENY]]")).toBe("reject")
  })

  test("is case-insensitive and tolerant of whitespace", () => {
    expect(classifyPermission("[[ allow ]]")).toBe("once")
    expect(classifyPermission("[[  DENY  ]]")).toBe("reject")
  })

  test("returns null when the speaker did not answer", () => {
    expect(classifyPermission("what does this permission do?")).toBeNull()
  })
})
