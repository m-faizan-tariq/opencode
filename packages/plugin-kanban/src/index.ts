import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin"
import { BoardStore } from "./store"
import { registerTools } from "./tools"
import { registerCommands } from "./command"
import { ingest } from "./ingest"
import { handleEvent, onPrompt } from "./events"
import { maybeNotifyTelegramReview, startTelegram } from "./telegram"
import { acquireTelegramLock, loadTelegramConfig } from "./telegram-config"
import { prepareTelegramCapture } from "./media"
import { workerPrompt } from "./worker"
import { Definition as KanbanRpc } from "./rpc"
import type { Priority, Status, Task } from "./rpc"

/**
 * Active RPC event emitters across all `Location` instances in this process.
 *
 * `PluginHost` runs `setup(ctx)` per `Location`, and `Rpc.emit` scopes its bus publication to
 * that location's `Location.Ref`. Broadcasting across all active emitters ensures the GUI panel
 * receives `changed` notifications even when a write originated in a different `Location` (such
 * as a worker session or `/note` command).
 */
const emitters = new Set<(directory: string) => Promise<void>>()
let telegramStarted = false

/**
 * The one place the plugin is assembled.
 *
 * Everything the other modules expose is deliberately inert — a store, five tools, two commands,
 * a capture path, an event handler, an RPC definition — so this file is where they are given the
 * host's real services and wired to each other. It is also the only file that knows which
 * directory a board lives in.
 */
/**
 * Parses `KANBAN_WORKER_MODEL` as `<providerID>/<modelID>`, splitting on the **first** `/`.
 *
 * A model id can itself contain a slash — `openrouter/anthropic/claude-sonnet-4-5` is a real
 * reference, and the codebase's own `Model.Ref` parsing splits on the first `/` too — so
 * `split("/", 2)` would truncate the id to `anthropic`. A value with no `/`, or nothing on both
 * sides of the first one, falls back to the session default: a half-built model fails
 * `session.create` validation and rolls the capture back with an error that points at the wrong
 * thing.
 *
 * Exported so the parsing is testable without standing up a plugin host.
 */
export function parseWorkerModel(value: string | undefined): { providerID: string; id: string } | undefined {
  const slash = value?.indexOf("/")

  if (!value || slash === undefined || slash <= 0 || slash >= value.length - 1) return undefined

  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

/**
 * The session calls the add path makes, narrowed so a test harness can stub them.
 *
 * `ctx.session` satisfies this shape; the point of naming it is that `addRpcTask` can be
 * exercised without standing up a plugin host.
 */
export interface AddRpcSession {
  get(input: { sessionID: string }): Promise<unknown>
  create(input: {
    agent?: string
    model?: { providerID: string; id: string }
    title?: string
    location?: { directory: string }
  }): Promise<{ id: string }>
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
  remove(input: { sessionID: string }): Promise<unknown>
}

export interface AddRpcDeps {
  readonly store: BoardStore
  /** The project directory the new card's board lives in. */
  readonly directory: string
  readonly session: AddRpcSession
  /** From `KANBAN_WORKER_AGENT`; unset means inherit the caller's agent. */
  readonly agent?: string
  /** From `KANBAN_WORKER_MODEL`; unset means inherit the caller's model. */
  readonly model?: { providerID: string; id: string }
  readonly log?: (message: string) => void
  readonly changed?: (directory: string) => Promise<void> | void
}

export interface AddRpcInput {
  readonly sessionID: string
  readonly title: string
  readonly description?: string
  readonly priority?: Priority
  readonly status?: Status
  readonly linkSessionID?: string
}

/**
 * The `rpc.add` body, extracted so the add path is testable without a plugin host.
 *
 * `input.sessionID` names the *caller's* board; it is not the new card's session.
 *
 * Three shapes:
 * - a card linked to an existing session (`linkSessionID`, from a drag or "Add to Kanban"):
 *   the link is kept, and a `working` card prompts that session only when it has not run yet;
 * - an explicit non-`working` status: the card is created in that column with no session;
 * - the default add: the card is created in `working` and a worker session is created, linked,
 *   and prompted. This is all-or-nothing — a session that cannot be created or prompted rolls
 *   the card and the session back, so a card never exists without a door behind it.
 */
export async function addRpcTask(deps: AddRpcDeps, input: AddRpcInput): Promise<Task> {
  if (input.linkSessionID) {
    const { task } = deps.store.add(deps.directory, {
      title: input.title,
      description: input.description,
      priority: input.priority,
      status: input.status,
      sessionID: input.linkSessionID,
    })

    // The linked session already exists, so a card that lands in `working` has to tell a fresh
    // session from one the user has already talked to: prompting a session with history would
    // send the worker a second brief for work already underway. A failure here is not fatal —
    // the card is linked either way, and the user can start it by hand.
    if (task.status === "working") {
      try {
        const info = (await deps.session.get({ sessionID: input.linkSessionID })) as { tokens?: { input?: number } }
        if ((info?.tokens?.input ?? 0) === 0) {
          await deps.session.prompt({
            sessionID: input.linkSessionID,
            text: workerPrompt([task.title, task.description].filter(Boolean).join("\n\n")),
          })
        }
      } catch (error) {
        deps.log?.(`kanban: could not prompt the linked session: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    await deps.changed?.(deps.directory)

    return deps.store.find(deps.directory, task.id) ?? task
  }

  if (input.status !== undefined && input.status !== "working") {
    const { task } = deps.store.add(deps.directory, {
      title: input.title,
      description: input.description,
      priority: input.priority,
      status: input.status,
    })

    await deps.changed?.(deps.directory)

    return task
  }

  // `store.add` validates the title before anything else, so a blank add throws without
  // creating a session to clean up.
  const { task } = deps.store.add(deps.directory, {
    title: input.title,
    description: input.description,
    priority: input.priority,
    status: "working",
  })

  let workerID: string | undefined

  try {
    let agent = deps.agent
    let model = deps.model

    if (!agent || !model) {
      try {
        const caller = (await deps.session.get({ sessionID: input.sessionID })) as {
          agent?: unknown
          model?: { providerID?: string; id?: string }
        }
        agent = agent ?? (caller.agent ? String(caller.agent) : undefined)
        model = model ?? (caller.model ? { providerID: String(caller.model.providerID), id: String(caller.model.id) } : undefined)
      } catch {
        // The caller's session is unreachable; the session defaults apply.
      }
    }

    const worker = await deps.session.create({
      agent,
      model,
      title: task.title,
      location: { directory: deps.directory },
    })
    workerID = worker.id

    deps.store.update(deps.directory, task.id, { status: "working", sessionID: workerID })
    await deps.session.prompt({ sessionID: workerID, text: workerPrompt([task.title, task.description].filter(Boolean).join("\n\n")) })
    await deps.changed?.(deps.directory)

    return deps.store.find(deps.directory, task.id) ?? task
  } catch (error) {
    // Best-effort: the original error is the one worth reporting, so a failure to clean up
    // must not replace it. The session is removed first, because it is the thing this path
    // created that the board has no handle on.
    if (workerID) {
      try {
        await deps.session.remove({ sessionID: workerID })
      } catch (cleanupError) {
        deps.log?.(`kanban: could not remove the orphaned worker session: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      }
    }

    try {
      deps.store.remove(deps.directory, task.id)
    } catch (cleanupError) {
      deps.log?.(`kanban: could not remove the rolled-back card: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
    }

    throw error
  }
}

export default Plugin.define({
  id: "opencode.kanban",
  async setup(ctx) {
    const agent = process.env.KANBAN_WORKER_AGENT
    const model = parseWorkerModel(process.env.KANBAN_WORKER_MODEL)
    const controller = new AbortController()

    // `Session.Info` has no top-level `directory`; the project root is `location.directory`
    // (`packages/schema/src/session.ts:54`). `ctx.location` would be the server's boot directory,
    // which is not the project the session is working in.
    const store = new BoardStore(async (sessionID) => (await ctx.session.get({ sessionID })).location.directory)

    const sessionWithPromptHook = {
      ...ctx.session,
      prompt: async (input: Parameters<typeof ctx.session.prompt>[0]) => {
        const result = await ctx.session.prompt(input)
        try {
          const directory = await store.directory(input.sessionID)
          const linked = store.tasks(directory).find((item) => item.sessionID === input.sessionID)
          if (linked?.status === "todo" && onPrompt(store, directory, input.sessionID)) {
            await announce(directory)
          }
        } catch {
          // Best-effort fallback if the worker session's location hook was not active yet.
        }
        return result
      },
    }

    const sessionNeedsPrompt = async (sessionID: string): Promise<boolean> => {
      try {
        const info = (await ctx.session.get({ sessionID })) as { tokens?: { input?: number } }
        return (info?.tokens?.input ?? 0) === 0
      } catch {
        return true
      }
    }

    const resolveCallerDefaults = async (sessionID: string) => {
      if (agent && model) return { agent, model }
      try {
        const caller = await ctx.session.get({ sessionID })
        return {
          agent: agent ?? (caller.agent ? String(caller.agent) : undefined),
          model: model ?? (caller.model ? { providerID: String(caller.model.providerID), id: String(caller.model.id) } : undefined),
        }
      } catch {
        return { agent, model }
      }
    }

    const deps = {
      store,
      session: sessionWithPromptHook,
      agent,
      model,
      log: (message: string) => console.error(message),
      changed: (directory: string) => announce(directory),
    }

    // The design asks for this once at setup, before the first note arrives: a capture whose
    // worker agent does not exist rolls the card back (`session.create` 404s), so without the
    // warning the user only learns about the mistake by losing the task they just sent.
    if (agent) {
      try {
        const { data } = await ctx.agent.list()
        if (!data.some((info) => String(info.id) === agent)) {
          console.error(`kanban: KANBAN_WORKER_AGENT "${agent}" matches no agent; captures will roll back`)
        }
      } catch (error) {
        console.error("kanban: could not check KANBAN_WORKER_AGENT", error)
      }
    }

    // `announce` is a `let` seeded with a no-op, then replaced as soon as the registration exists.
    // The RPC handlers below call it, and they only run after that assignment — so the no-op is
    // never observed, and `announce` does not have to be declared after the registration it
    // closes over.
    let announce: (directory: string) => Promise<void> = async () => undefined

    // Registered before the tools, because the tools announce their writes through it. Every
    // write has to emit `changed`, and the RPC handlers, the session event handler and the
    // prompt hook only cover three of the four writers — the tools are the fourth.
    const registration = await ctx.rpc.register(KanbanRpc, {
      list: async (input) => {
        const directory = await store.directory(input.sessionID)
        const tasks = store.tasks(directory)
        let changed = false
        for (const task of tasks) {
          if (!task.sessionID && task.title) {
            try {
              const res = await ctx.session.list({ search: task.title })
              const list = (res as { data?: Array<{ id: string; title: string }> })?.data ?? ((res as unknown) as Array<{ id: string; title: string }>)
              const match = list.find((s) => s.title === task.title)
              if (match) {
                store.update(directory, task.id, { sessionID: match.id })
                changed = true
              }
            } catch {}
          }
        }
        if (changed) {
          await announce(directory)
        }
        return store.tasks(directory)
      },
      add: async (input) => {
        const directory = await store.directory(input.sessionID)
        const trimmed = input.title.trim()

        if (/^\/note(?:\s+|$)/iu.test(trimmed)) {
          const noteText = [trimmed.replace(/^\/note\s*/iu, "").trim(), input.description].filter(Boolean).join("\n")
          if (noteText) {
            const inherited = await resolveCallerDefaults(input.sessionID)
            return ingest(
              {
                ...deps,
                directory,
                agent: inherited.agent,
                model: inherited.model,
              },
              { text: noteText, source: "note" },
            )
          }
        }

        return addRpcTask({ ...deps, directory }, input)
      },
      move: async (input) => {
        const directory = await store.directory(input.sessionID)
        const existing = store.find(directory, input.id)
        store.move(directory, input.id, input.status)

        if (input.status === "working" && existing) {
          try {
            let workerID = existing.sessionID
            let needsPrompt = false

            if (!workerID) {
              const inherited = await resolveCallerDefaults(input.sessionID)
              const worker = await ctx.session.create({
                agent: inherited.agent,
                model: inherited.model,
                title: existing.title,
                location: { directory },
              })
              workerID = worker.id
              store.update(directory, input.id, { status: "working", sessionID: workerID })
              await announce(directory)
              needsPrompt = true
            } else {
              needsPrompt = await sessionNeedsPrompt(workerID)
            }

            if (needsPrompt) {
              const text = [existing.title, existing.description].filter(Boolean).join("\n\n")
              await sessionWithPromptHook.prompt({ sessionID: workerID, text: workerPrompt(text) })
            }
          } catch (error) {
            console.error("kanban: could not start worker session when moving card to working", error)
          }
        }

        await announce(directory)

        return store.find(directory, input.id)!
      },
      update: async (input) => {
        const directory = await store.directory(input.sessionID)

        // Same reason as `add`: the caller's session must not overwrite the card's own link.
        store.update(directory, input.id, {
          title: input.title,
          description: input.description,
          priority: input.priority,
        })

        await announce(directory)

        return store.find(directory, input.id)!
      },
      remove: async (input) => {
        const directory = await store.directory(input.sessionID)
        store.remove(directory, input.id)
        await announce(directory)
      },
      ensureSession: async (input) => {
        const directory = await store.directory(input.sessionID)
        const existing = store.find(directory, input.id)
        if (!existing) throw new Error(`kanban: no task with id ${input.id}`)

        let sessionID: string | undefined = existing.sessionID
        let needsPrompt = false

        if (sessionID) {
          try {
            await ctx.session.get({ sessionID })
            if (existing.status === "working") {
              needsPrompt = await sessionNeedsPrompt(sessionID)
            }
          } catch {
            sessionID = undefined
          }
        }

        if (!sessionID) {
          try {
            const res = await ctx.session.list({ search: existing.title })
            const list = (res as { data?: Array<{ id: string; title: string }> })?.data ?? ((res as unknown) as Array<{ id: string; title: string }>)
            const match = list.find((s) => s.title === existing.title)
            if (match) {
              sessionID = match.id
              if (existing.status === "working") {
                needsPrompt = await sessionNeedsPrompt(sessionID)
              }
            }
          } catch {}
        }

        if (!sessionID) {
          try {
            const inherited = await resolveCallerDefaults(input.sessionID)
            const created = await ctx.session.create({
              agent: inherited.agent,
              model: inherited.model,
              title: existing.title,
              location: { directory },
            })
            sessionID = created.id
            if (existing.status === "working") {
              needsPrompt = true
            }
          } catch (error) {
            console.error("kanban: could not create session for task", error)
          }
        }

        if (sessionID) {
          store.update(directory, input.id, { sessionID })
          if (needsPrompt) {
            try {
              const text = [existing.title, existing.description].filter(Boolean).join("\n\n")
              await sessionWithPromptHook.prompt({ sessionID, text: workerPrompt(text) })
            } catch (err) {
              console.error("kanban: could not prompt worker session in ensureSession", err)
            }
          }
          await announce(directory)
        }

        return store.find(directory, input.id)!
      },
    })

    const emitLocal = async (directory: string) => {
      await registration.events.emit("changed", { directory })
    }
    emitters.add(emitLocal)

    // A panel refresh is best-effort: a failed emit must not fail the write that caused it, and
    // `changed` is a broadcast, not a reply to the caller. Every writer goes through this, so a
    // failure to reach the panel is logged once rather than surfacing as a failed tool call, a
    // failed RPC, or a rejected user prompt.
    announce = async (directory: string) => {
      for (const emit of emitters) {
        try {
          await emit(directory)
        } catch (error) {
          console.error("kanban: could not announce a board change", error)
        }
      }
    }

    await registerTools(ctx, { store, changed: announce })
    await registerCommands(ctx, deps)

    // The Telegram bot is optional, and it has no session. It lands on the global board: `HOME`
    // has no `.git`, so `resolvePath` falls through to `~/.opencode/kanban.json`. A literal `~`
    // would be resolved against the server's cwd, which is the wrong board.
    //
    // The config is resolved here rather than from `process.env` directly so a short-lived CLI
    // command and OpenCode Prod never read `~/.opencode/kanban-telegram.env` and poll the bot.
    // `ownsTelegram` is declared before the event loop because the loop reads it when a card enters
    // `review`; it is assigned by the Telegram block below before any event can arrive.
    const tgConfig = loadTelegramConfig()
    let ownsTelegram = false
    let releaseTelegramLock: (() => void) | undefined

    // Drive card state from session events. The envelope carries `type` at the top level and the
    // fields the board reads under `data`, so the two are re-joined before the handler sees it.
    //
    // The loop must never die and must never surface a rejection: it is the only thing moving cards
    // to `review`, and an unhandled rejection here would be invisible. Every failure is logged.
    void (async () => {
      try {
        for await (const envelope of ctx.event.subscribe()) {
          try {
            const data = envelope.data as { sessionID?: string; text?: string; error?: { message?: string } }
            const sessionID = data.sessionID
            if (!sessionID) continue

            const directory = await store.directory(sessionID)
            // The card's prior status is what distinguishes a card *entering* `review` from one
            // that is already there; a redelivered event must not notify twice.
            const before = store.tasks(directory).find((item) => item.sessionID === sessionID)

            // `handleEvent` reports whether the event changed a linked task. The stream carries
            // every event in the server, so emitting unconditionally would have the panel re-read
            // on each unrelated text and tool call.
            if (handleEvent(store, directory, { ...data, type: envelope.type, sessionID })) {
              await announce(directory)

              if (before) {
                const after = store.find(directory, before.id) ?? before
                void maybeNotifyTelegramReview(before, after, {
                  token: tgConfig.token,
                  ownsTelegram,
                  log: (message) => console.error(message),
                })
              }
            }
          } catch (error) {
            // A malformed event, or a session that no longer resolves, must not end the loop.
            console.error("kanban: could not handle a session event", error)
          }
        }
      } catch (error) {
        // The stream itself ended or failed. The board still works from the tools and the capture
        // path; only the automatic `review` transition is lost until the server restarts.
        console.error("kanban: the session event loop ended", error)
      }
    })()

    // Typing in a linked session is the user picking the card back up, so the card leaves `review`
    // (or `todo`) and goes to `working` again. The decision lives in `events.ts` so it is testable
    // without a plugin host; `onPrompt` reports whether it moved anything, so an unlinked prompt
    // does not announce a change.
    //
    // The body is wrapped because a session hook runs inside `SessionPrompt.prepare`
    // (`packages/core/src/session/prompt.ts:40`) with no error handling of its own: a rejection
    // here is a defect that fails the user's prompt. Board bookkeeping must never cost the user
    // their turn, so an unresolvable session or a failed write is logged and dropped.
    const prompt = await ctx.session.hook("prompt", async ({ sessionID }) => {
      try {
        const directory = await store.directory(sessionID)
        if (!onPrompt(store, directory, sessionID)) return

        await announce(directory)
      } catch (error) {
        console.error("kanban: could not move a card to working", error)
      }
    })

    // The Telegram block below takes the lock and starts the poll loop. A second live poller
    // would earn a 409 on every `getUpdates` and stall the bot, so the lock is what keeps this
    // process out of the way when another one owns the bot.
    if (tgConfig.token && !telegramStarted) {
      const token = tgConfig.token
      const lock = acquireTelegramLock(tgConfig.lockPath)

      if (!lock) {
        telegramStarted = true
        console.error("kanban: another process holds the Telegram lock; skipping the Telegram capture door")
      } else {
        telegramStarted = true
        ownsTelegram = true
        releaseTelegramLock = lock

        startTelegram(
          {
            token,
            allowed: tgConfig.chats,
            log: (message) => console.error(message),
            prepareCapture: (input) => prepareTelegramCapture(input, { token, groqApiKey: tgConfig.groqApiKey }),
            ingest: async (text, chatID) =>
              ingest({ ...deps, directory: process.env.HOME || homedir() }, { text, source: "telegram", telegramChatID: chatID }),
          },
          controller.signal,
        )
      }
    } else if (!tgConfig.token && !telegramStarted) {
      telegramStarted = true
      console.error("kanban: set KANBAN_TELEGRAM_TOKEN (or configure ~/.opencode/kanban-telegram.env in OpenCode Dev) to enable the Telegram capture door")
    }

    return async () => {
      controller.abort()
      emitters.delete(emitLocal)
      releaseTelegramLock?.()
      if (ownsTelegram) telegramStarted = false

      // Both disposals have to run. A rejecting `registration.dispose()` would otherwise skip
      // `prompt.dispose()` and leave the prompt hook registered on a plugin that is going away.
      try {
        await registration.dispose()
      } finally {
        await prompt.dispose()
      }
    }
  },
})
