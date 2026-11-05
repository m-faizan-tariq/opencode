import { existsSync, statSync } from "node:fs"
import { add, find, list, load, move, remove, render, resolvePath, save, update } from "./board"
import type { Board, NewTask, Status, Task, TaskUpdate } from "./board"

/**
 * Process-wide board cache keyed by resolved `kanban.json` path.
 *
 * `PluginHost` runs `Plugin.setup(ctx)` once per `Location` (directory), which constructs one
 * `BoardStore` per location. Sharing the cache across instances (and validating against the
 * file's `mtimeMs`) ensures that a write from `/note`, a session hook, or `handleEvent` in a
 * session location is immediately visible to `KanbanRpc` calls routed to the default location,
 * and vice versa.
 */
const boards = new Map<string, { mtimeMs: number; board: Board }>()

function currentMtime(path: string): number {
  try {
    return existsSync(path) ? statSync(path).mtimeMs : -1
  } catch {
    return -1
  }
}

/**
 * Maps a session to the project directory its board lives in. The plugin's own
 * `ctx.location` is the server's boot directory, not the project the user is working in,
 * so every board operation resolves the directory from the session instead.
 */
export type Directory = (sessionID: string) => Promise<string> | string

export class BoardStore {
  /**
   * The default resolver is the identity, so a `BoardStore` built without one treats the
   * session id as a path. That is only correct for tests, which pass a session id that is
   * already a directory; production code always supplies a real resolver.
   */
  constructor(private readonly resolve: Directory = (sessionID) => sessionID) {}

  /** The project directory a session's board lives in. */
  directory(sessionID: string): Promise<string> {
    return Promise.resolve(this.resolve(sessionID))
  }

  path(directory: string): string {
    return resolvePath(directory)
  }

  board(directory: string): Board {
    const path = resolvePath(directory)
    const cached = boards.get(path)
    const mtimeMs = currentMtime(path)

    if (cached && cached.mtimeMs === mtimeMs) return cached.board

    return this.reload(directory)
  }

  reload(directory: string): Board {
    const path = resolvePath(directory)
    const board = load(path)
    boards.set(path, { mtimeMs: currentMtime(path), board })

    return board
  }

  private write(directory: string, board: Board): Board {
    const path = resolvePath(directory)
    save(path, board)
    boards.set(path, { mtimeMs: currentMtime(path), board })

    return board
  }

  add(directory: string, input: NewTask): { board: Board; task: Task } {
    const result = add(this.board(directory), input)

    return { board: this.write(directory, result.board), task: result.task }
  }

  move(directory: string, id: string, status: Status): Board {
    return this.write(directory, move(this.board(directory), id, status))
  }

  update(directory: string, id: string, patch: TaskUpdate): Board {
    return this.write(directory, update(this.board(directory), id, patch))
  }

  remove(directory: string, id: string): Board {
    return this.write(directory, remove(this.board(directory), id))
  }

  list(directory: string, status?: Status): Task[] {
    return list(this.board(directory), status)
  }

  find(directory: string, id: string): Task | undefined {
    return find(this.board(directory), id)
  }

  render(directory: string, status?: Status): string {
    return render(this.board(directory), status)
  }

  tasks(directory: string): Task[] {
    return this.board(directory).tasks.slice()
  }
}
