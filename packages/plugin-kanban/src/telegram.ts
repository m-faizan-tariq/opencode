/**
 * The in-process Telegram front door.
 *
 * Long-polls `getUpdates` and funnels every allowed text message through the same `ingest` the
 * `/note` command uses, so a task arrives on the board and starts a worker session no matter
 * which door it came through. `fetch` is the only HTTP client, which is the design's rule that
 * this package adds no dependency.
 */

import type { Task } from "./board"
import { extractUrls, isSupportedMedia, type TelegramMediaInput } from "./media"

export interface TelegramDeps {
  readonly token: string
  /** The `KANBAN_TELEGRAM_CHATS` allowlist. Empty means unset, which allowlists nothing. */
  readonly allowed: ReadonlySet<string>
  /** The shared capture path. The chat id lets the card report its result back to Telegram. */
  readonly ingest: (text: string, chatID: string) => Promise<{ id: string; title: string }>
  readonly log: (message: string) => void
  /**
   * Turns an attachment or URL message into the text to ingest. Omitted by the tests and by any
   * caller that wants the plain `text`/`caption` pass-through.
   */
  readonly prepareCapture?: (input: {
    text?: string
    caption?: string
    media?: TelegramMediaInput
  }) => Promise<{ text: string; media: boolean }>
  /** Test seam for the poll re-arm delay, so a backoff can be observed without waiting for it. */
  readonly schedule?: (callback: () => void, ms: number) => void
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

/** A Telegram media attachment, narrowed to the fields the capture pipeline reads. */
export interface TelegramAttachment {
  readonly file_id: string
  readonly file_unique_id?: string
  readonly file_name?: string
  readonly mime_type?: string
  readonly file_size?: number
  readonly title?: string
  readonly duration?: number
}

interface TelegramMessage {
  readonly text?: string
  readonly caption?: string
  /**
   * Optional on the wire, though the type says otherwise.
   *
   * `handleUpdate` must never throw for a malformed update: the poll loop advances the offset
   * only after `handleUpdate` returns, so a throw would abort the batch with the offset unmoved
   * and Telegram would redeliver the same update on every poll, stalling the bot on one message.
   */
  readonly chat?: { readonly id: number }
  readonly video?: TelegramAttachment
  readonly video_note?: TelegramAttachment
  readonly audio?: TelegramAttachment
  readonly voice?: TelegramAttachment
  readonly document?: TelegramAttachment
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
 * Shows a typing indicator while a download or transcription runs.
 *
 * Best-effort: a failed `sendChatAction` is not worth a log line, and it must never stop the
 * capture. It is a courtesy so the user knows the bot is working, not a reply.
 */
async function sendChatAction(deps: TelegramDeps, chatID: string, action: string): Promise<void> {
  try {
    await call(deps, "sendChatAction", { chat_id: chatID, action })
  } catch {
    // Best-effort by design.
  }
}

/**
 * Picks the first attachment the media pipeline can download, in Telegram's own precedence.
 *
 * A `document` counts only when its mime type or file name says it is audio or video; a PDF or a
 * ZIP is not a task the pipeline can transcribe, and treating it as one would download a file for
 * nothing.
 */
function selectMedia(message: TelegramMessage): TelegramMediaInput | undefined {
  const kinds = ["video", "video_note", "audio", "voice", "document"] as const
  for (const kind of kinds) {
    const attachment = message[kind]
    if (!attachment) continue
    const media: TelegramMediaInput = { kind, ...attachment }
    if (isSupportedMedia(media)) return media
  }
  return undefined
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

  // A message with no chat is skipped, and for a stronger reason than a missing text: without it
  // there is nowhere to reply and nothing to allowlist against.
  if (!message?.chat) return update.update_id + 1

  const chatID = String(message.chat.id)

  if (!deps.allowed.has(chatID)) {
    deps.log(`kanban: ignoring chat ${chatID}`)
    await reply(deps, chatID, `This chat (${chatID}) isn't allowlisted. Add ${chatID} to KANBAN_TELEGRAM_CHATS and restart.`)

    return update.update_id + 1
  }

  const text = message.text ?? ""
  const caption = message.caption ?? ""

  if ((text || caption).startsWith("/start")) {
    await reply(deps, chatID, "Send me a task and I'll add it to your board and start working on it.")

    return update.update_id + 1
  }

  const media = selectMedia(message)

  // A message with no text, no caption, and no supported attachment is skipped without a reply —
  // a photo or a sticker is not a task, and answering it would be noise.
  if (!text.trim() && !caption.trim() && !media) return update.update_id + 1

  // The offset advances whether or not the capture and the reply succeed. Telegram redelivers an
  // update whose offset was never advanced, so tying the ack to either side effect would re-run
  // `ingest` on a transient failure. The design's rule is that no update is processed twice, so a
  // failed capture is logged and dropped rather than retried into a second card.
  //
  // `prepareCapture` is inside the try for the same reason: a download or transcription that
  // rejects unexpectedly must log and still ack, not escape and stall the poll on one update.
  try {
    let captured = text.trim() ? text : caption

    if (deps.prepareCapture) {
      if (media || extractUrls(`${text}\n${caption}`).length > 0) {
        await sendChatAction(deps, chatID, "typing")
      }

      const prepared = await deps.prepareCapture({ text, caption, media })
      captured = prepared.text
    }

    const task = await deps.ingest(captured, chatID)
    await reply(deps, chatID, `Added "${task.title}" as \`${task.id}\`. I've started working on it.`)
  } catch (error) {
    deps.log(`kanban: could not capture a task: ${error instanceof Error ? error.message : String(error)}`)
  }

  return update.update_id + 1
}

/**
 * Splits a long message into Telegram-sized chunks on a line or space boundary.
 *
 * Telegram rejects a `sendMessage` over 4096 characters. The chunk size is 3900 so a chunk that
 * grows a little in transit still fits. A hard cut is the last resort; a boundary inside a word
 * is better than a rejected message, but a boundary at a newline or space is better still.
 */
function splitMessage(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let rest = text

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit)
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }

  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/**
 * Sends one message to a Telegram chat, splitting it when it exceeds the API limit.
 *
 * A failure throws rather than being swallowed here: the caller decides whether a failed review
 * notification is worth a log line, and a caller that ignores the rejection must still be able to
 * tell the difference between a delivered message and a dropped one.
 */
export async function sendTelegramMessage(token: string, chatID: string, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  for (const chunk of splitMessage(text)) {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatID, text: chunk }),
    })

    if (!response.ok) throw new Error(`telegram sendMessage failed: ${response.status}`)
  }
}

export interface ReviewNotificationDeps {
  readonly token: string | undefined
  readonly ownsTelegram: boolean
  readonly log: (message: string) => void
  /** Test seam for the sender; defaults to `sendTelegramMessage`. */
  readonly send?: (token: string, chatID: string, text: string) => Promise<void>
}

/**
 * Reports a card that just entered `review` back to the Telegram chat it came from.
 *
 * Returns `undefined` when there is nothing to send: this process does not own the Telegram poll,
 * there is no token, the card was already in `review` before the event, or the card did not come
 * from Telegram. The caller fires the returned promise without awaiting it; the promise never
 * rejects, because a notification failure is logged rather than surfaced.
 */
export function maybeNotifyTelegramReview(before: Task, after: Task, deps: ReviewNotificationDeps): Promise<void> | undefined {
  if (!deps.ownsTelegram || !deps.token) return undefined
  if (before.status === "review" || after.status !== "review") return undefined
  if (after.source !== "telegram" && !after.telegramChatID) return undefined

  const chatID = after.telegramChatID
  if (!chatID) return undefined

  const body = after.result?.trim() || "The task finished; see the board for details."
  const text = `✅ Kanban task finished\n\n${after.title}\n\`${after.id}\`\n\n${body}`
  const send = deps.send ?? ((token, id, message) => sendTelegramMessage(token, id, message))

  return send(deps.token, chatID, text).catch((error) => {
    deps.log(`kanban: could not send the review summary to Telegram: ${error instanceof Error ? error.message : String(error)}`)
  })
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
  let backoff = 1_000
  const schedule = deps.schedule ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))

  const tick = async () => {
    if (signal.aborted) return

    try {
      // `signal` is passed through so teardown is prompt. A long poll would otherwise hold for
      // up to 25s before it noticed the abort, which makes every shutdown look like it hangs.
      const response = await fetch(`${API}/bot${deps.token}/getUpdates?offset=${offset}&timeout=25`, { signal })

      // A non-OK poll is thrown rather than swallowed, so a bad token or a dropped
      // connection reaches the log instead of being retried silently forever. A 409 is special:
      // it means another poller owns this bot, so the loop backs off for 10s instead of hammering
      // the API every second and keeping the conflict alive.
      if (!response.ok) {
        if (response.status === 409) {
          backoff = 10_000
          deps.log("kanban: telegram getUpdates returned 409 Conflict; another poller is active, backing off for 10s")
        }

        throw new Error(`telegram getUpdates failed: ${response.status}`)
      }

      backoff = 1_000

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

    if (!signal.aborted) schedule(() => void tick(), backoff)
  }

  void tick()
}
