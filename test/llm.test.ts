import { describe, expect, test } from "bun:test"
import { providerBase } from "../src/llm"

describe("providerBase", () => {
  test("maps the providers we can drive directly", () => {
    expect(providerBase("opencode-go")).toBe("https://opencode.ai/zen/go/v1")
    expect(providerBase("opencode")).toBe("https://opencode.ai/zen/v1")
    expect(providerBase("deepseek")).toBe("https://api.deepseek.com")
    expect(providerBase("openai")).toBe("https://api.openai.com/v1")
  })

  test("returns undefined for unsupported providers", () => {
    expect(providerBase("anthropic")).toBeUndefined()
    expect(providerBase("")).toBeUndefined()
  })
})
