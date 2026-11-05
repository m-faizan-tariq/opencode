import { Plugin } from "@opencode/plugin"
import type { Source } from "./board"
import { ingest } from "./ingest"
import type { BoardStore } from "./store"

/**
 * The session surface the commands need.
 *
 * Wider than `IngestDeps["session"]`: a command also has to write back into the session it was
 * typed in, and `/kanban` has to pass the invocation's delivery through. Declared separately
 * rather than extending `IngestDeps` because the two want different widths of the same API.
 *
 * The returns are `Promise<unknown>`, not `Promise<void>`. `SessionApi["prompt"]` resolves to a
 * `SessionInbox.User` and `synthetic` to a `SessionInbox.Synthetic`, and a non-void type is not
 * assignable to `void` — so `Promise<void>` rejects `ctx.session` at the call site in `index.ts`.
 * Nothing here reads the result, and `unknown` admits both the real client and a mock.
 */
export interface CommandSession {
  get?(input: {
    sessionID: string
  }): Promise<{
    agent?: string
    model?: { providerID: string; id: string }
  }>
  create(input: {
    agent?: string
    model?: { providerID: string; id: string }
    title?: string
    /** See `IngestDeps.session.create` — the worker must open in the project, not the server cwd. */
    location?: { directory: string }
  }): Promise<{ id: string }>
  prompt(input: { sessionID: string; text: string; delivery?: "steer" | "queue" }): Promise<unknown>
  /** See `IngestDeps.session.remove` — capture needs it to roll a failed run back cleanly. */
  remove(input: { sessionID: string }): Promise<unknown>
  synthetic(input: {
    sessionID: string
    text: string
    description?: string
    resume?: boolean
  }): Promise<unknown>
}

export interface CommandDeps {
  readonly store: BoardStore
  readonly session: CommandSession
  /** From `KANBAN_WORKER_AGENT`; unset means the session default. */
  readonly agent?: string
  /** From `KANBAN_WORKER_MODEL` as `<providerID>/<modelID>`; unset means the session default. */
  readonly model?: { providerID: string; id: string }
  /** See `IngestDeps.log` — a capture that fails to roll back is invisible without it. */
  readonly log?: (message: string) => void
  /** Announces a board change once a `/note` capture succeeds. */
  readonly changed?: (directory: string) => Promise<void> | void
}

/**
 * The board request a `/kanban` invocation turns into.
 *
 * A command has no output channel — `execute` returns `Promise<void>` — so it cannot render the
 * board itself. It hands the user's words to the agent, which owns the tools and renders the
 * markdown. Naming the tool keeps the mapping deterministic: a natural request relies on the
 * model picking the right tool, and that fails exactly on the ambiguous forms.
 *
 * The user's own words go in a labelled block rather than inside a sentence. Quoting them into
 * prose breaks on an embedded quote, and a sentence gives a crafted note a chance to read as an
 * instruction — the same exposure the worker prompt has. A labelled block at least makes the
 * boundary explicit.
 */
function boardRequest(sub: string | undefined, body: string): string {
  if (!sub || sub === "list" || sub === "show") {
    return "Show me my Kanban board. Use the kanban_list tool and show the markdown board it returns."
  }

  if (sub === "add") {
    return body
      ? `Add a Kanban card with this title:\n\n${body}\n\nUse the kanban_add tool, then kanban_list, and show me the board.`
      : "Add a card to my Kanban board. Ask me for the title."
  }

  if (sub === "move" || sub === "update" || sub === "delete") {
    return body
      ? `On my Kanban board, ${sub} this card:\n\n${body}\n\nUse the kanban_${sub} tool and show me the result.`
      : `Use the kanban_${sub} tool. Tell me which card, and what to change.`
  }

  return "Explain the /kanban command forms: /kanban, /kanban list, /kanban add <title>, /kanban move|update|delete <id> …"
}

/**
 * Runs one capture.
 *
 * The directory is resolved from the session the note was typed in, per invocation. The board
 * is per-project, and a command can be run from any session, so a directory captured once at
 * setup would put every capture in one project.
 */
async function capture(deps: CommandDeps, sessionID: string, text: string, source: Source) {
  let agent = deps.agent
  let model = deps.model

  if ((!agent || !model) && deps.session.get) {
    try {
      const caller = await deps.session.get({ sessionID })
      if (!agent && caller.agent) agent = String(caller.agent)
      if (!model && caller.model) {
        model = { providerID: String(caller.model.providerID), id: String(caller.model.id) }
      }
    } catch {
      // Fall back to session defaults if the caller session cannot be read.
    }
  }

  return ingest(
    {
      store: deps.store,
      directory: await deps.store.directory(sessionID),
      session: deps.session,
      agent,
      model,
      log: deps.log,
      changed: deps.changed,
    },
    { text, source },
  )
}

/**
 * Registers `/note` and `/kanban`.
 *
 * `/note` is the phone's other front door: it captures and starts work, exactly as a Telegram
 * message does, through the same `ingest`. `/kanban` is read-mostly — it asks the agent to use
 * the board tools, so there is one rendering path rather than a second one in the command.
 */
export function registerCommands(ctx: Pick<Plugin.Context, "command">, deps: CommandDeps) {
  return ctx.command.transform((editor) => {
    editor.add({
      name: "note",
      description: "Capture a task from your phone. Creates a card and starts an agent on it.",
      execute: async (invocation) => {
        const note = invocation.prompt.text.trim()

        // An empty note would create an "Untitled" card and start an agent on nothing. Asking
        // is cheaper than a card the user has to delete.
        if (!note) {
          await deps.session.prompt({
            sessionID: invocation.sessionID,
            delivery: invocation.delivery,
            text: "I typed /note with no text. Ask me what I want to capture.",
          })
          return
        }

        const task = await capture(deps, invocation.sessionID, note, "note")

        // `resume: false` is load-bearing. Without it the synthetic message would wake this
        // session and start a run on the confirmation. The worker session is the one that
        // should be running; this session only records what happened.
        //
        // `description` is load-bearing too, and for the opposite reason: it is the only field
        // either client renders. The TUI shows it as the notice body
        // (`tui/src/routes/session/index.tsx:2117`) and the app as the notice label
        // (`session-ui/src/timeline/session-timeline-row.tsx:469`); a synthetic with no
        // description is dropped outright by both (`tui/src/routes/session/rows.ts:383` and
        // `isNotice` at `session-ui/src/timeline/projection.ts:1086`). Omitting it would admit
        // the message and then show the user nothing.
        //
        // The design describes this as "the note as a user message, and an assistant message
        // holding the new task id". `synthetic` admits exactly one item, so the two are split
        // by role instead: `description` is what the user reads, and `text` is what the model
        // reads (`core/src/session/recent-text.ts:57` renders it as `[Synthetic context]`),
        // which is what puts the note in the session history.
        await deps.session.synthetic({
          sessionID: invocation.sessionID,
          resume: false,
          description: `Captured "${task.title}" as \`${task.id}\`. Work started in session ${task.sessionID}.`,
          text: note,
        })
      },
    })

    editor.add({
      name: "kanban",
      description: "Show or edit the Kanban board.",
      execute: async (invocation) => {
        const [sub, ...rest] = invocation.prompt.text.trim().split(/\s+/u)

        // A prompt, not a synthetic: this is a real request from the user and it has to reach
        // the model as one. Synthetic messages are the system's channel for injected context —
        // instructions, shell failures, background notices — and a request smuggled through
        // them is not a user turn.
        await deps.session.prompt({
          sessionID: invocation.sessionID,
          delivery: invocation.delivery,
          text: boardRequest(sub, rest.join(" ").trim()),
        })
      },
    })
  })
}
