import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode/ui/icon"
import { createStore } from "solid-js/store"
import { Definition as KanbanRpc, type Task } from "@opencode/plugin-kanban/rpc"
import { createKeyed, usePlugin, type MountedSession } from "@opencode/plugin/gui"
import {
  COLUMNS,
  filterTasks,
  formatTaskDate,
  handleDropOnColumn,
  readStoredListGroup,
  readStoredListSort,
  readStoredView,
  sectionExpanded,
  sortTasks,
  writeStoredListGroup,
  writeStoredListSort,
  writeStoredView,
  type Column,
  type DropColumnInput,
  type ListGroup,
  type ListSort,
  type ViewMode,
} from "./view"

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
 * object when it is there, and the `String` fallback is only for a cause that is not an object
 * at all.
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
  const [viewMode, setViewMode] = createSignal<ViewMode>(readStoredView())
  const [listGroup, setListGroup] = createSignal<ListGroup>(readStoredListGroup())
  const [listSort, setListSort] = createSignal<ListSort>(readStoredListSort())
  const [listFilter, setListFilter] = createSignal("")
  /** The user's explicit section expansions, keyed by column. Absent means "use the default". */
  const [expandedSections, setExpandedSections] = createSignal<Partial<Record<Column, boolean>>>({})
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

  const selectView = (mode: ViewMode) => {
    setViewMode(mode)
    writeStoredView(mode)
  }

  const selectListGroup = (group: ListGroup) => {
    setListGroup(group)
    writeStoredListGroup(group)
  }

  const selectListSort = (sort: ListSort) => {
    setListSort(sort)
    writeStoredListSort(sort)
  }

  const toggleSection = (column: Column, expanded: boolean) => {
    setExpandedSections({ ...expandedSections(), [column]: !expanded })
  }

  /** The tasks the list shows: filtered by the query, then ordered by the chosen sort. */
  const visibleTasks = createMemo(() => sortTasks(filterTasks(board.tasks, listFilter()), listSort()))

  /** The drop handlers one column shares, so the board and the list accept the same payloads. */
  const dropInput = (column: Column): DropColumnInput => ({
    tasks: board.tasks,
    draggedId: draggedId(),
    untitled: "Untitled",
    move,
    addSession: ({ sessionID, title, status }) =>
      call((rpc, current) => rpc.add({ sessionID: current.id, title, status, linkSessionID: sessionID })),
    endDrag: () => {
      setDraggedId(undefined)
      setDragOverColumn(undefined)
    },
  })

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
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-v2-border-border-base px-3 py-2">
      <Show when={isFullscreen}>
        <div class="mr-2 flex items-center gap-1.5 font-medium text-13-regular text-v2-text-text-base">
          <Icon name="grid-plus" class="size-4 text-v2-text-text-muted" />
          <span>{ctx.t("tab.title")}</span>
        </div>
      </Show>
      <input
        class="min-w-[6rem] flex-1 rounded bg-v2-background-bg-layer-01 px-2 py-1 text-13-regular text-v2-text-text-base outline-none"
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
        class="shrink-0 rounded bg-v2-background-bg-layer-02 px-2.5 py-1 text-13-regular text-v2-text-text-base transition-colors hover:bg-v2-background-bg-layer-03 disabled:opacity-50"
        disabled={busy()}
        aria-busy={busy()}
        onClick={add}
      >
        {ctx.t("add.label")}
      </button>
      <div
        role="group"
        aria-label={ctx.t("view.label")}
        class="flex shrink-0 items-center rounded bg-v2-background-bg-layer-02 p-0.5"
      >
        <button
          type="button"
          data-view-toggle="board"
          aria-pressed={viewMode() === "board"}
          class="rounded px-2 py-1 text-12-regular transition-colors"
          classList={{
            "bg-v2-background-bg-layer-03 text-v2-text-text-base": viewMode() === "board",
            "text-v2-text-text-muted hover:text-v2-text-text-base": viewMode() !== "board",
          }}
          onClick={() => selectView("board")}
        >
          {ctx.t("view.board")}
        </button>
        <button
          type="button"
          data-view-toggle="list"
          aria-pressed={viewMode() === "list"}
          class="rounded px-2 py-1 text-12-regular transition-colors"
          classList={{
            "bg-v2-background-bg-layer-03 text-v2-text-text-base": viewMode() === "list",
            "text-v2-text-text-muted hover:text-v2-text-text-base": viewMode() !== "list",
          }}
          onClick={() => selectView("list")}
        >
          {ctx.t("view.list")}
        </button>
      </div>
      <button
        type="button"
        class="flex shrink-0 items-center gap-1 rounded bg-v2-background-bg-layer-02 px-2 py-1 text-12-regular text-v2-text-text-base transition-colors hover:bg-v2-background-bg-layer-03"
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
      class="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-2 overflow-x-auto overflow-y-hidden p-2"
      classList={{
        "grid-cols-[repeat(5,minmax(16rem,1fr))] gap-4 p-3": isFullscreen,
        "grid-cols-[repeat(5,minmax(10rem,1fr))]": !isFullscreen,
      }}
    >
      <For each={COLUMNS}>
        {(column, index) => (
          <div
            class="flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden rounded bg-v2-background-bg-layer-01 p-2 transition-colors"
            classList={{ "ring-1 ring-v2-border-border-base": dragOverColumn() === column }}
            data-column={column}
            onDragOver={(event) => {
              event.preventDefault()

              if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
              setDragOverColumn(column)
            }}
            onDragLeave={() => {
              if (dragOverColumn() === column) setDragOverColumn(undefined)
            }}
            onDrop={(event) => handleDropOnColumn(event, column, dropInput(column))}
          >
            <div class="shrink-0 text-11-regular font-medium tracking-wide text-v2-text-text-muted">
              {ctx.t(`column.${column}`)}
            </div>
            <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" data-column-cards={column} data-scrollable>
              <For each={board.tasks.filter((task) => task.status === column)}>
                {(task) => (
                  <div
                    class="group flex max-h-48 shrink-0 cursor-pointer select-none flex-col overflow-hidden rounded bg-v2-background-bg-layer-02 p-2.5 text-13-regular text-v2-text-text-base transition-colors hover:bg-v2-background-bg-layer-03"
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
          </div>
        )}
      </For>
    </div>
  )

  /** One full-width task row: the header carries the title, badges and actions; the body the text. */
  const renderTaskRow = (task: Task) => {
    const index = COLUMNS.indexOf(task.status)
    const updated = formatTaskDate(task.updatedAt)

    return (
      <div
        class="flex min-w-0 cursor-pointer select-none flex-col rounded bg-v2-background-bg-layer-02 p-2.5 text-13-regular text-v2-text-text-base transition-colors hover:bg-v2-background-bg-layer-03"
        classList={{ "opacity-60": draggedId() === task.id }}
        data-task-id={task.id}
        data-session-id={task.sessionID}
        data-list-row
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
        <div class="flex items-start gap-2">
          <span class="shrink-0 cursor-grab select-none text-12-regular text-v2-text-text-muted" aria-hidden="true">
            ⋮⋮
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-2">
              <span class="min-w-0 flex-1 break-words font-medium">{task.title}</span>
              <div class="flex shrink-0 flex-wrap items-center gap-1">
                <select
                  class="rounded bg-v2-background-bg-layer-01 px-1 py-0.5 text-11-regular text-v2-text-text-base outline-none"
                  data-action="move-status"
                  aria-label={ctx.t("list.status")}
                  value={task.status}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation()
                    // SAFETY: the options are exactly the Column values.
                    move(task.id, event.currentTarget.value as Column)
                  }}
                >
                  <For each={COLUMNS}>
                    {(column) => <option value={column}>{ctx.t(`column.${column}`)}</option>}
                  </For>
                </select>
                <Show when={task.status === "backlog" || task.status === "todo"}>
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
                <Show when={index > 0}>
                  <button
                    type="button"
                    class="px-1 text-12-regular text-v2-text-text-muted opacity-70 hover:opacity-100 focus-visible:opacity-100"
                    data-action="move-prev"
                    aria-label={`${ctx.t("move.to")} ${ctx.t(`column.${COLUMNS[index - 1]!}`)}`}
                    title={`${ctx.t("move.to")} ${ctx.t(`column.${COLUMNS[index - 1]!}`)}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      move(task.id, COLUMNS[index - 1]!)
                    }}
                  >
                    ←
                  </button>
                </Show>
                <Show when={index < COLUMNS.length - 1}>
                  <button
                    type="button"
                    class="px-1 text-12-regular text-v2-text-text-muted opacity-70 hover:opacity-100 focus-visible:opacity-100"
                    data-action="move-next"
                    aria-label={`${ctx.t("move.to")} ${ctx.t(`column.${COLUMNS[index + 1]!}`)}`}
                    title={`${ctx.t("move.to")} ${ctx.t(`column.${COLUMNS[index + 1]!}`)}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      move(task.id, COLUMNS[index + 1]!)
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
            <div class="mt-1 flex flex-wrap items-center gap-1.5 text-11-regular text-v2-text-text-muted">
              <span class="rounded bg-v2-background-bg-layer-01 px-1.5 py-0.5">{task.priority}</span>
              <span class="rounded bg-v2-background-bg-layer-01 px-1.5 py-0.5">{task.source}</span>
              <Show when={updated}>
                <span class="rounded bg-v2-background-bg-layer-01 px-1.5 py-0.5">{updated}</span>
              </Show>
              <Show when={task.sessionID}>
                <span class="rounded bg-v2-background-bg-layer-01 px-1.5 py-0.5">{ctx.t("list.session")}</span>
              </Show>
            </div>
          </div>
        </div>
        <Show when={task.description}>
          <span
            class="mt-1 block break-words text-12-regular text-v2-text-text-muted"
            style={{
              "display": "-webkit-box",
              "-webkit-box-orient": "vertical",
              "-webkit-line-clamp": "3",
              "overflow": "hidden",
            }}
            title={task.description}
          >
            {task.description}
          </span>
        </Show>
        <Show when={task.result}>
          <span
            class="mt-1 block break-words border-l-2 border-v2-border-border-base pl-2 text-12-regular text-v2-text-text-muted"
            style={{
              "display": "-webkit-box",
              "-webkit-box-orient": "vertical",
              "-webkit-line-clamp": "3",
              "overflow": "hidden",
            }}
            title={task.result}
          >
            {task.result}
          </span>
        </Show>
      </div>
    )
  }

  /** One collapsible status section. Empty sections start collapsed unless the user expanded them. */
  const renderSection = (column: Column) => {
    const tasks = () => visibleTasks().filter((task) => task.status === column)
    const count = () => tasks().length
    const expanded = () => sectionExpanded(expandedSections()[column], count())

    return (
      <section
        class="flex min-w-0 flex-col rounded bg-v2-background-bg-layer-01"
        data-list-section={column}
        onDragOver={(event) => {
          event.preventDefault()

          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
        }}
        onDrop={(event) => handleDropOnColumn(event, column, dropInput(column))}
      >
        <button
          type="button"
          class="flex w-full shrink-0 items-center gap-2 rounded px-2 py-1.5 text-left text-12-regular text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
          aria-expanded={expanded()}
          onClick={() => toggleSection(column, expanded())}
        >
          <span class="text-v2-text-text-muted">{expanded() ? "▾" : "▸"}</span>
          <span class="font-medium">{ctx.t(`column.${column}`)}</span>
          <span class="rounded bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-11-regular text-v2-text-text-muted">
            {count()}
          </span>
        </button>
        <Show when={expanded()}>
          <div class="flex flex-col gap-2 p-2 pt-0">
            <For each={tasks()}>{(task) => renderTaskRow(task)}</For>
            <Show when={count() === 0}>
              <div class="px-2 py-1 text-12-regular text-v2-text-text-muted">{ctx.t("list.empty")}</div>
            </Show>
          </div>
        </Show>
      </section>
    )
  }

  const renderListControls = () => (
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-v2-border-border-base px-3 py-2">
      <div class="relative min-w-[8rem] flex-1">
        <input
          class="w-full rounded bg-v2-background-bg-layer-01 px-2 py-1 pr-6 text-13-regular text-v2-text-text-base outline-none"
          data-list-filter
          placeholder={ctx.t("list.filter")}
          value={listFilter()}
          onInput={(event) => setListFilter(event.currentTarget.value)}
        />
        <Show when={listFilter()}>
          <button
            type="button"
            class="absolute right-1 top-1/2 -translate-y-1/2 px-1 text-12-regular text-v2-text-text-muted hover:text-v2-text-text-base"
            aria-label={ctx.t("list.clear")}
            title={ctx.t("list.clear")}
            onClick={() => setListFilter("")}
          >
            ×
          </button>
        </Show>
      </div>
      <label class="flex shrink-0 items-center gap-1 text-12-regular text-v2-text-text-muted">
        {ctx.t("list.group")}
        <select
          class="rounded bg-v2-background-bg-layer-01 px-1.5 py-1 text-12-regular text-v2-text-text-base outline-none"
          data-list-group
          value={listGroup()}
          onChange={(event) => {
            // SAFETY: the options are exactly the ListGroup values.
            selectListGroup(event.currentTarget.value as ListGroup)
          }}
        >
          <option value="sections">{ctx.t("list.group.sections")}</option>
          <option value="flat">{ctx.t("list.group.flat")}</option>
        </select>
      </label>
      <label class="flex shrink-0 items-center gap-1 text-12-regular text-v2-text-text-muted">
        {ctx.t("list.sort")}
        <select
          class="rounded bg-v2-background-bg-layer-01 px-1.5 py-1 text-12-regular text-v2-text-text-base outline-none"
          data-list-sort
          value={listSort()}
          onChange={(event) => {
            // SAFETY: the options are exactly the ListSort values.
            selectListSort(event.currentTarget.value as ListSort)
          }}
        >
          <option value="default">{ctx.t("list.sort.default")}</option>
          <option value="updated">{ctx.t("list.sort.updated")}</option>
          <option value="priority">{ctx.t("list.sort.priority")}</option>
        </select>
      </label>
    </div>
  )

  const renderListBody = () => (
    <div class="min-h-0 flex-1 overflow-y-auto" data-list-scroll data-scrollable>
      <Show when={listGroup() === "sections"}>
        <div class="flex flex-col gap-2 p-2">
          <For each={COLUMNS}>{(column) => renderSection(column)}</For>
        </div>
      </Show>
      <Show when={listGroup() === "flat"}>
        <div class="flex flex-col gap-2 p-2" data-list-flat>
          <For each={visibleTasks()}>{(task) => renderTaskRow(task)}</For>
          <Show when={visibleTasks().length === 0}>
            <div class="px-3 py-6 text-center text-13-regular text-v2-text-text-muted">
              {board.tasks.length === 0 ? ctx.t("list.empty") : ctx.t("list.empty.filtered")}
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )

  const renderListView = () => (
    <>
      {renderListControls()}
      {renderListBody()}
    </>
  )

  return (
    <div
      class="flex h-full min-h-0 flex-col bg-v2-background-bg-base"
      data-slot="session-kanban-panel"
      data-view={viewMode()}
    >
      {renderToolbar(false)}
      <Show when={viewMode() === "board"}>{renderColumns(false)}</Show>
      <Show when={viewMode() === "list"}>{renderListView()}</Show>
      <Show when={board.error}>
        <div class="px-3 py-2 text-12-regular text-v2-text-text-muted">{board.error}</div>
      </Show>

      <Show when={fullscreen()}>
        <Portal mount={document.body}>
          <div
            class="fixed inset-0 z-[9999] flex flex-col bg-v2-background-bg-base text-v2-text-text-base shadow-2xl overflow-hidden"
            data-slot="session-kanban-fullscreen"
            data-view={viewMode()}
          >
            {renderToolbar(true)}
            <Show when={viewMode() === "board"}>{renderColumns(true)}</Show>
            <Show when={viewMode() === "list"}>{renderListView()}</Show>
            <Show when={board.error}>
              <div class="px-3 py-2 text-12-regular text-v2-text-text-muted">{board.error}</div>
            </Show>
          </div>
        </Portal>
      </Show>
    </div>
  )
}
