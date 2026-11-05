import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { load } from "../src/board"
import { BoardStore } from "../src/store"

function repo(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `kanban-${name}-`))
  mkdirSync(join(dir, ".git"), { recursive: true })

  return dir
}

describe("BoardStore", () => {
  test("keeps one board per project root", () => {
    const first = repo("first")
    const second = repo("second")

    try {
      const store = new BoardStore()
      const nested = join(first, "nested")
      mkdirSync(nested, { recursive: true })
      const a = store.board(first)
      const b = store.board(nested)
      const c = store.board(second)

      expect(a).toBe(b)
      expect(a).not.toBe(c)
    } finally {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  })

  test("saves a mutation back to the project file", () => {
    const dir = repo("save")

    try {
      const store = new BoardStore()
      const { board, task } = store.add(dir, { title: "Stored" })

      expect(board.tasks[0]?.title).toBe("Stored")
      expect(store.board(dir).tasks[0]?.title).toBe("Stored")
      expect(task.status).toBe("todo")

      // The cache alone could satisfy the assertions above; read the file back instead.
      expect(load(join(dir, ".opencode", "kanban.json")).tasks.map((item) => item.title)).toEqual(["Stored"])

      // A second store for the same project must see the same board.
      expect(new BoardStore().board(dir).tasks[0]?.title).toBe("Stored")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("synchronizes writes across multiple already-cached BoardStore instances (multi-Location coherence)", () => {
    const dir = repo("multi-location")

    try {
      const defaultLocationStore = new BoardStore()
      const sessionLocationStore = new BoardStore()

      // Both stores load and cache the initial board before any mutation occurs.
      expect(defaultLocationStore.tasks(dir)).toEqual([])
      expect(sessionLocationStore.tasks(dir)).toEqual([])

      // Session location adds a card (e.g. via /note) and transitions it to working -> review.
      const { task } = sessionLocationStore.add(dir, { title: "Cross-location task", source: "note" })
      expect(defaultLocationStore.find(dir, task.id)?.status).toBe("todo")

      sessionLocationStore.move(dir, task.id, "working")
      expect(defaultLocationStore.find(dir, task.id)?.status).toBe("working")

      sessionLocationStore.update(dir, task.id, { status: "review", result: "Completed in session location" })
      expect(defaultLocationStore.find(dir, task.id)?.status).toBe("review")
      expect(defaultLocationStore.find(dir, task.id)?.result).toBe("Completed in session location")

      // Default location (GUI RPC) moves the card to done; session location immediately sees done.
      defaultLocationStore.move(dir, task.id, "done")
      expect(sessionLocationStore.find(dir, task.id)?.status).toBe("done")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("persists move, update, and remove", () => {
    const dir = repo("mutations")

    try {
      const store = new BoardStore()
      const { task } = store.add(dir, { title: "Mutate me" })

      store.move(dir, task.id, "working")
      store.update(dir, task.id, { priority: "high" })

      const onDisk = load(join(dir, ".opencode", "kanban.json")).tasks[0]
      expect(onDisk?.status).toBe("working")
      expect(onDisk?.priority).toBe("high")

      store.remove(dir, task.id)
      expect(load(join(dir, ".opencode", "kanban.json")).tasks).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("tasks returns a copy that cannot corrupt the store", () => {
    const dir = repo("copy")

    try {
      const store = new BoardStore()
      store.add(dir, { title: "Original" })

      const copy = store.tasks(dir)
      copy.push({ ...copy[0]!, id: "k_injected", title: "Injected" })

      expect(store.tasks(dir).map((task) => task.title)).toEqual(["Original"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls back to the global board outside a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-global-"))
    const home = mkdtempSync(join(tmpdir(), "kanban-home-"))
    const previous = process.env.HOME

    try {
      process.env.HOME = home
      const store = new BoardStore()
      const { board } = store.add(dir, { title: "Global" })

      expect(board.tasks[0]?.title).toBe("Global")
      expect(load(join(home, ".opencode", "kanban.json")).tasks[0]?.title).toBe("Global")
    } finally {
      if (previous === undefined) delete process.env.HOME
      else process.env.HOME = previous
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
