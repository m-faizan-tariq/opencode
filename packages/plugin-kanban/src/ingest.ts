import type { Source } from "./board"
import type { BoardStore } from "./store"
import { workerPrompt } from "./worker"

export interface IngestDeps {
  readonly store: BoardStore
  /** The project directory the new card's board lives in. */
  readonly directory: string
  readonly session: {
    create(input: {
      agent?: string
      model?: { providerID: string; id: string }
      title?: string
      /**
       * The project the worker works in, which is also the board its card lives on.
       *
       * Without it `session.create` falls back to the server's `process.cwd()`
       * (`packages/server/src/handlers/session.ts:105`). The board is resolved from the worker
       * session's own `location.directory`, so a session created in the server's cwd would be
       * looked up against the wrong board, the linked card would never be found, and the card
       * would sit in `todo` forever instead of moving to `review`. The worker would also open
       * with no project context behind the card the user clicked.
       */
      location?: { directory: string }
    }): Promise<{ id: string }>
    // `Promise<unknown>`, not `Promise<void>`: `SessionApi["prompt"]` resolves to a
    // `SessionInbox.User`, which is not assignable to `void`, so `Promise<void>` rejects
    // `ctx.session` at the call site in `index.ts`. The result is never read.
    prompt(input: { sessionID: string; text: string }): Promise<unknown>
    /**
     * Deletes a session. Capture needs it to honour its own all-or-nothing rule: a worker
     * session that was created but never prompted is a session with no card behind it, and
     * leaving it behind would strand a session the user cannot reach from the board.
     */
    remove(input: { sessionID: string }): Promise<unknown>
  }
  /** From `KANBAN_WORKER_AGENT`; unset means the session default. */
  readonly agent?: string
  /** From `KANBAN_WORKER_MODEL` as `<providerID>/<modelID>`; unset means the session default. */
  readonly model?: { providerID: string; id: string }
  /**
   * Where cleanup failures go. The rollback is best-effort — the original error is the one worth
   * reporting — but a rollback that silently failed leaves an orphan session or a card with a
   * dangling `sessionID`, and that is invisible without a log line.
   */
  readonly log?: (message: string) => void
  /** Announces a board change once the captured card and its linked session are in place. */
  readonly changed?: (directory: string) => Promise<void> | void
}

/**
 * Splits a captured note into a card title and description.
 *
 * The title is the first non-empty line, because a pasted note often starts with a blank
 * line and falling back to "Untitled" would throw away the only useful text there is.
 * Everything after that line is the description. A title longer than 200 characters is
 * truncated, and the discarded tail is not carried into the description — the design asks
 * for a truncated first line, not a re-split one.
 */
export function parseNote(text: string): { title: string; description: string } {
  const lines = text.split(/\r\n|\r|\n/u)
  const start = lines.findIndex((line) => line.trim().length > 0)
  const title = (start < 0 ? text : lines[start]!).trim().slice(0, 200) || "Untitled"
  const description = (start < 0 ? [] : lines.slice(start + 1)).join("\n").trim()

  return { title, description }
}

/**
 * The one path that creates a card *with work attached*. Both front doors — Telegram and
 * `/note` — call this, so capture behaves identically whichever one the note came through.
 *
 * Creates the card, creates the worker session, links them, and starts the run. Capture is
 * all-or-nothing: if the session cannot be created (for example `KANBAN_WORKER_AGENT` names
 * an agent that does not exist), the card is removed again. A card with no `sessionID` is a
 * card with no door behind it, which breaks the rule that every card opens a session.
 */
export async function ingest(deps: IngestDeps, input: { text: string; source: Source; telegramChatID?: string }) {
  const { title, description } = parseNote(input.text)
  const { task } = deps.store.add(deps.directory, {
    title,
    description,
    source: input.source,
    ...(input.telegramChatID !== undefined ? { telegramChatID: input.telegramChatID } : {}),
  })

  let sessionID: string | undefined

  try {
    const session = await deps.session.create({
      agent: deps.agent,
      model: deps.model,
      title,
      // The worker has to live in the project the card lives on, not the server's cwd. See
      // `IngestDeps.session.create`'s `location` for why the default is not good enough.
      location: { directory: deps.directory },
    })
    sessionID = session.id

    const board = deps.store.update(deps.directory, task.id, { sessionID: session.id })
    await deps.session.prompt({ sessionID: session.id, text: workerPrompt(input.text) })
    await deps.changed?.(deps.directory)

    // Re-read from the store first so if the prompt hook moved the card to `working` during
    // `session.prompt`, the caller receives the updated status.
    return deps.store.find(deps.directory, task.id) ?? board.tasks.find((item) => item.id === task.id) ?? task
  } catch (error) {
    // Best-effort: the original error is the one worth reporting, so a failure to clean up
    // must not replace it.
    //
    // The session is removed first, because it is the thing capture created that the board has
    // no handle on. A worker session left behind after a failed prompt is a session the user
    // cannot open from the board, which is the exact failure the all-or-nothing rule exists to
    // prevent.
    if (sessionID) {
      try {
        await deps.session.remove({ sessionID })
      } catch (error) {
        deps.log?.(`kanban: could not remove the orphaned worker session: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    try {
      deps.store.remove(deps.directory, task.id)
    } catch (error) {
      deps.log?.(`kanban: could not remove the rolled-back card: ${error instanceof Error ? error.message : String(error)}`)
    }
    throw error
  }
}
