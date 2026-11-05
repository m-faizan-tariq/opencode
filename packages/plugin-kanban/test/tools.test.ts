import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Tool } from "@opencode/schema/tool"
import { registerTools } from "../src/tools"
import { BoardStore } from "../src/store"

interface MockTool {
  name: string
  description: string
  options?: { namespace?: string }
  execute: (input: any, context: any) => Promise<{ output?: any; content?: string }>
}

const registration = { dispose: async () => undefined }

function setup(store: BoardStore, changed: (directory: string) => void = () => undefined) {
  const tools: MockTool[] = []
  const namespaces: { name: string; description: string }[] = []
  const editor = {
    namespace: (namespace: { name: string; description: string }) => {
      namespaces.push(namespace)
    },
    add: (tool: MockTool) => {
      tools.push(tool)
    },
  }
  const ctx = {
    tool: {
      transform: (callback: (e: typeof editor) => void) => {
        callback(editor)

        return Promise.resolve(registration)
      },
    },
  }

  const result = registerTools(ctx as never, { store, changed })

  return { tools, namespaces, result }
}

const context = {
  sessionID: "ses_test",
  messageID: "msg_test",
  id: "call_1",
  agent: "build",
  signal: new AbortController().signal,
  progress: async () => undefined,
} as never

/**
 * A temp directory that looks like a project root.
 *
 * `resolvePath` walks up for `.git` and only falls back to the global `~/.opencode/kanban.json`
 * when it finds none. Without this the board lands on the user's real board file, and every
 * test that runs writes into it.
 */
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "kanban-tools-"))
  mkdirSync(join(dir, ".git"), { recursive: true })

  return dir
}

describe("kanban tools", () => {
  test("registers five tools under a declared kanban namespace", async () => {
    const { tools, namespaces, result } = setup(new BoardStore())

    expect(tools.map((tool) => tool.name).sort()).toEqual(["add", "delete", "list", "move", "update"])
    expect(tools.every((tool) => tool.options?.namespace === "kanban")).toBe(true)

    // The namespace carries a description for the model, so it must be declared, not implied.
    expect(namespaces).toHaveLength(1)
    expect(namespaces[0]?.name).toBe("kanban")
    expect(namespaces[0]?.description).toBeTruthy()

    // `index.ts` awaits this, so it has to be the host's registration handle.
    await expect(result).resolves.toBe(registration)
  })

  test("add creates a task and returns it", async () => {
    const dir = temp()

    try {
      const store = new BoardStore(() => dir)
      const announced: string[] = []
      const { tools } = setup(store, (directory) => {
        announced.push(directory)
      })
      const add = tools.find((tool) => tool.name === "add")!

      const result = await add.execute({ title: "From tool" }, context)

      // The output is the whole task under the field the design names `task`.
      expect(result.output.task.id).toMatch(/^k_/u)
      expect(result.output.task.status).toBe("todo")
      expect(store.find(dir, result.output.task.id)?.title).toBe("From tool")
      // A card the agent adds has to reach an open panel, not just the file.
      expect(announced).toEqual([dir])
      // The design's content for add is a confirmation plus the board summary.
      expect(result.content).toContain("From tool")
      expect(result.content).toContain("# Kanban board")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a read does not announce a change", async () => {
    const dir = temp()

    try {
      const store = new BoardStore(() => dir)
      store.add(dir, { title: "Quiet card" })
      const announced: string[] = []
      const { tools } = setup(store, (directory) => {
        announced.push(directory)
      })

      await tools.find((tool) => tool.name === "list")!.execute({}, context)

      expect(announced).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("move rejects an unknown id with a Tool.Error", async () => {
    const dir = temp()

    try {
      const store = new BoardStore(() => dir)
      const { tools } = setup(store)
      const move = tools.find((tool) => tool.name === "move")!

      const failure = move.execute({ id: "k_missing", status: "done" }, context)

      await expect(failure).rejects.toBeInstanceOf(Tool.Error)
      await expect(failure).rejects.toThrow(/no task with id/iu)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("list renders the board as markdown", async () => {
    const dir = temp()

    try {
      const store = new BoardStore(() => dir)
      store.add(dir, { title: "Listed card" })
      const { tools } = setup(store)
      const list = tools.find((tool) => tool.name === "list")!

      const result = await list.execute({}, context)

      // The design gives `tasks` and `markdown`; both are needed — the structured list for
      // anything that wants to act on a card, the markdown for display.
      expect(result.output.tasks).toHaveLength(1)
      expect(result.output.tasks[0]?.title).toBe("Listed card")
      expect(result.output.markdown).toContain("Listed card")
      expect(result.content).toBe(result.output.markdown)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("update changes a card", async () => {
    const dir = temp()

    try {
      const store = new BoardStore(() => dir)
      const { task } = store.add(dir, { title: "Before" })
      const { tools } = setup(store)
      const update = tools.find((tool) => tool.name === "update")!

      const result = await update.execute({ id: task.id, title: "After", priority: "high" }, context)

      expect(result.output.task.title).toBe("After")
      expect(result.content).toContain("After")
      expect(store.find(dir, task.id)?.title).toBe("After")
      expect(store.find(dir, task.id)?.priority).toBe("high")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("delete removes a card", async () => {
    const dir = temp()

    try {
      const store = new BoardStore(() => dir)
      const { task } = store.add(dir, { title: "Doomed" })
      const { tools } = setup(store)
      const del = tools.find((tool) => tool.name === "delete")!

      const result = await del.execute({ id: task.id }, context)

      expect(result.output?.id).toBe(task.id)
      expect(store.find(dir, task.id)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
