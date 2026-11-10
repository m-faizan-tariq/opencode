import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Schema } from "effect"
import { Priority, Source, Status, Task } from "./rpc"

export { Priority, Source, Status, Task }

export const Board = Schema.Struct({
  version: Schema.Literal(1),
  tasks: Schema.Array(Task),
})
export type Board = Readonly<typeof Board.Type>

export const COLUMNS = ["backlog", "todo", "working", "review", "done"] as const

export type NewTask = {
  readonly title: string
  readonly description?: string
  readonly status?: Status
  readonly priority?: Priority
  readonly source?: Source
  readonly sessionID?: string
  readonly result?: string
  readonly telegramChatID?: string
}

export type TaskUpdate = Partial<NewTask>

export function emptyBoard(): Board {
  return { version: 1, tasks: [] }
}

function randomId(): string {
  return `k_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
}

type MutablePartial<T> = { -readonly [K in keyof T]?: T[K] }

function defined<T extends Record<string, unknown>>(patch: T): MutablePartial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value
  }
  return out as MutablePartial<T>
}

export function add(board: Board, input: NewTask): { board: Board; task: Task } {
  const title = input.title.trim()

  if (!title) throw new Error("kanban: a task needs a title")

  const now = new Date().toISOString()
  const task: Task = {
    id: randomId(),
    title,
    description: input.description ?? "",
    status: input.status ?? "todo",
    priority: input.priority ?? "med",
    source: input.source ?? "manual",
    ...(input.sessionID !== undefined ? { sessionID: input.sessionID } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.telegramChatID !== undefined ? { telegramChatID: input.telegramChatID } : {}),
    createdAt: now,
    updatedAt: now,
  }
  return { board: { ...board, tasks: [...board.tasks, task] }, task }
}

export function move(board: Board, id: string, status: Status): Board {
  return update(board, id, { status })
}

export function update(board: Board, id: string, patch: TaskUpdate): Board {
  const index = board.tasks.findIndex((task) => task.id === id)

  if (index < 0) throw new Error(`kanban: no task with id ${id}`)

  const current = board.tasks[index]
  const next = defined(patch)

  if (next.title !== undefined) {
    const title = next.title.trim()

    if (!title) throw new Error("kanban: a task needs a title")

    next.title = title
  }

  if (next.status && !(COLUMNS as readonly string[]).includes(next.status)) {
    throw new Error(`kanban: invalid status ${next.status}; expected one of ${COLUMNS.join(", ")}`)
  }

  const tasks = board.tasks.slice()
  tasks[index] = { ...current, ...next, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() }

  return { ...board, tasks }
}

export function remove(board: Board, id: string): Board {
  if (!board.tasks.some((task) => task.id === id)) throw new Error(`kanban: no task with id ${id}`)

  return { ...board, tasks: board.tasks.filter((task) => task.id !== id) }
}

export function list(board: Board, status?: Status): Task[] {
  if (!status) return board.tasks.slice()
  return board.tasks.filter((task) => task.status === status)
}

export function find(board: Board, id: string): Task | undefined {
  return board.tasks.find((task) => task.id === id)
}

export function resolvePath(directory: string): string {
  let current: string

  try {
    current = realpathSync(resolve(directory))
  } catch {
    current = resolve(directory)
  }

  while (true) {
    if (existsSync(join(current, ".git"))) return join(current, ".opencode", "kanban.json")
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  // Prefer $HOME over os.homedir(): Bun's homedir() reads the passwd database and
  // ignores a runtime HOME override, while Node honours it. Respecting HOME keeps the
  // global fallback consistent across runtimes and lets tests isolate it. `||` rather
  // than `??` so an empty HOME does not resolve to a relative path in the CWD.
  return join(process.env.HOME || homedir(), ".opencode", "kanban.json")
}

export function load(path: string): Board {
  if (!existsSync(path)) return emptyBoard()

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Board>

    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) throw new Error("unrecognised board shape")

    const tasks = parsed.tasks.filter(isTask)

    if (tasks.length !== parsed.tasks.length) {
      console.error(`[kanban] ${path} contained ${parsed.tasks.length - tasks.length} invalid task(s); they were skipped`)
    }

    return { version: 1, tasks }
  } catch (error) {
    console.error(`[kanban] could not read ${path}; starting from an empty board`, error)

    // The design says a malformed file yields an empty board rather than throwing into the agent
    // loop. That is only safe if the bad file cannot then be silently overwritten by the next
    // save, so it is moved aside first: a corrupt board the user can recover is better than one
    // that vanishes.
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`)
    } catch {
      // Unreadable *and* unrenamable. The next save will overwrite it, and throwing into the
      // caller is the one thing the design forbids.
    }

    return emptyBoard()
  }
}

export function save(path: string, board: Board): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`

  try {
    writeFileSync(tmp, JSON.stringify(board), { encoding: "utf8", mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // The temp file is already gone or unwritable; the original error matters more.
    }
    throw error
  }
}

const PRIORITIES = ["low", "med", "high"] as const
const SOURCES = ["telegram", "note", "manual"] as const

function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false
  const task = value as Record<string, unknown>

  return (
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.description === "string" &&
    typeof task.status === "string" &&
    (COLUMNS as readonly string[]).includes(task.status) &&
    typeof task.priority === "string" &&
    (PRIORITIES as readonly string[]).includes(task.priority) &&
    typeof task.source === "string" &&
    (SOURCES as readonly string[]).includes(task.source) &&
    typeof task.createdAt === "string" &&
    typeof task.updatedAt === "string" &&
    (task.result === undefined || typeof task.result === "string") &&
    (task.sessionID === undefined || typeof task.sessionID === "string") &&
    (task.telegramChatID === undefined || typeof task.telegramChatID === "string")
  )
}

function line(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\n", " ")
    .replace(/[<\\`*[\]()#+\-.!>]/gu, "\\$&")
}

export function render(board: Board, status?: Status): string {
  const columns = status ? [status] : COLUMNS
  const lines: string[] = ["# Kanban board", ""]

  for (const column of columns) {
    lines.push(`## ${column}`)
    lines.push("")

    for (const task of board.tasks.filter((item) => item.status === column)) {
      lines.push(`- **${line(task.title)}** \`${task.id}\` · ${task.priority} · ${task.updatedAt}`)
      if (task.description) lines.push(`  ${line(task.description)}`)
      if (column === "review" && task.result) lines.push(`  > ${line(task.result.split(/\r?\n/u)[0]!)}`)
    }

    lines.push("")
  }

  return lines.join("\n").trimEnd() + "\n"
}
