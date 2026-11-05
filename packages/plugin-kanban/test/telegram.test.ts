import { afterEach, describe, expect, test } from "bun:test"
import { handleUpdate, startTelegram, type TelegramDeps, type TelegramUpdate } from "../src/telegram"

/**
 * `handleUpdate` talks to Telegram through the global `fetch`, so the tests replace it with a
 * recorder. Nothing here touches the board — `ingest` is injected — so there is no temp
 * directory and no risk of writing to the user's real board file.
 */
const realFetch = globalThis.fetch

interface Call {
  readonly url: string
  readonly body: Record<string, unknown>
}

let calls: Call[] = []
let handler: (url: string) => Response | Promise<Response> = () => new Response("{}", { status: 200 })

function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)

    if (url.includes("/sendMessage")) {
      calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    }

    return handler(url)
  }) as typeof fetch
}

function restoreFetch() {
  globalThis.fetch = realFetch
}

interface HarnessOptions {
  readonly allowed?: ReadonlySet<string>
  readonly ingestThrows?: boolean
}

function harness(options: HarnessOptions = {}) {
  const ingested: string[] = []
  const logged: string[] = []

  const deps: TelegramDeps = {
    token: "secret",
    allowed: options.allowed ?? new Set(["123"]),
    ingest: async (text: string) => {
      if (options.ingestThrows) throw new Error("ingest failed")
      ingested.push(text)

      return { id: "k_abc123", title: "Buy milk" }
    },
    log: (message: string) => logged.push(message),
  }

  return { deps, ingested, logged }
}

function update(text: string | undefined, chatID = 123, updateID = 7): TelegramUpdate {
  return { update_id: updateID, message: { text, chat: { id: chatID } } }
}

function sentTexts() {
  return calls.map((call) => String(call.body["text"] ?? ""))
}

afterEach(() => {
  calls = []
  handler = () => new Response("{}", { status: 200 })
  restoreFetch()
})

describe("handleUpdate", () => {
  test("captures an allowed message and replies with the task id", async () => {
    stubFetch()
    const { deps, ingested } = harness()

    const offset = await handleUpdate(deps, update("Buy milk"))

    expect(ingested).toEqual(["Buy milk"])
    expect(offset).toBe(8)
    expect(sentTexts()).toHaveLength(1)
    expect(sentTexts()[0]).toContain("Buy milk")
    expect(sentTexts()[0]).toContain("k_abc123")
  })

  test("replies to the chat the message came from", async () => {
    stubFetch()
    const { deps } = harness()

    await handleUpdate(deps, update("Buy milk", 999))

    expect(String(calls[0]?.body["chat_id"])).toBe("999")
  })

  test("a chat outside the allowlist is not captured", async () => {
    stubFetch()
    const { deps, ingested, logged } = harness()

    await handleUpdate(deps, update("Buy milk", 456))

    expect(ingested).toEqual([])
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain("456")
  })

  test("the not-allowlisted reply carries the chat id to allowlist", async () => {
    stubFetch()
    const { deps } = harness()

    await handleUpdate(deps, update("Buy milk", 456))

    // The design's rule: the bot replies "with the chat id and a line telling the user to
    // allowlist it". Without the id the user has to go and find their own chat id.
    const [text] = sentTexts()
    expect(text).toContain("456")
    expect(text).toContain("KANBAN_TELEGRAM_CHATS")
  })

  test("an empty allowlist allowlists nothing and still reports the chat id", async () => {
    stubFetch()
    const { deps, ingested } = harness({ allowed: new Set() })

    // `KANBAN_TELEGRAM_CHATS` unset is an empty set, which is the state the design describes
    // as "replies with the chat id and a line telling the user to allowlist it".
    await handleUpdate(deps, update("Buy milk", 42))

    expect(ingested).toEqual([])
    expect(sentTexts()[0]).toContain("42")
  })

  test("/start is answered with help and does not capture", async () => {
    stubFetch()
    const { deps, ingested } = harness()

    await handleUpdate(deps, update("/start"))

    expect(ingested).toEqual([])
    expect(sentTexts()[0]).toContain("Send me a task")
  })

  test("/start from an unknown chat gets the allowlist reply, not help", async () => {
    stubFetch()
    const { deps, ingested } = harness()

    await handleUpdate(deps, update("/start", 456))

    // The allowlist is checked before `/start`, deliberately: the reply is what tells the user
    // their chat id, and answering `/start` first would let anyone probe the bot.
    expect(ingested).toEqual([])
    const [text] = sentTexts()
    expect(text).toContain("456")
    expect(text).toContain("KANBAN_TELEGRAM_CHATS")
  })

  test("a message with no text is skipped without a reply", async () => {
    stubFetch()
    const { deps, ingested } = harness()

    const offset = await handleUpdate(deps, update(undefined))

    // A photo or a sticker is not a task, and answering it would be noise.
    expect(ingested).toEqual([])
    expect(calls).toHaveLength(0)
    expect(offset).toBe(8)
  })

  test("a message with no chat is skipped and still acked", async () => {
    stubFetch()
    const { deps, ingested } = harness()

    // A malformed update must not throw: the poll loop advances the offset only after
    // `handleUpdate` returns, so a throw would abort the batch with the offset unmoved and
    // Telegram would redeliver the same update on every poll, stalling the bot on one message.
    const offset = await handleUpdate(deps, { update_id: 7, message: { text: "Buy milk" } })

    expect(offset).toBe(8)
    expect(ingested).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test("an ingest failure is logged and the update is still acked", async () => {
    stubFetch()
    const { deps, ingested, logged } = harness({ ingestThrows: true })

    // The ack must not depend on the capture. If it did, Telegram would redeliver the update and
    // `ingest` would run a second time — a second card and a second worker session for one note.
    const offset = await handleUpdate(deps, update("Buy milk"))

    expect(offset).toBe(8)
    expect(ingested).toEqual([])
    expect(sentTexts()).toHaveLength(0)
    expect(logged.some((line) => line.includes("ingest failed"))).toBe(true)
  })

  test("a failed reply does not stop the update from being acked", async () => {
    stubFetch()
    const { deps, ingested, logged } = harness()

    // `sendMessage` fails on every call; `getUpdates` is not used by `handleUpdate`, so this is
    // the reply path alone. The reply is a courtesy — losing it must not cost the user their task.
    handler = () => new Response("{}", { status: 500 })

    const offset = await handleUpdate(deps, update("Buy milk"))

    expect(offset).toBe(8)
    expect(ingested).toEqual(["Buy milk"])
    expect(logged.some((line) => line.includes("sendMessage failed"))).toBe(true)
  })

  test("a failed reply still logs the chat id", async () => {
    stubFetch()
    const { deps, logged } = harness()

    handler = () => new Response("{}", { status: 500 })

    await handleUpdate(deps, update("Buy milk", 777))

    expect(logged.some((line) => line.includes("777"))).toBe(true)
  })
})

describe("startTelegram", () => {
  test("polls, processes a batch, and stops when aborted", async () => {
    stubFetch()
    const { deps, ingested } = harness()
    let polls = 0

    // Serve one update from `getUpdates`; the reply is recorded by the stub.
    handler = (url) => {
      if (url.includes("/getUpdates")) {
        polls++
        return new Response(
          JSON.stringify({ result: [{ update_id: 1, message: { text: "Buy milk", chat: { id: 123 } } }] }),
          { status: 200 },
        )
      }

      return new Response("{}", { status: 200 })
    }

    const controller = new AbortController()
    startTelegram(deps, controller.signal)

    // The loop re-arms on a 1s timer, so the test waits for the first batch to land rather than
    // racing it.
    for (let i = 0; i < 200 && ingested.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    controller.abort()

    // Aborting must actually stop the loop: the guard at the top of `tick` returns before the
    // re-arm, so no further `getUpdates` is issued. Without this the test would pass even if the
    // loop kept polling forever after teardown.
    const stopped = polls
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(ingested).toEqual(["Buy milk"])
    expect(polls).toBe(stopped)
  })

  test("a non-array result is skipped without advancing the offset", async () => {
    stubFetch()
    const { deps, logged } = harness()
    const offsets: string[] = []

    // A string `result` would make `handleUpdate` return `undefined + 1` = `NaN`, and an offset
    // of `NaN` makes every later poll 400 — the bot stalls forever. A malformed body must be
    // skipped, not iterated.
    handler = (url) => {
      if (url.includes("/getUpdates")) {
        offsets.push(new URL(url).searchParams.get("offset") ?? "")
        return new Response(JSON.stringify({ result: "not an array" }), { status: 200 })
      }

      return new Response("{}", { status: 200 })
    }

    const controller = new AbortController()
    startTelegram(deps, controller.signal)

    for (let i = 0; i < 400 && logged.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    controller.abort()

    // The offset is never advanced past its last good value (0), so the next poll retries.
    expect(offsets.every((value) => value === "0")).toBe(true)
    expect(logged.some((line) => line.includes("non-array result"))).toBe(true)
  })

  test("a malformed array element is skipped without corrupting the offset", async () => {
    stubFetch()
    const { deps, logged } = harness()
    const offsets: string[] = []

    // A bare string element makes `handleUpdate` return `undefined + 1` = `NaN`, and an offset
    // of `NaN` makes every later poll 400 — the bot stalls forever. The malformed element is
    // placed LAST so the batch ends on it: a loop that did not validate would leave the offset
    // at `NaN` and the assertion below would fail.
    handler = (url) => {
      if (url.includes("/getUpdates")) {
        offsets.push(new URL(url).searchParams.get("offset") ?? "")
        return new Response(JSON.stringify({ result: [{ update_id: 9 }, "not an update"] }), { status: 200 })
      }

      return new Response("{}", { status: 200 })
    }

    const controller = new AbortController()
    startTelegram(deps, controller.signal)

    for (let i = 0; i < 400 && offsets.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    controller.abort()

    // The good element acked to 10; the malformed one did not turn the offset into NaN.
    expect(offsets[0]).toBe("0")
    expect(offsets[1]).toBe("10")
    expect(logged.some((line) => line.includes("malformed update"))).toBe(true)
  })

  test("a non-OK poll is logged rather than retried silently", async () => {
    stubFetch()
    const { deps, logged } = harness()

    // A bad token is a 401 on every poll. Without the throw it would be swallowed and the bot
    // would spin forever with no diagnostic.
    handler = () => new Response("{}", { status: 401 })

    const controller = new AbortController()
    startTelegram(deps, controller.signal)

    for (let i = 0; i < 200 && logged.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    controller.abort()

    expect(logged.some((line) => line.includes("401"))).toBe(true)
  })

  test("a failed capture does not cause the update to be redelivered", async () => {
    stubFetch()
    const { deps } = harness({ ingestThrows: true })
    const offsets: string[] = []

    // The stub ignores the offset and always returns update 5, which is what Telegram does not
    // do — so if the loop ever re-sends offset 0 (or 5) the update would be handled a second time.
    handler = (url) => {
      if (url.includes("/getUpdates")) {
        offsets.push(new URL(url).searchParams.get("offset") ?? "")
        return new Response(
          JSON.stringify({ result: [{ update_id: 5, message: { text: "Buy milk", chat: { id: 123 } } }] }),
          { status: 200 },
        )
      }

      return new Response("{}", { status: 200 })
    }

    const controller = new AbortController()
    startTelegram(deps, controller.signal)

    // The loop re-arms on a 1s timer, so two polls need a little over a second.
    for (let i = 0; i < 400 && offsets.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    controller.abort()

    expect(offsets[0]).toBe("0")
    expect(offsets[1]).toBe("6")
  })
})
