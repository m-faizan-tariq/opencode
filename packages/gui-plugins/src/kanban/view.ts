import type { Task } from "@opencode/plugin-kanban/rpc"

/** The panel's two layouts. */
export type ViewMode = "board" | "list"

/** How the list groups tasks. */
export type ListGroup = "sections" | "flat"

/** How the list orders tasks. */
export type ListSort = "default" | "updated" | "priority"

/** The board columns, in order. */
export const COLUMNS = ["backlog", "todo", "working", "review", "done"] as const

export type Column = (typeof COLUMNS)[number]

const VIEW_STORAGE_KEY = "opencode.kanban.view"

const GROUP_STORAGE_KEY = "opencode.kanban.listGroup"

const SORT_STORAGE_KEY = "opencode.kanban.listSort"

const PRIORITY_RANK: Record<Task["priority"], number> = { high: 0, med: 1, low: 2 }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const

/**
 * The browser's storage, or undefined where it is absent or blocked (SSR, a restrictive sandbox).
 * Every read and write is guarded so the panel still renders.
 */
function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** The stored view mode, defaulting to the board so the default layout is unchanged. */
export function readStoredView(target: Storage | undefined = storage()): ViewMode {
  try {
    return target?.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "board"
  } catch {
    return "board"
  }
}

/** Persists the view mode. A storage failure is silent: the panel still switches. */
export function writeStoredView(mode: ViewMode, target: Storage | undefined = storage()): void {
  try {
    target?.setItem(VIEW_STORAGE_KEY, mode)
  } catch {
    // Storage is unavailable; the choice simply does not persist.
  }
}

/** The stored grouping, defaulting to status sections. */
export function readStoredListGroup(target: Storage | undefined = storage()): ListGroup {
  try {
    return target?.getItem(GROUP_STORAGE_KEY) === "flat" ? "flat" : "sections"
  } catch {
    return "sections"
  }
}

/** Persists the grouping. */
export function writeStoredListGroup(group: ListGroup, target: Storage | undefined = storage()): void {
  try {
    target?.setItem(GROUP_STORAGE_KEY, group)
  } catch {
    // Storage is unavailable; the choice simply does not persist.
  }
}

/** The stored sort, defaulting to board order. */
export function readStoredListSort(target: Storage | undefined = storage()): ListSort {
  try {
    const value = target?.getItem(SORT_STORAGE_KEY)

    return value === "updated" || value === "priority" ? value : "default"
  } catch {
    return "default"
  }
}

/** Persists the sort. */
export function writeStoredListSort(sort: ListSort, target: Storage | undefined = storage()): void {
  try {
    target?.setItem(SORT_STORAGE_KEY, sort)
  } catch {
    // Storage is unavailable; the choice simply does not persist.
  }
}

/**
 * Keeps the tasks whose title, description, result, status, priority or source contains the query,
 * case-insensitively. An empty query keeps every task.
 */
export function filterTasks(tasks: readonly Task[], query: string): readonly Task[] {
  const needle = query.trim().toLowerCase()

  if (!needle) return tasks

  return tasks.filter(
    (task) =>
      task.title.toLowerCase().includes(needle) ||
      task.description.toLowerCase().includes(needle) ||
      (task.result?.toLowerCase().includes(needle) ?? false) ||
      task.status.includes(needle) ||
      task.priority.includes(needle) ||
      task.source.includes(needle),
  )
}

/**
 * Orders tasks for the list. `default` keeps the board's order; `updated` is newest first;
 * `priority` is high → low, stable within a priority.
 */
export function sortTasks(tasks: readonly Task[], sort: ListSort): readonly Task[] {
  if (sort === "updated") return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  if (sort === "priority") return [...tasks].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])

  return tasks
}

/**
 * A section's expanded state: the user's explicit toggle wins; otherwise a non-empty section
 * starts expanded, so a status with no tasks is one slim bar instead of a blank block.
 */
export function sectionExpanded(explicit: boolean | undefined, count: number): boolean {
  return explicit ?? count > 0
}

/** A section's collapsed state: the inverse of `sectionExpanded`. */
export function sectionCollapsed(explicit: boolean | undefined, count: number): boolean {
  return !sectionExpanded(explicit, count)
}

const pad = (value: number) => String(value).padStart(2, "0")

/**
 * A short date/time for a task row: the time alone when it is today, else `Mon D, HH:MM`.
 * An unparseable timestamp renders as an empty string rather than "Invalid Date".
 */
export function formatTaskDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) return ""

  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`

  if (date.toDateString() === now.toDateString()) return time

  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${time}`
}

/** What `handleDropOnColumn` needs to resolve a drop onto one status. */
export interface DropColumnInput {
  readonly tasks: readonly Task[]
  readonly draggedId: string | undefined
  readonly untitled: string
  readonly move: (id: string, status: Column) => void
  readonly addSession: (input: { sessionID: string; title: string; status: Column }) => void
  readonly endDrag: () => void
}

/**
 * Resolves a drop onto a status, whether it carries an OpenCode session tab or a task row.
 *
 * Shared by the board columns and the list sections so both accept the same payloads: a session
 * tab becomes a new card linked to that session (or moves the card already linked to it), and a
 * task row moves that task.
 */
export function handleDropOnColumn(event: DragEvent, column: Column, input: DropColumnInput): void {
  event.preventDefault()

  const dragged = input.draggedId

  input.endDrag()

  const sessionPayload = event.dataTransfer?.getData("application/x-opencode-session")

  if (sessionPayload) {
    try {
      // SAFETY: the payload is parsed as JSON and the fields are checked below.
      const parsed = JSON.parse(sessionPayload) as { sessionID?: string; title?: string }
      const sessionID = parsed.sessionID

      if (sessionID) {
        const title = parsed.title || input.untitled
        const existing = input.tasks.find((task) => task.sessionID === sessionID)

        if (existing) input.move(existing.id, column)
        else input.addSession({ sessionID, title, status: column })

        return
      }
    } catch {
      // Malformed payload: fall through to the task-move handling below.
    }
  }

  const plain = event.dataTransfer?.getData("text/plain") || dragged

  if (plain?.startsWith("ses_")) {
    const existing = input.tasks.find((task) => task.sessionID === plain)

    if (existing) input.move(existing.id, column)
    else input.addSession({ sessionID: plain, title: input.untitled, status: column })

    return
  }

  if (plain) input.move(plain, column)
}
