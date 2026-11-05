/**
 * The in-process Telegram front door.
 *
 * Long-polls `getUpdates` and funnels every allowed text message through the same `ingest` the
 * `/note` command uses, so a task arrives on the board and starts a worker session no matter
 * which door it came through. `fetch` is the only HTTP client, which is the design's rule that
 * this package adds no dependency.
 */

export interface TelegramDeps {
  readonly token: string
  /** The `KANBAN_TELEGRAM_CHATS` allowlist. Empty means unset, which allowlists nothing. */
  readonly allowed: ReadonlySet<string>
  /** The shared capture path. */
  readonly ingest: (text: string) => Promise<{ id: string; title: string }>
  readonly log: (message: string) => void
}

/**
 * The subset of a `getUpdates` entry this needs.
 *
 * Declared locally rather than fetched from Telegram's types: the shape is three fields, and a
 * local type keeps the handler testable with a literal object instead of a fetched envelope.
 */
export interface TelegramUpdate {
  readonly update_id: number
  readonly message?: TelegramMessage
}

interface TelegramMessage {
  readonly text?: string
  /**
   * Optional on the wire, though the type says otherwise.
   *
   * `handleUpdate` must never throw for a malformed update: the poll loop advances the offset
   * only after `handleUpdate` returns, so a throw would abort the batch with the offset unmoved
   * and Telegram would redeliver the same update on every poll, stalling the bot on one message.
   */
  readonly chat?: { readonly id: number }
}

const API = "https://api.telegram.org"

async function call(deps: TelegramDeps, method: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${API}/bot${deps.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  if (!response.ok) throw new Error(`telegram ${method} failed: ${response.status}`)
}

/**
 * Sends a reply, logging a failure rather than throwing.
 *
 * The ack must not depend on the reply: a failed `sendMessage` that escaped here would leave the
 * offset unadvanced, Telegram would redeliver the update, and the capture would run a second
 * time — a second card and a second worker session for one note.
 */
async function reply(deps: TelegramDeps, chatID: string, text: string): Promise<void> {
  try {
    await call(deps, "sendMessage", { chat_id: chatID, text })
  } catch (error) {
    deps.log(`kanban: could not reply to ${chatID}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Handles one update and returns the offset to ack (`update_id + 1`).
 *
 * Split out of the poll loop so the routing is testable without a timer or a socket: the loop
 * is a thin shell over this, and everything with a decision in it lives here.
 *
 * A message with no text is skipped without a reply — a photo or a sticker is not a task, and
 * answering it would be noise.
 *
 * `/start` is checked *after* the allowlist, so an unknown chat gets the allowlist reply
 * rather than help. That is deliberate: the reply is what tells the user their chat id, and
 * answering `/start` first would make the bot respond to anyone who guesses the command. The
 * ordering is pinned by a test.
 *
 * The chat id goes in the not-allowlisted reply because that is the only way the user learns
 * what to put in `KANBAN_TELEGRAM_CHATS`: the bot cannot know the value, and a message that
 * says "you are not allowlisted" without the id leaves the user to go and find it.
 */
export async function handleUpdate(deps: TelegramDeps, update: TelegramUpdate): Promise<number> {
  const { message } = update

  // A message with no text is skipped without a reply — a photo or a sticker is not a task, and
  // answering it would be noise. A message with no chat is skipped for the same reason, and for a
  // stronger one: without it there is nowhere to reply and nothing to allowlist against.
  if (!message?.text || !message.chat) return update.update_id + 1

  const chatID = String(message.chat.id)

  if (!deps.allowed.has(chatID)) {
    deps.log(`kanban: ignoring chat ${chatID}`)
    await reply(deps, chatID, `This chat (${chatID}) isn't allowlisted. Add ${chatID} to KANBAN_TELEGRAM_CHATS and restart.`)

    return update.update_id + 1
  }

  if (message.text.startsWith("/start")) {
    await reply(deps, chatID, "Send me a task and I'll add it to your board and start working on it.")

    return update.update_id + 1
  }

  // The offset advances whether or not the capture and the reply succeed. Telegram redelivers an
  // update whose offset was never advanced, so tying the ack to either side effect would re-run
  // `ingest` on a transient failure. The design's rule is that no update is processed twice, so a
  // failed capture is logged and dropped rather than retried into a second card.
  try {
    const task = await deps.ingest(message.text)
    await reply(deps, chatID, `Added "${task.title}" as \`${task.id}\`. I've started working on it.`)
  } catch (error) {
    deps.log(`kanban: could not capture a task: ${error instanceof Error ? error.message : String(error)}`)
  }

  return update.update_id + 1
}

/**
 * Starts the poll loop and returns immediately.
 *
 * The loop is at-most-once per poll cycle: `handleUpdate` always returns an offset to ack, so an
 * update is never processed twice *within* a cycle, even when the capture or the reply failed.
 *
 * Telegram has no per-update ack — an update is only acked when a later `getUpdates` carries a
 * higher offset — so a crash between handling and the next poll redelivers it and the capture runs
 * again. Acking each update with a request of its own narrows that window but cannot close it,
 * because the ack itself can fail, so the offset is the only mechanism available and a redelivered
 * capture is the accepted cost. What the offset *does* buy is that a failure inside a cycle is
 * never retried into a second card: a capture pipeline that re-runs a task is worse than one that
 * occasionally sees one twice, because a re-run creates a second worker session and a second
 * card's worth of work.
 *
 * The loop never exits on its own. The caller owns the `AbortSignal` and is responsible for
 * aborting it on teardown; `setTimeout` would otherwise keep the process alive.
 */
export function startTelegram(deps: TelegramDeps, signal: AbortSignal): void {
  let offset = 0

  const tick = async () => {
    if (signal.aborted) return

    try {
      // `signal` is passed through so teardown is prompt. A long poll would otherwise hold for
      // up to 25s before it noticed the abort, which makes every shutdown look like it hangs.
      const response = await fetch(`${API}/bot${deps.token}/getUpdates?offset=${offset}&timeout=25`, { signal })

      // A non-OK poll is thrown rather than swallowed, so a bad token or a dropped
      // connection reaches the log instead of being retried silently forever.
      if (!response.ok) throw new Error(`telegram getUpdates failed: ${response.status}`)

      const payload = (await response.json()) as { result?: TelegramUpdate[] }

      // Telegram's contract is `result: TelegramUpdate[]`, but the wire is not trustworthy: a
      // non-array `result` makes `for...of` throw, and a string makes `handleUpdate` return
      // `undefined + 1`, which is `NaN` — an offset of `NaN` makes every later poll 400 and the
      // bot stalls forever. A malformed body is logged and skipped, leaving the offset where it
      // was, so the next poll retries rather than silently advancing past real updates.
      if (payload.result !== undefined && !Array.isArray(payload.result)) {
        throw new Error("telegram getUpdates returned a non-array result")
      }

      for (const update of payload.result ?? []) {
        if (signal.aborted) return

        // Each element is validated before it is acked. A malformed element — a bare string, a
        // number, an object with no `update_id` — would make `handleUpdate` return `NaN`, and an
        // offset of `NaN` makes every later poll 400, stalling the bot forever.
        if (typeof (update as { update_id?: unknown } | null)?.update_id !== "number") {
          deps.log("kanban: telegram getUpdates returned a malformed update; skipping it")
          continue
        }

        offset = await handleUpdate(deps, update)
      }
    } catch (error) {
      // An aborted poll rejects with an AbortError; that is the normal end of the loop, not a
      // failure worth logging.
      if (signal.aborted) return
      deps.log(`kanban: telegram poll failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!signal.aborted) setTimeout(() => void tick(), 1_000)
  }

  void tick()
}
