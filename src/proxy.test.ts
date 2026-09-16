import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { browserOpenCommand, parseJwt, parseRealName, userInfoFromJwt } from "./auth-login.js"
import { ConcurrencyGate, conversationKey, DevEcoProxy, idleBudget, sessionKeyFromHeaders } from "./proxy.js"
import { JsonTokenStore } from "./token-store.js"
import { log } from "./config.js"

// Helper: build a minimal JWT (header.payload.signature) with a given payload.
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.fake-sig`
}

describe("parseJwt", () => {
  it("extracts userId and userName from a valid JWT", () => {
    const token = makeJwt({ userId: "u123", userName: "Alice", exp: 1700000000 })
    const result = parseJwt(token)
    expect(result.userId).toBe("u123")
    expect(result.userName).toBe("Alice")
    expect(result.exp).toBe(1700000000)
  })

  it("returns empty strings for missing userId/userName", () => {
    const token = makeJwt({ exp: 100 })
    const result = parseJwt(token)
    expect(result.userId).toBe("")
    expect(result.userName).toBe("")
  })

  it("throws on a token without 3 parts", () => {
    expect(() => parseJwt("ab.cd")).toThrow("Invalid jwtToken format")
    expect(() => parseJwt("")).toThrow("Invalid jwtToken format")
  })

  it("handles non-string userId gracefully", () => {
    const token = makeJwt({ userId: 42, userName: true })
    const result = parseJwt(token)
    expect(result.userId).toBe("")
    expect(result.userName).toBe("")
  })
})

describe("userInfoFromJwt", () => {
  const tokens = { accessToken: "at", refreshToken: "rt" }

  it("rebuilds the identity a headless refresh doesn't return", () => {
    // Field names match a real DevEco jwtToken payload.
    const jwt = makeJwt({ userId: "u1", userName: "Alice", nationalCode: "CN", isRealName: true })
    const info = userInfoFromJwt(jwt, tokens)
    expect(info).toMatchObject({
      userId: "u1",
      userName: "Alice",
      countryCode: "CN",
      isRealName: true,
      accessToken: "at",
      refreshToken: "rt",
      jwtToken: jwt,
    })
  })

  it("falls back without inventing a real-name status", () => {
    const info = userInfoFromJwt(makeJwt({ userId: "u2", userName: "Bob" }), tokens)
    expect(info?.countryCode).toBe("CN")
    expect(info?.isRealName).toBe(false)
  })

  it("returns null for an unparseable token instead of throwing", () => {
    expect(userInfoFromJwt("not-a-jwt", tokens)).toBeNull()
  })
})

describe("browserOpenCommand", () => {
  // A real login URL: the `&` separators are what break unquoted cmd.
  const url =
    "https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply?port=10101&appid=1008&code=deadbeef"

  it("keeps the URL quoted on Windows so cmd doesn't split it at &", () => {
    const { command, args, shell } = browserOpenCommand("win32", url)
    expect(shell).toBe(true)
    expect(args).toEqual([])
    expect(command).toBe(`start "" "${url}"`)
  })

  it("passes the URL as a single argv on macOS and Linux", () => {
    expect(browserOpenCommand("darwin", url)).toEqual({
      command: "open",
      args: [url],
      shell: false,
    })
    expect(browserOpenCommand("linux", url)).toEqual({
      command: "xdg-open",
      args: [url],
      shell: false,
    })
  })
})

describe("parseRealName", () => {
  it("accepts the boolean shape DevEco returns today", () => {
    expect(parseRealName(true)).toBe(true)
    expect(parseRealName(false)).toBe(false)
  })

  it("still accepts the legacy string shape", () => {
    expect(parseRealName("true")).toBe(true)
    expect(parseRealName("false")).toBe(false)
    expect(parseRealName(undefined)).toBe(false)
  })
})

describe("/v2 path stripping", () => {
  const strip = (p: string) => p.replace(/^\/v2(?=\/|$)/, "") || "/"

  it("strips /v2 prefix", () => {
    expect(strip("/v2/chat/completions")).toBe("/chat/completions")
    expect(strip("/v2/models")).toBe("/models")
    expect(strip("/v2/status")).toBe("/status")
  })

  it("leaves non-/v2 paths unchanged", () => {
    expect(strip("/chat/completions")).toBe("/chat/completions")
    expect(strip("/models")).toBe("/models")
  })

  it("does not strip words that merely start with /v2", () => {
    expect(strip("/v2models")).toBe("/v2models")
  })

  it("maps bare /v2 to /", () => {
    expect(strip("/v2")).toBe("/")
    expect(strip("/v2/")).toBe("/")
  })
})

describe("idleBudget", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it("aborts once the upstream goes quiet", async () => {
    const b = idleBudget(120)
    expect(b.signal.aborted).toBe(false)
    await sleep(200)
    expect(b.signal.aborted).toBe(true)
    b.done()
  })

  it("lets a slow but live stream run past the idle window", async () => {
    const b = idleBudget(120)
    // Five 80ms gaps: 400ms total, well beyond the window, never silent for it.
    for (let i = 0; i < 5; i++) {
      await sleep(80)
      b.touch()
    }
    expect(b.signal.aborted).toBe(false)
    b.done()
  })

  it("stops the clock once the turn is done", async () => {
    const b = idleBudget(100)
    b.done()
    await sleep(200)
    expect(b.signal.aborted).toBe(false)
  })
})

describe("ConcurrencyGate", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it("admits up to `limit` holders at once and queues the rest", async () => {
    const gate = new ConcurrencyGate(2)
    const order: number[] = []
    let running = 0
    let peak = 0

    const task = async (id: number) => {
      await gate.acquire(`t${id}`)
      running++
      peak = Math.max(peak, running)
      order.push(id)
      await tick()
      running--
      gate.release()
    }

    await Promise.all([task(1), task(2), task(3)])
    expect(peak).toBe(2)
    // The third waits for a slot instead of failing.
    expect(order).toEqual([1, 2, 3])
  })

  it("serves waiters in arrival order after releases", async () => {
    const gate = new ConcurrencyGate(1)
    const order: number[] = []
    const task = async (id: number) => {
      await gate.acquire(`t${id}`)
      order.push(id)
      await tick()
      gate.release()
    }
    await Promise.all([task(1), task(2), task(3), task(4)])
    expect(order).toEqual([1, 2, 3, 4])
  })

  it("never exceeds the limit even when a holder throws", async () => {
    const gate = new ConcurrencyGate(1)
    let running = 0
    let peak = 0
    const task = async () => {
      await gate.acquire("boom")
      running++
      peak = Math.max(peak, running)
      try {
        throw new Error("upstream blew up")
      } finally {
        running--
        gate.release()
      }
    }
    await Promise.allSettled([task(), task()])
    expect(peak).toBe(1)
  })
})

describe("sessionKeyFromHeaders", () => {
  it("reads the supported explicit session headers in order", () => {
    expect(sessionKeyFromHeaders({ "x-deveco-session": "s1" })).toBe("s1")
    expect(sessionKeyFromHeaders({ "x-session-affinity": "s2" })).toBe("s2")
    expect(sessionKeyFromHeaders({ "x-session-id": "s3" })).toBe("s3")
    expect(sessionKeyFromHeaders({ "x-deveco-session": "s1", "x-session-id": "s3" })).toBe("s1")
  })

  it("returns null for missing or blank headers", () => {
    expect(sessionKeyFromHeaders({})).toBeNull()
    expect(sessionKeyFromHeaders({ "x-session-id": "   " })).toBeNull()
  })
})

describe("conversationKey", () => {
  const first = { role: "user", content: "开始" }
  const OLD_MODE = process.env.DEVECO_SESSION_KEY_MODE

  afterEach(() => {
    if (OLD_MODE === undefined) delete process.env.DEVECO_SESSION_KEY_MODE
    else process.env.DEVECO_SESSION_KEY_MODE = OLD_MODE
  })

  it("stays put as the conversation grows", () => {
    const round1 = conversationKey({ system: "sys", messages: [first] })
    const round2 = conversationKey({
      system: "sys",
      messages: [first, { role: "assistant", content: "好" }, { role: "user", content: "继续" }],
    })
    expect(round2).toBe(round1)
  })

  it("separates different conversations", () => {
    expect(conversationKey({ system: "sys", messages: [first] })).not.toBe(
      conversationKey({ system: "sys", messages: [{ role: "user", content: "另一个话题" }] }),
    )
  })

  it("keeps the key stable when only the system prompt changes (default mode)", () => {
    delete process.env.DEVECO_SESSION_KEY_MODE
    expect(conversationKey({ system: "system-A", messages: [first] })).toBe(
      conversationKey({ system: "system-B", messages: [first] }),
    )
  })

  it("anchors on the first USER message when the system prompt sits in messages[0]", () => {
    // OpenAI wire format (opencode): system lives at messages[0] and changes
    // every turn (current time, cwd…). The key must stay stable anyway.
    delete process.env.DEVECO_SESSION_KEY_MODE
    const body = (system: string) => ({
      messages: [
        { role: "system", content: system },
        { role: "user", content: "开始" },
      ],
    })
    expect(conversationKey(body("system with time: 1"))).toBe(
      conversationKey(body("system with time: 2")),
    )
  })

  it("includes the system prompt when DEVECO_SESSION_KEY_MODE=system-first", () => {
    process.env.DEVECO_SESSION_KEY_MODE = "system-first"
    expect(conversationKey({ system: "system-A", messages: [first] })).not.toBe(
      conversationKey({ system: "system-B", messages: [first] }),
    )
  })

  it("includes the OpenAI-style system message under system-first mode", () => {
    process.env.DEVECO_SESSION_KEY_MODE = "system-first"
    const body = (system: string) => ({
      messages: [
        { role: "system", content: system },
        { role: "user", content: "开始" },
      ],
    })
    expect(conversationKey(body("system-A"))).not.toBe(conversationKey(body("system-B")))
  })
})

// ---------------------------------------------------------------------------
// DevEcoProxy integration: DevEco's real endpoints are replaced with a mocked
// global fetch, so the full proxy pipeline (auth refresh → forward → usage
// logging) runs against a fake upstream.
// ---------------------------------------------------------------------------

describe("DevEcoProxy integration", () => {
  const OLD_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR
  let tmpDir: string
  let proxy: DevEcoProxy | null = null
  let originalFetch: typeof fetch
  const randomPort = () => 20000 + Math.floor(Math.random() * 1000)

  const mockUpstreamFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    // Requests to the local proxy under test go through the real HTTP stack;
    // only the proxy's outbound calls to DevEco are faked.
    if (url.includes("127.0.0.1")) return originalFetch(input, init)
    if (url.includes("jwToken/check")) {
      return new Response(
        JSON.stringify({
          status: true,
          userInfo: { accessToken: "mock-at", refreshToken: "mock-rt", nationalCode: "CN", realName: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    if (url.includes("/chat/completions")) {
      // A large non-streaming body split across many small chunks (> 4, which
      // is what the SSE tail-buffer used to cap at).
      const big = JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: "GLM-5.1",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "x".repeat(100_000) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 111, completion_tokens: 222, total_tokens: 333 },
      })
      const bytes = new TextEncoder().encode(big)
      let offset = 0
      const chunkSize = 4_000
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          while (offset < bytes.length) {
            controller.enqueue(bytes.slice(offset, offset + chunkSize))
            offset += chunkSize
          }
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } })
    }
    if (url.includes("exitSessionQueue")) return new Response("ok", { status: 200 })
    return new Response("{}", { status: 404 })
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-deveco-int-"))
    process.env.OPENCODE_CONFIG_DIR = tmpDir
    originalFetch = globalThis.fetch
    globalThis.fetch = mockUpstreamFetch as typeof fetch
  })

  afterEach(async () => {
    if (OLD_CONFIG_DIR === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = OLD_CONFIG_DIR
    globalThis.fetch = originalFetch
    if (proxy) await proxy.stop().catch(() => {})
    proxy = null
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const startProxy = async (): Promise<DevEcoProxy> => {
    proxy = new DevEcoProxy({ port: randomPort(), hostname: "127.0.0.1" })
    await proxy.start()
    return proxy
  }

  it("reports logged_in:true when only an expired jwtToken exists (silent refresh possible)", async () => {
    // An already-expired JWT: tryRestoreSession's refresh short-circuits
    // without a network call, leaving no live session.
    const expired = makeJwt({ userId: "u1", userName: "Old", exp: Math.floor(Date.now() / 1000) - 3600 })
    await new JsonTokenStore().save(expired)
    const p = await startProxy()
    const res = await (await fetch(`http://127.0.0.1:${p.getPort()}/v2/status`)).json()
    expect(res.logged_in).toBe(true)
  })

  it("reports logged_in:false when no credentials exist at all", async () => {
    const p = await startProxy()
    const res = await (await fetch(`http://127.0.0.1:${p.getPort()}/v2/status`)).json()
    expect(res.logged_in).toBe(false)
  })

  it("extracts usage from a large non-streaming response split across many chunks", async () => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)
    const p = await startProxy()
    const spy = vi.spyOn(log, "info")

    const res = await fetch(`http://127.0.0.1:${p.getPort()}/v2/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] }),
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.choices[0].message.content.length).toBe(100_000)
    // The proxy's own log line must carry the parsed usage.
    const logged = spy.mock.calls.some((args) =>
      args.some((a) => typeof a === "string" && a.includes("in=111 out=222")),
    )
    expect(logged).toBe(true)
  })

  it("answers 500 instead of exiting when the upstream fetch fails", async () => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)
    const p = await startProxy()

    // The upstream drops the connection before sending anything (DevEco resets
    // it when a request runs past its gateway limit). That rejection used to
    // escape handle() and kill the process as an unhandled rejection.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("127.0.0.1")) return originalFetch(input, init)
      if (url.includes("jwToken/check") || url.includes("exitSessionQueue")) {
        return mockUpstreamFetch(input, init)
      }
      throw new TypeError("fetch failed")
    }) as typeof fetch

    const res = await fetch(`http://127.0.0.1:${p.getPort()}/v2/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(500)
    expect(String((await res.json()).error)).toContain("upstream fetch failed")

    // Still serving: the next request must not find a dead process.
    const status = await (await fetch(`http://127.0.0.1:${p.getPort()}/v2/status`)).json()
    expect(status.logged_in).toBe(true)
  })

  it("serialises upstream requests and honours DEVECO_MAX_CONCURRENCY", async () => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)

    let inFlight = 0
    let peak = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("127.0.0.1")) return originalFetch(input, init)
      if (url.includes("jwToken/check") || url.includes("exitSessionQueue")) {
        return mockUpstreamFetch(input, init)
      }
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 120))
      inFlight--
      return new Response(
        JSON.stringify({
          id: "chatcmpl-gate",
          object: "chat.completion",
          model: "GLM-5.1",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    const chat = (port: number) =>
      fetch(`http://127.0.0.1:${port}/v2/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] }),
      })

    try {
      // Default: one upstream request at a time, the rest queue.
      delete process.env.DEVECO_MAX_CONCURRENCY
      const serial = await startProxy()
      await Promise.all([chat(serial.getPort()), chat(serial.getPort()), chat(serial.getPort())])
      expect(peak).toBe(1)

      // Raised cap: two may overlap, the third still waits.
      await serial.stop()
      peak = 0
      process.env.DEVECO_MAX_CONCURRENCY = "2"
      const parallel = await startProxy()
      await Promise.all([
        chat(parallel.getPort()),
        chat(parallel.getPort()),
        chat(parallel.getPort()),
      ])
      expect(peak).toBe(2)
    } finally {
      delete process.env.DEVECO_MAX_CONCURRENCY
    }
  })

  it("aborts the upstream turn and frees the slot when the client disconnects", async () => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)

    let upstreamCancelled = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("127.0.0.1")) return originalFetch(input, init)
      if (url.includes("jwToken/check") || url.includes("exitSessionQueue")) {
        return mockUpstreamFetch(input, init)
      }
      // The proxy forwards the client body as a Buffer (or a string on some
      // paths), so look at the bytes rather than assuming a type.
      const rawBody = init?.body
      const bodyText =
        typeof rawBody === "string"
          ? rawBody
          : rawBody instanceof Uint8Array
            ? Buffer.from(rawBody).toString("utf8")
            : ""
      if (bodyText.includes('"stream":true')) {
        // A stream that never ends on its own; a real fetch would tear the
        // upstream connection down when the signal aborts, so model that here.
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
            init?.signal?.addEventListener("abort", () => {
              upstreamCancelled = true
              controller.error(new Error("aborted"))
            })
          },
          pull: () => new Promise((r) => setTimeout(r, 50)),
          cancel: () => {
            upstreamCancelled = true
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-quick",
          object: "chat.completion",
          model: "GLM-5.1",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    const p = await startProxy()
    const chatUrl = `http://127.0.0.1:${p.getPort()}/v2/chat/completions`
    const payload = (stream: boolean) =>
      JSON.stringify({
        model: "GLM-5.1",
        messages: [{ role: "user", content: "hi" }],
        ...(stream ? { stream: true } : {}),
      })

    const ac = new AbortController()
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload(true),
      signal: ac.signal,
    })
    const reader = res.body!.getReader()
    await reader.read()

    // The client walks away mid-stream.
    await reader.cancel().catch(() => {})
    ac.abort()

    // The proxy must notice and stop draining the upstream...
    await vi.waitFor(() => expect(upstreamCancelled).toBe(true), { timeout: 2000 })

    // ...and release the concurrency slot: the next request is served at once.
    const started = Date.now()
    const second = await fetch(chatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload(false),
    })
    expect(second.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  /**
   * A client that hangs up while its request is still queued must not start an
   * upstream turn once the slot frees: `close` fired before the turn began, so
   * the turn has to be skipped instead of streaming into a dead socket.
   */
  const queuedDisconnectSkipsTurn = async (endpoint: string, payload: string): Promise<void> => {
    const fresh = makeJwt({ userId: "u1", userName: "New", exp: Math.floor(Date.now() / 1000) + 3600 })
    await new JsonTokenStore().save(fresh)

    // Held until the test has let the queued request be abandoned.
    let releaseFirstTurn!: () => void
    const firstTurnHeld = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })

    let upstreamTurns = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("127.0.0.1")) return originalFetch(input, init)
      if (url.includes("jwToken/check") || url.includes("exitSessionQueue")) {
        return mockUpstreamFetch(input, init)
      }
      upstreamTurns++
      // The first turn occupies the only slot until the test releases it.
      if (upstreamTurns === 1) await firstTurnHeld
      return new Response(
        JSON.stringify({
          id: "chatcmpl-queued",
          object: "chat.completion",
          model: "GLM-5.1",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    const p = await startProxy()
    const url = `http://127.0.0.1:${p.getPort()}${endpoint}`
    const post = (signal?: AbortSignal) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal,
      })

    const debugSpy = vi.spyOn(log, "debug")
    const logged = (needle: string) =>
      debugSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes(needle)),
      )

    const first = post()
    await vi.waitFor(() => expect(upstreamTurns).toBe(1), { timeout: 2000 })

    // The second request queues behind the first, then its client walks away.
    const ac = new AbortController()
    void post(ac.signal).catch(() => {
      /* the abort rejects client-side; expected */
    })
    await vi.waitFor(() => expect(logged("proxy: queued")).toBe(true), { timeout: 2000 })
    ac.abort()
    // Wait until the hang-up actually reached the server before freeing the
    // slot: that the skipped turn was still queued when the abort landed is
    // exactly the case under test. (Releasing first would race the socket
    // close through the event loop and sometimes admit the turn too early.)
    await vi.waitFor(() => expect(logged("client disconnected")).toBe(true), { timeout: 2000 })

    releaseFirstTurn()
    expect((await first).status).toBe(200)

    // Only the first turn ever reached upstream, and the slot was handed on:
    // the next request is served immediately.
    const started = Date.now()
    expect((await post()).status).toBe(200)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(upstreamTurns).toBe(2)
  }

  it("skips the upstream turn when a queued chat client disconnects", async () => {
    await queuedDisconnectSkipsTurn(
      "/v2/chat/completions",
      JSON.stringify({ model: "GLM-5.1", messages: [{ role: "user", content: "hi" }] }),
    )
  })

  it("skips the upstream turn when a queued anthropic client disconnects", async () => {
    await queuedDisconnectSkipsTurn(
      "/v2/anthropic/v1/messages",
      JSON.stringify({ model: "GLM-5.1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    )
  })
})
