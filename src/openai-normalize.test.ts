import { describe, it, expect } from "vitest"
import {
  normalizeOpenAIChatBody,
  normalizeOpenAIDeveloperRole,
  normalizeOpenAIMaxTokens,
  normalizeOpenAIToolChoice,
} from "./openai-normalize.js"

function tool(name: string) {
  return { type: "function", function: { name } }
}

describe("normalizeOpenAIToolChoice", () => {
  it("leaves strings and undefined untouched", () => {
    expect(normalizeOpenAIToolChoice({ tool_choice: "required" }).changed).toBe(false)
    expect(normalizeOpenAIToolChoice({}).changed).toBe(false)
  })

  it("collapses enum-shaped objects to DevEco's enum strings", () => {
    for (const type of ["auto", "none", "required"]) {
      const r = normalizeOpenAIToolChoice({ tool_choice: { type } })
      expect(r.changed).toBe(true)
      expect(r.body.tool_choice).toBe(type)
    }
  })

  it("converts the OpenAI function object to required + narrowed tools", () => {
    const body = {
      tool_choice: { type: "function", function: { name: "bash" } },
      tools: [tool("bash"), tool("read")],
    }
    const r = normalizeOpenAIToolChoice(body)
    expect(r.changed).toBe(true)
    expect(r.body.tool_choice).toBe("required")
    expect(r.body.tools).toEqual([tool("bash")])
  })

  it("accepts the Anthropic-style {type:tool,name} object too", () => {
    const r = normalizeOpenAIToolChoice({
      tool_choice: { type: "tool", name: "read" },
      tools: [tool("read")],
    })
    expect(r.body.tool_choice).toBe("required")
    expect(r.body.tools).toHaveLength(1)
  })

  it("degrades to auto when the forced tool is not declared", () => {
    const r = normalizeOpenAIToolChoice({
      tool_choice: { type: "function", function: { name: "missing" } },
      tools: [tool("bash")],
    })
    expect(r.body.tool_choice).toBe("auto")
    expect(r.body.tools).toEqual([tool("bash")])
  })

  it("drops non-object garbage that DevEco would reject", () => {
    const r = normalizeOpenAIToolChoice({ tool_choice: 42 })
    expect(r.changed).toBe(true)
    expect("tool_choice" in r.body).toBe(false)
  })
})

describe("normalizeOpenAIDeveloperRole", () => {
  it("downgrades every developer message to system, content intact", () => {
    const body = {
      model: "GLM-5.1",
      messages: [
        { role: "developer", content: "You are a coding agent." },
        { role: "user", content: "hi" },
        { role: "developer", content: "Extra instructions." },
      ],
    }
    const r = normalizeOpenAIDeveloperRole(body)
    expect(r.changed).toBe(true)
    expect(r.body.messages).toEqual([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "hi" },
      { role: "system", content: "Extra instructions." },
    ])
    expect(body.messages[0].role).toBe("developer")
  })

  it("leaves system/user/assistant/tool messages untouched", () => {
    const body = {
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
        { role: "tool", content: "t", tool_call_id: "1" },
      ],
    }
    const r = normalizeOpenAIDeveloperRole(body)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(body)
  })

  it("tolerates a missing or malformed messages array", () => {
    expect(normalizeOpenAIDeveloperRole({}).changed).toBe(false)
    expect(normalizeOpenAIDeveloperRole({ messages: "nope" }).changed).toBe(false)
    const r = normalizeOpenAIDeveloperRole({ messages: [null, 7, { role: "developer", content: "x" }] })
    expect(r.changed).toBe(true)
    expect(r.body.messages).toEqual([null, 7, { role: "system", content: "x" }])
  })
})

describe("normalizeOpenAIMaxTokens", () => {
  it("renames max_completion_tokens to max_tokens", () => {
    const r = normalizeOpenAIMaxTokens({ max_completion_tokens: 100_000 })
    expect(r.changed).toBe(true)
    expect(r.body.max_tokens).toBe(100_000)
    expect("max_completion_tokens" in r.body).toBe(false)
  })

  it("keeps an explicit max_tokens and drops the alias", () => {
    const r = normalizeOpenAIMaxTokens({ max_tokens: 16, max_completion_tokens: 100_000 })
    expect(r.body.max_tokens).toBe(16)
    expect("max_completion_tokens" in r.body).toBe(false)
  })

  it("drops a non-numeric cap instead of forwarding garbage", () => {
    const r = normalizeOpenAIMaxTokens({ max_completion_tokens: "lots" })
    expect(r.changed).toBe(true)
    expect("max_tokens" in r.body).toBe(false)
  })

  it("leaves bodies without the alias untouched", () => {
    const body = { max_tokens: 32 }
    const r = normalizeOpenAIMaxTokens(body)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(body)
  })
})

describe("normalizeOpenAIChatBody", () => {
  it("applies the role, token-cap and tool_choice quirks in one pass", () => {
    const r = normalizeOpenAIChatBody({
      messages: [{ role: "developer", content: "sys" }],
      max_completion_tokens: 500,
      tool_choice: { type: "function", function: { name: "read" } },
      tools: [tool("read"), tool("write")],
    })
    expect(r.changed).toBe(true)
    expect(r.body.messages).toEqual([{ role: "system", content: "sys" }])
    expect(r.body.max_tokens).toBe(500)
    expect(r.body.tool_choice).toBe("required")
    expect(r.body.tools).toEqual([tool("read")])
  })

  it("reports a DevEco-clean body as unchanged", () => {
    const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 8 }
    const r = normalizeOpenAIChatBody(body)
    expect(r.changed).toBe(false)
    expect(r.body).toBe(body)
  })
})
