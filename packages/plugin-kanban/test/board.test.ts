import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, realpathSync, rmSync, statSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { add, move, update, remove, list, emptyBoard, load, save, resolvePath, render, type Status } from "../src/board"

describe("board operations", () => {
  test("add creates a task with defaults and a unique id", () => {
    const board = emptyBoard()
    const a = add(board, { title: "First" }).task
    const b = add(board, { title: "Second" }).task

    expect(a.status).toBe("todo")
    expect(a.priority).toBe("med")
    expect(a.source).toBe("manual")
    expect(a.id).not.toBe(b.id)
    expect(a.id).toMatch(/^k_[0-9a-f]{12}$/u)
    expect(board.tasks).toHaveLength(0)
  })

  test("add trims the title and rejects an empty one", () => {
    expect(add(emptyBoard(), { title: "  Padded  " }).task.title).toBe("Padded")
    expect(() => add(emptyBoard(), { title: "   " })).toThrow(/needs a title/iu)
  })

  test("move changes status and refreshes updatedAt", () => {
    const board = emptyBoard()
    const { board: withTask, task } = add(board, { title: "Move me" })
    const next = move(withTask, task.id, "working")

    expect(next.tasks[0]?.status).toBe("working")
    expect(next.tasks[0]?.updatedAt >= task.updatedAt).toBe(true)
    expect(withTask.tasks[0]?.status).toBe("todo")
  })

  test("move rejects an unknown status", () => {
    const { board: withTask, task } = add(emptyBoard(), { title: "Nope" })

    expect(() => move(withTask, task.id, "bogus" as Status)).toThrow(/status/iu)
  })

  test("update changes only the provided fields and ignores explicit undefined", () => {
    const { board: withTask, task } = add(emptyBoard(), { title: "Before", description: "keep" })
    const next = update(withTask, task.id, { title: "After", status: undefined })

    expect(next.tasks[0]?.title).toBe("After")
    expect(next.tasks[0]?.description).toBe("keep")
    expect(next.tasks[0]?.status).toBe("todo")
    expect(withTask.tasks[0]?.title).toBe("Before")
  })

  test("update trims the title and rejects an empty one", () => {
    const { board: withTask, task } = add(emptyBoard(), { title: "Before" })
    const next = update(withTask, task.id, { title: "  After  " })

    expect(next.tasks[0]?.title).toBe("After")
    expect(() => update(withTask, task.id, { title: "   " })).toThrow(/needs a title/iu)
  })

  test("update throws on an unknown id", () => {
    expect(() => update(emptyBoard(), "k_missing", { title: "Nope" })).toThrow(/no task with id/iu)
  })

  test("remove deletes the task and leaves the source board untouched", () => {
    const { board: withTask, task } = add(emptyBoard(), { title: "Delete me" })
    const next = remove(withTask, task.id)

    expect(next.tasks).toHaveLength(0)
    expect(withTask.tasks).toHaveLength(1)
  })

  test("remove throws on an unknown id", () => {
    expect(() => remove(emptyBoard(), "k_missing")).toThrow(/no task with id/iu)
  })

  test("list returns tasks filtered by status", () => {
    const board = emptyBoard()
    const { board: first, task: a } = add(board, { title: "A" })
    const { board: second } = add(first, { title: "B" })
    const working = move(second, a.id, "working")

    expect(list(working).map((task) => task.title)).toEqual(["A", "B"])
    expect(list(working, "working").map((task) => task.title)).toEqual(["A"])
  })
})

describe("board persistence", () => {
  test("resolvePath picks the project file inside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    mkdirSync(join(dir, ".git"), { recursive: true })
    const nested = join(dir, "a", "b")
    mkdirSync(nested, { recursive: true })

    expect(resolvePath(nested)).toBe(join(realpathSync(dir), ".opencode", "kanban.json"))
    rmSync(dir, { recursive: true, force: true })
  })

  test("resolvePath falls back to the global file outside a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    const home = mkdtempSync(join(tmpdir(), "kanban-home-"))
    const previous = process.env.HOME

    try {
      // Isolating HOME is the whole point. Computing the expected path with the same
      // `process.env.HOME || homedir()` expression the implementation uses would pass even if the
      // implementation read the wrong variable, so the temp dir is the only source of truth.
      process.env.HOME = home

      expect(resolvePath(dir)).toBe(join(home, ".opencode", "kanban.json"))
    } finally {
      if (previous === undefined) delete process.env.HOME
      else process.env.HOME = previous
      rmSync(dir, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("save then load round-trips a board", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    const path = join(dir, "kanban.json")
    const board = add(emptyBoard(), { title: "Persisted" }).board

    save(path, board)
    expect(load(path).tasks.map((task) => task.title)).toEqual(["Persisted"])
    rmSync(dir, { recursive: true, force: true })
  })

  test("load treats a missing file as an empty board", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    const path = join(dir, "kanban.json")

    expect(load(path).tasks).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })

  test("load treats a malformed file as an empty board", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    const path = join(dir, "kanban.json")
    writeFileSync(path, "{ not json", "utf8")

    expect(load(path).tasks).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })

  test("load preserves a malformed file instead of leaving it to be overwritten", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    const path = join(dir, "kanban.json")
    writeFileSync(path, "{ not json", "utf8")

    expect(load(path).tasks).toHaveLength(0)

    // The next save would otherwise replace the corrupt file, losing the only copy of the board.
    const [kept] = readdirSync(dir).filter((name) => name.startsWith("kanban.json.corrupt-"))
    expect(kept).toBeTruthy()
    expect(readFileSync(join(dir, kept!), "utf8")).toBe("{ not json")
    rmSync(dir, { recursive: true, force: true })
  })

  test("save leaves no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    const path = join(dir, "kanban.json")

    save(path, emptyBoard())
    expect(readdirSync(dir).sort()).toEqual(["kanban.json"])
    // Captured notes and descriptions are private; the board must not be world-readable.
    expect(statSync(path).mode & 0o777).toBe(0o600)
    rmSync(dir, { recursive: true, force: true })
  })

  test("render produces a markdown board with each title", () => {
    const board = add(emptyBoard(), { title: "Rendered", description: "body" }).board
    const markdown = render(board)

    expect(markdown).toContain("Rendered")
    expect(markdown).toContain("## todo")
  })

  test("load treats a well-formed file with the wrong shape as an empty board", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    const path = join(dir, "kanban.json")
    writeFileSync(path, JSON.stringify({ version: 2, tasks: [] }), "utf8")

    expect(load(path).tasks).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })

  test("load treats an empty file as an empty board", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    const path = join(dir, "kanban.json")
    writeFileSync(path, "", "utf8")

    expect(load(path).tasks).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })

  test("resolvePath finds a repo whose .git is a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere\n", "utf8")

    expect(resolvePath(dir)).toBe(join(realpathSync(dir), ".opencode", "kanban.json"))
    rmSync(dir, { recursive: true, force: true })
  })

  test("resolvePath accepts a relative directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    mkdirSync(join(dir, ".git"), { recursive: true })
    const nested = join(dir, "a", "b")
    mkdirSync(nested, { recursive: true })
    const previous = process.cwd()

    try {
      process.chdir(dir)
      expect(resolvePath("a/b")).toBe(join(realpathSync(dir), ".opencode", "kanban.json"))
    } finally {
      process.chdir(previous)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("render renders only the requested column", () => {
    const board = add(emptyBoard(), { title: "Only todo" }).board

    expect(render(board, "todo")).toContain("## todo")
    expect(render(board, "todo")).not.toContain("## done")
  })

  test("render escapes markdown and newlines in a title", () => {
    const board = add(emptyBoard(), { title: "# Not a heading\n**bold**" }).board
    const markdown = render(board)

    expect(markdown).not.toContain("\n# Not a heading")
    expect(markdown).toContain("\\# Not a heading")
  })

  test("load drops invalid task entries instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    const path = join(dir, "kanban.json")
    writeFileSync(path, JSON.stringify({ version: 1, tasks: [null, { id: "k_x" }] }), "utf8")

    expect(load(path).tasks).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })

  test("load drops a task whose optional result is the wrong type", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-"))
    const path = join(dir, "kanban.json")
    const valid = add(emptyBoard(), { title: "Valid" }).task
    writeFileSync(path, JSON.stringify({ version: 1, tasks: [{ ...valid, result: 42 }] }), "utf8")

    const board = load(path)
    expect(board.tasks).toHaveLength(0)
    expect(() => render(board)).not.toThrow()
    rmSync(dir, { recursive: true, force: true })
  })
})
