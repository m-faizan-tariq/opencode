import { For, Show, createSignal, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode/ui/icon"
import { createStore } from "solid-js/store"
import { Definition as KanbanRpc, type Task } from "@opencode/plugin-kanban/rpc"
import { createKeyed, usePlugin, type MountedSession } from "@opencode/plugin/gui"

const COLUMNS = ["backlog", "todo", "working", "review", "done"] as const

type Column = (typeof COLUMNS)[number]

/** The guard key for an `add`. One add at a time is enough: a second creates a second card. */
const ADD = "add"

/**
 * The guard key for deleting one card.
 *
 * Keyed by card, not by action: a second delete of the *same* card is the duplicate worth
 * blocking (the server rejects it with "no task with id"), while a delete of a different card is
 * a different action and must not be dropped.
 */
const REMOVE = (id: string) => `remove:${id}`

/**
 * The message an RPC failure carries.
 *
 * The client does not throw an `Error`: `makeRpc` (`packages/client/src/promise/rpc.ts:116`)
 * re-throws a plain `{ type, message }` object, so the `instanceof Error` branch never runs and
 * `String(cause)` would render `"[object Object]"` in the banner. The message is read off the
 * object when it is there, and the `String` fallback is only for a cause that is not an object at
 * all.
 */
const message = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message

  // SAFETY: `makeRpc` re-throws `{ type, message }`, where `message` is the error text it
  // extracted from the server's failure — not an `Error`, so the branch above never runs.
  const text = (cause as { message?: string } | null)?.message

  return text ?? String(cause)
}

/**
 * One board: the routed session's project.
 *
 * Every RPC carries the session id, which is what names the project — the panel has no other way to pick a board.
 *
 * The run is keyed by the session's `directory` and its server's `data`. The directory is what makes the board
 * per-project, and a session move gives it a new value (`sdk/host-apis.ts:568`) — keying on `session.key` instead
 * would keep showing the old project's board, because `key` is `${server}\n${session id}` and a move keeps it.
 *
 * `data` is the server's `Data` store, which the host recreates — a new object — when the server restarts or
 * re-authenticates, and that is when `ServerRef.client` becomes a new object. Without it in the key, a restart would
 * leave the panel reading through the old client — a 401 empties the board — and its one-shot `changed` subscription
 * would never reopen, silently ending live updates. `equals` compares that object identity.
 */
export default function KanbanPanel(props: { session: MountedSession }) {
  const ctx = usePlugin()

  const [board, setBoard] = createStore<{ tasks: readonly Task[]; error?: string }>({
    tasks: [],
  })

  const [draft, setDraft] = createSignal("")
  const [fullscreen, setFullscreen] = createSignal(false)
  const [draggedId, setDraggedId] = createSignal<string | undefined>()
  const [dragOverColumn, setDragOverColumn] = createSignal<Column | undefined>()
  /** The guarded writes in flight. Keyed per action and per card, so one duplicate never blocks an unrelated write. */
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())
  /** The current run. A response may only clear its guard while its run is still the current one. */
  let run = 0
  // The run's session, and the read that refreshes the board it belongs to. Both are set by the current run, so the
  // buttons act on the board they are looking at rather than on whatever session is routed when they are clicked.
  let session: MountedSession | undefined
  let load: (() => void) | undefined

  createKeyed(
    () => ({ directory: props.session.directory, data: props.session.server.data }),
    () => {
      const current = props.session
      const rpc = current.server.client.rpc(KanbanRpc)
      let stale = false

      run += 1
      session = current
      setDraft("")
      setPending(new Set<string>())
      load = () => {
        void rpc.list({ sessionID: current.id }).then(
          (tasks) => {
            if (!stale) setBoard({ tasks, error: undefined })
          },
          (cause: unknown) => {
            if (!stale) setBoard({ tasks: [], error: message(cause) })
          },
        )
      }

      setBoard({ tasks: [], error: undefined })
      load()

      // The server announces every write it handles. The panel re-reads rather than filtering on the
      // announced directory: the board is the `.git` root the write resolved to, which is not the
      // writing session's directory, so two sessions in one repo would each drop the other's write.
      // Boards are small and writes are rare, so a full read is cheaper than tracking the root.
      const off = rpc.events.on("changed", () => load?.())

      onCleanup(() => {
        stale = true
        off()
        session = undefined
        load = undefined
      })
    },
    {
      // `data` is a `Live` value, so this is what makes a server restart re-bind the run.
      equals: (previous, next) => previous.directory === next.directory && previous.data === next.data,
    },
  )

  const call = (
    action: (rpc: ReturnType<typeof client>, session: MountedSession) => Promise<Task | void>,
    hooks?: { readonly success?: () => void; readonly failure?: () => void; readonly guard?: string },
  ) => {
    const current = props.session ?? session

    if (!current?.id) return

    const guard = hooks?.guard

    if (guard && pending().has(guard)) return

    const mine = run

    if (guard) setPending(new Set(pending()).add(guard))

    // Deferred through a promise so a synchronous throw from the action reaches the handlers
    // instead of leaving the guard armed with nothing able to clear it.
    Promise.resolve()
      .then(() => action(client(current), current))
      .then(
        () => {
          release(guard, mine)
          hooks?.success?.()
          load?.()
        },
        (cause: unknown) => {
          release(guard, mine)
          setBoard({ error: message(cause) })
          hooks?.failure?.()
        },
      )
  }

  /**
   * Drops a guard once its response has arrived.
   */
  const release = (guard: string | undefined, _mine: number) => {
    if (!guard || !pending().has(guard)) return

    const next = new Set(pending())
    next.delete(guard)
    setPending(next)
  }

  const client = (session: MountedSession) => session.server.client.rpc(KanbanRpc)

  const add = () => {
    const raw = draft()
    const title = raw.trim()

    if (!title) return

    call((rpc, current) => rpc.add({ sessionID: current.id, title }), {
      guard: ADD,
      // The draft is cleared only once the card exists. Clearing it first would lose the title
      // the user typed if the add failed, and that is the one thing they cannot get back.
      //
      // And cleared only if the user has not typed anything while the request was in flight —
      // the same rule the failure path applies, for the same reason.
      success: () => {
        if (draft() === raw) setDraft("")
      },
      // Restored only if the user has not typed anything since the submit: their new words are
      // the one thing they cannot get back, and a late failure must not overwrite them.
      failure: () => {
        if (draft() === raw) setDraft(title)
      },
    })
  }

  const move = (id: string, status: Column) =>
    call((rpc, current) => rpc.move({ sessionID: current.id, id, status }))

  // Guarded per card: a double-click on × sends two deletes, and the second rejects with
  // "no task with id …", which would surface as a board error for a card the user already removed.
  const remove = (id: string) => call((rpc, current) => rpc.remove({ sessionID: current.id, id }), { guard: REMOVE(id) })

  const open = (task: Task, createIfMissing = false) => {
    const current = props.session ?? session

    if (!current) return

    if (task.sessionID) {
      ctx.tabs.open({ server: current.server.id, id: task.sessionID }, { focus: true })
      return
    }

    if (!createIfMissing) return

    call(async (rpc, curr) => {
      const updated = await rpc.ensureSession({ sessionID: curr.id, id: task.id })
      if (updated?.sessionID) {
        ctx.tabs.open({ server: curr.server.id, id: updated.sessionID }, { focus: true })
      }
      return updated
    })
  }

  const busy = () => pending().size > 0

  if (typeof window !== "undefined") {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && fullscreen()) {
        setFullscreen(false)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown))
  }

  const renderToolbar = (isFullscreen: boolean) => (
    <div class="flex shrink-0 items-center gap-2 border-b border-v2-border-border-base px-3 py-2">
      <Show when={isFullscreen}>
        <div class="mr-2 flex items-center gap-1.5 font-medium text-13-regular text-v2-text-text-base">
          <Icon name="grid-plus" class="size-4 text-v2-text-text-muted" />
          <span>{ctx.t("tab.title")}</span>
        </div>
      </Show>
      <input
        class="min-w-0 flex-1 rounded bg-v2-background-bg-layer-01 px-2 py-1 text-13-regular text-v2-text-text-base outline-none"
        placeholder={ctx.t("add.placeholder")}
        value={draft()}
        disabled={busy()}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add()
        }}
      />
      <button
        type="button"
        class="rounded bg-v2-background-bg-layer-02 px-2.5 py-1 text-13-regular text-v2-text-text-base transition-colors hover:bg-v2-background-bg-layer-03 disabled:opacity-50"
        disabled={busy()}
        aria-busy={busy()}
        onClick={add}
      >
        {ctx.t("add.label")}
      </button>
      <button
        type="button"
        class="flex items-center gap-1 rounded bg-v2-background-bg-layer-02 px-2 py-1 text-12-regular text-v2-text-text-base transition-colors hover:bg-v2-background-bg-layer-03"
        title={isFullscreen ? "Exit full screen (Esc)" : "Open full screen"}
        aria-label={isFullscreen ? "Exit full screen" : "Open full screen"}
        onClick={() => setFullscreen(!isFullscreen)}
      >
        <Icon name={isFullscreen ? "collapse" : "expand"} class="size-3.5" />
        <span class="text-11-regular">{isFullscreen ? "Exit (Esc)" : "Full screen"}</span>
      </button>
    </div>
  )

  const renderColumns = (isFullscreen: boolean) => (
    <div
      class="grid min-h-0 flex-1 gap-2 overflow-auto p-2"
      classList={{
        "grid-cols-[repeat(5,minmax(16rem,1fr))] gap-4 p-3": isFullscreen,
        "grid-cols-[repeat(5,minmax(7.5rem,1fr))]": !isFullscreen,
      }}
    >
      <For each={COLUMNS}>
        {(column, index) => (
          <div
            class="flex min-h-0 min-w-0 flex-col gap-2 rounded bg-v2-background-bg-layer-01 p-2 transition-colors"
            classList={{ "ring-1 ring-v2-border-border-base": dragOverColumn() === column }}
            data-column={column}
            onDragOver={(event) => {
              event.preventDefault()
              if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
              setDragOverColumn(column)
            }}
            onDragLeave={() => {
              if (dragOverColumn() === column) setDragOverColumn(undefined)
            }}
            onDrop={(event) => {
              event.preventDefault()
              const id = event.dataTransfer?.getData("text/plain") || draggedId()
              setDraggedId(undefined)
              setDragOverColumn(undefined)

              if (id) move(id, column)
            }}
          >
            <div class="text-11-regular font-medium tracking-wide text-v2-text-text-muted">
              {ctx.t(`column.${column}`)}
            </div>
            <For each={board.tasks.filter((task) => task.status === column)}>
              {(task) => (
                <div
                  class="group flex max-h-48 cursor-pointer select-none flex-col overflow-hidden rounded bg-v2-background-bg-layer-02 p-2.5 text-13-regular text-v2-text-text-base transition-colors hover:bg-v2-background-bg-layer-03"
                  classList={{ "opacity-60": draggedId() === task.id }}
                  data-task-id={task.id}
                  data-session-id={task.sessionID}
                  title={task.sessionID ? ctx.t("open.session") : undefined}
                  draggable
                  onClick={() => {
                    if (task.sessionID) open(task)
                  }}
                  onDblClick={() => {
                    open(task, true)
                  }}
                  onDragStart={(event) => {
                    setDraggedId(task.id)
                    if (event.dataTransfer) {
                      event.dataTransfer.effectAllowed = "move"
                      event.dataTransfer.setData("text/plain", task.id)
                    }
                  }}
                  onDragEnd={() => {
                    setDraggedId(undefined)
                    setDragOverColumn(undefined)
                  }}
                >
                  <div class="flex items-start justify-between gap-1">
                    <span
                      class="min-w-0 flex-1 break-words font-medium"
                      style={{
                        "display": "-webkit-box",
                        "-webkit-box-orient": "vertical",
                        "-webkit-line-clamp": "3",
                        "overflow": "hidden",
                      }}
                      title={task.title}
                    >
                      {task.title}
                    </span>
                    <div class="flex shrink-0 items-center gap-1">
                      <Show when={column === "backlog" || column === "todo"}>
                        <button
                          type="button"
                          class="rounded bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-11-regular text-v2-text-text-base opacity-80 hover:opacity-100 focus-visible:opacity-100"
                          data-action="start-task"
                          aria-label={ctx.t("start.label")}
                          title={ctx.t("start.label")}
                          onClick={(event) => {
                            event.stopPropagation()
                            move(task.id, "working")
                          }}
                        >
                          {ctx.t("start.label")}
                        </button>
                      </Show>
                      <Show when={index() > 0}>
                        <button
                          type="button"
                          class="px-1 text-12-regular text-v2-text-text-muted opacity-70 hover:opacity-100 focus-visible:opacity-100"
                          data-action="move-prev"
                          aria-label={`${ctx.t("move.to")} ${ctx.t(`column.${COLUMNS[index() - 1]!}`)}`}
                          title={`${ctx.t("move.to")} ${ctx.t(`column.${COLUMNS[index() - 1]!}`)}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            move(task.id, COLUMNS[index() - 1]!)
                          }}
                        >
                          ←
                        </button>
                      </Show>
                      <Show when={index() < COLUMNS.length - 1}>
                        <button
                          type="button"
                          class="px-1 text-12-regular text-v2-text-text-muted opacity-70 hover:opacity-100 focus-visible:opacity-100"
                          data-action="move-next"
                          aria-label={`${ctx.t("move.to")} ${ctx.t(`column.${COLUMNS[index() + 1]!}`)}`}
                          title={`${ctx.t("move.to")} ${ctx.t(`column.${COLUMNS[index() + 1]!}`)}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            move(task.id, COLUMNS[index() + 1]!)
                          }}
                        >
                          →
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="px-1 text-12-regular text-v2-text-text-muted opacity-70 hover:opacity-100 focus-visible:opacity-100"
                        aria-label={ctx.t("remove.label")}
                        title={ctx.t("remove.label")}
                        onClick={(event) => {
                          event.stopPropagation()
                          remove(task.id)
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <Show when={task.description}>
                    <span
                      class="mt-1 block break-words text-12-regular text-v2-text-text-muted"
                      style={{
                        "display": "-webkit-box",
                        "-webkit-box-orient": "vertical",
                        "-webkit-line-clamp": "2",
                        "overflow": "hidden",
                      }}
                      title={task.description}
                    >
                      {task.description}
                    </span>
                  </Show>
                  <Show when={task.result}>
                    <span
                      class="mt-1 block break-words text-12-regular text-v2-text-text-muted"
                      style={{
                        "display": "-webkit-box",
                        "-webkit-box-orient": "vertical",
                        "-webkit-line-clamp": "2",
                        "overflow": "hidden",
                      }}
                      title={task.result}
                    >
                      {task.result}
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  )

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-kanban-panel">
      {renderToolbar(false)}
      {renderColumns(false)}
      <Show when={board.error}>
        <div class="px-3 py-2 text-12-regular text-v2-text-text-muted">{board.error}</div>
      </Show>

      <Show when={fullscreen()}>
        <Portal mount={document.body}>
          <div
            class="fixed inset-0 z-[9999] flex flex-col bg-v2-background-bg-base text-v2-text-text-base shadow-2xl overflow-hidden"
            data-slot="session-kanban-fullscreen"
          >
            {renderToolbar(true)}
            {renderColumns(true)}
            <Show when={board.error}>
              <div class="px-3 py-2 text-12-regular text-v2-text-text-muted">{board.error}</div>
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  )
}
