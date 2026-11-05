import type { Task } from "./board";
import type { BoardStore } from "./store";

/**
 * The slice of a session event the board cares about.
 *
 * Declared locally instead of imported from `@opencode/schema` so the handler is testable
 * without building a full event envelope, and so this package does not reach into the
 * schema package's event internals. `sessionID` is required: every event the handler can
 * act on carries one, and an event without one is ignored before it reaches the store.
 */
export interface SessionEvent {
  readonly type: string
  readonly sessionID: string
  readonly text?: string
  readonly error?: { message?: string }
  /** Present on `session.execution.interrupted`, which the handler ignores. */
  readonly reason?: string
}

/**
 * The card a session is linked to, if any.
 *
 * A task is "linked" when its `sessionID` equals the session's — the whole mechanism
 * connecting a card to the session that worked on it. The board is scanned rather than
 * indexed: boards are small, and a scan stays correct after any board change without a cache
 * to invalidate.
 */
function linked(store: BoardStore, directory: string, sessionID: string): Task | undefined {
  return store.tasks(directory).find((item) => item.sessionID === sessionID)
}

/**
 * Moves the card linked to `sessionID` to `working`.
 *
 * The prompt hook's whole decision, kept out of `index.ts` so it can be tested without standing
 * up a plugin host. The rule it encodes is the design's: a message in a linked session means the
 * card is being worked on, which is what the board has to show the moment the user types.
 *
 * Returns the linked task, or `undefined` when the session is not linked. An unlinked prompt is
 * not the board's business, and the caller must not announce a change for it. A card that is
 * already `working` is also `undefined`: `update` bumps `updatedAt` even when the patch is empty,
 * so re-applying the same status would rewrite the board and announce a change for nothing.
 */
export function onPrompt(store: BoardStore, directory: string, sessionID: string): Task | undefined {
  const task = linked(store, directory, sessionID)
  if (!task || task.status === "working") return undefined
  store.update(directory, task.id, { status: "working" })

  // `update` replaced the task in place, so the lookup always succeeds. The fallback keeps the
  // return type total without asserting that.
  return store.find(directory, task.id) ?? task
}

/**
 * Applies one session event to the board.
 *
 * Unlinked sessions and unrecognised event types are no-ops. The stream carries every
 * event in the server, almost none of which concern the board, so the default is to ignore.
 *
 * Returns `true` when the event changed a linked task, `false` otherwise. The caller needs
 * this to emit the board's `changed` RPC event only when something actually moved — the
 * stream carries every session event in the server, so emitting unconditionally would have
 * the panel re-read on every text, tool call, and session that has nothing to do with it.
 */
export function handleEvent(store: BoardStore, directory: string, event: SessionEvent): boolean {
  const task = linked(store, directory, event.sessionID)

  if (!task) return false

  switch (event.type) {
    case "session.text.ended":
      // The last assistant message wins, which is what `result` means: the worker may emit
      // several messages in one run. `text` is optional here, and `update` drops an
      // explicit `undefined`, so a malformed event cannot erase a good result — but it would
      // still rewrite the board and announce a change, so it is skipped outright.
      //
      // An empty string is a different matter: that is a real message with nothing in it, and
      // the design's "overwritten each time" applies to it too.
      if (event.text === undefined) return false
      store.update(directory, task.id, { result: event.text })
      return true
    case "session.execution.succeeded":
      // A run that ends twice — a retry, or an event redelivered by the stream — must not bump
      // `updatedAt` or announce a change for a card that is already where it belongs.
      if (task.status === "review") return false
      store.update(directory, task.id, { status: "review" })
      return true
    case "session.execution.failed":
      // A failed run still belongs in review: the user needs to see why it stopped, and a
      // card stuck in `todo` with no result is the one outcome the board cannot explain.
      const result = event.error?.message ?? "the run failed"
      if (task.status === "review" && task.result === result) return false
      store.update(directory, task.id, { status: "review", result })
      return true
    // `session.execution.interrupted` and `session.execution.started` are deliberately
    // absent. An interruption means the user is driving, so the card is left where it is;
    // `started` is covered by the prompt hook, which moves the card to `working` when the
    // user begins a turn in the linked session.
  }

  return false
}
