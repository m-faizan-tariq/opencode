import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addRpcTask, parseWorkerModel, type AddRpcDeps } from "../src/index"
import { BoardStore } from "../src/store"
import { workerPrompt } from "../src/worker"

/**
 * `KANBAN_WORKER_MODEL` is parsed here rather than in `setup`, because the rule is the design's
 * ("split on the first `/`") and a `split("/", 2)` would truncate a model id that contains a
 * slash — a real shape, e.g. `openrouter/anthropic/claude-sonnet-4-5`.
 */
describe("parseWorkerModel", () => {
  test("splits on the first slash", () => {
    expect(parseWorkerModel("anthropic/claude-sonnet-4-5")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
    })
  })

  test("keeps a slash inside the model id", () => {
    // The reason this is a function and not `split("/", 2)`: the id is `anthropic/claude-sonnet-4-5`,
    // not `anthropic`.
    expect(parseWorkerModel("openrouter/anthropic/claude-sonnet-4-5")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude-sonnet-4-5",
    })
  })

  test("tolerates surrounding whitespace-free values", () => {
    expect(parseWorkerModel("a/b/c/d")).toEqual({ providerID: "a", id: "b/c/d" })
  })

  test("falls back to the session default when unset", () => {
    expect(parseWorkerModel(undefined)).toBeUndefined()
  })

  test("falls back when there is no slash", () => {
    // `split("/", 2)` would have produced `{ providerID: "anthropic", id: undefined }`, which
    // fails `session.create` validation and rolls the capture back.
    expect(parseWorkerModel("anthropic")).toBeUndefined()
  })

  test("falls back when either side of the slash is empty", () => {
    expect(parseWorkerModel("/model")).toBeUndefined()
    expect(parseWorkerModel("provider/")).toBeUndefined()
    expect(parseWorkerModel("/")).toBeUndefined()
  })
})

interface AddHarnessOptions {
  readonly createThrows?: boolean
  readonly promptThrows?: boolean
  readonly getThrows?: boolean
  readonly caller?: { agent?: string; model?: { providerID: string; id: string } }
  readonly linkedTokens?: number
}

/**
 * A temp directory that looks like a project root, plus a stub session that records every call.
 *
 * `resolvePath` walks up for `.git` and only falls back to the global `~/.opencode/kanban.json`
 * when it finds none, so without this the board lands on the user's real board file.
 */
function addHarness(options: AddHarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kanban-add-"))
  mkdirSync(join(dir, ".git"), { recursive: true })

  const created: {
    agent?: string
    model?: { providerID: string; id: string }
    title?: string
    location?: { directory: string }
  }[] = []
  const prompted: { sessionID: string; text: string }[] = []
  const removed: string[] = []
  const announced: string[] = []

  const deps: AddRpcDeps = {
    store: new BoardStore(),
    directory: dir,
    session: {
      get: async (input: { sessionID: string }) => {
        if (options.getThrows) throw new Error("get failed")
        if (input.sessionID === "ses_linked") return { tokens: { input: options.linkedTokens } }
        return options.caller ?? {}
      },
      create: async (input: {
        agent?: string
        model?: { providerID: string; id: string }
        title?: string
        location?: { directory: string }
      }) => {
        if (options.createThrows) throw new Error("create failed")
        created.push(input)
        return { id: "ses_worker" }
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        if (options.promptThrows) throw new Error("prompt failed")
        prompted.push(input)
      },
      remove: async (input: { sessionID: string }) => {
        removed.push(input.sessionID)
      },
    },
    changed: (directory) => void announced.push(directory),
  }

  return { dir, deps, created, prompted, removed, announced }
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

describe("addRpcTask", () => {
  test("default add starts in working with a linked, prompted worker session", async () => {
    const { dir, deps, created, prompted, announced } = addHarness({
      caller: { agent: "build", model: { providerID: "anthropic", id: "claude" } },
    })

    try {
      const task = await addRpcTask(deps, {
        sessionID: "ses_caller",
        title: "Write the report",
        description: "with sources",
      })

      expect(task.status).toBe("working")
      expect(task.sessionID).toBe("ses_worker")
      expect(created).toHaveLength(1)
      expect(created[0]?.agent).toBe("build")
      expect(created[0]?.model).toEqual({ providerID: "anthropic", id: "claude" })
      expect(created[0]?.title).toBe("Write the report")
      expect(created[0]?.location).toEqual({ directory: dir })
      expect(prompted).toEqual([{ sessionID: "ses_worker", text: workerPrompt("Write the report\n\nwith sources") }])
      expect(announced).toEqual([dir])
      expect(deps.store.find(dir, task.id)?.status).toBe("working")
      expect(deps.store.find(dir, task.id)?.sessionID).toBe("ses_worker")
    } finally {
      cleanup(dir)
    }
  })

  test("a blank title throws before a session is created", async () => {
    const { dir, deps, created, prompted } = addHarness()

    try {
      await expect(addRpcTask(deps, { sessionID: "ses_caller", title: "   " })).rejects.toThrow(/title/iu)
      expect(created).toEqual([])
      expect(prompted).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  test("rolls the card back when the worker session cannot be created", async () => {
    const { dir, deps, removed, announced } = addHarness({ createThrows: true })

    try {
      await expect(addRpcTask(deps, { sessionID: "ses_caller", title: "Doomed" })).rejects.toThrow(/create failed/iu)
      expect(deps.store.tasks(dir)).toHaveLength(0)
      expect(removed).toEqual([])
      expect(announced).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  test("rolls the card and worker session back when the prompt fails", async () => {
    const { dir, deps, removed, announced } = addHarness({ promptThrows: true })

    try {
      await expect(addRpcTask(deps, { sessionID: "ses_caller", title: "Doomed" })).rejects.toThrow(/prompt failed/iu)
      expect(deps.store.tasks(dir)).toHaveLength(0)
      expect(removed).toEqual(["ses_worker"])
      expect(announced).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  test("an explicit non-working status creates the card without a session", async () => {
    for (const status of ["todo", "backlog"] as const) {
      const { dir, deps, created, prompted, announced } = addHarness()

      try {
        const task = await addRpcTask(deps, { sessionID: "ses_caller", title: "Later", status })

        expect(task.status).toBe(status)
        expect(task.sessionID).toBeUndefined()
        expect(created).toEqual([])
        expect(prompted).toEqual([])
        expect(announced).toEqual([dir])
      } finally {
        cleanup(dir)
      }
    }
  })

  test("a linked card keeps a non-working status without creating or prompting", async () => {
    const { dir, deps, created, prompted, announced } = addHarness()

    try {
      const task = await addRpcTask(deps, {
        sessionID: "ses_caller",
        title: "Linked",
        status: "todo",
        linkSessionID: "ses_linked",
      })

      expect(task.status).toBe("todo")
      expect(task.sessionID).toBe("ses_linked")
      expect(created).toEqual([])
      expect(prompted).toEqual([])
      expect(announced).toEqual([dir])
    } finally {
      cleanup(dir)
    }
  })

  test("a linked working card prompts a session that has not run yet", async () => {
    const { dir, deps, prompted } = addHarness({ linkedTokens: 0 })

    try {
      const task = await addRpcTask(deps, {
        sessionID: "ses_caller",
        title: "Linked",
        description: "body",
        status: "working",
        linkSessionID: "ses_linked",
      })

      expect(task.status).toBe("working")
      expect(prompted).toEqual([{ sessionID: "ses_linked", text: workerPrompt("Linked\n\nbody") }])
    } finally {
      cleanup(dir)
    }
  })

  test("a linked working card leaves a session with history alone", async () => {
    const { dir, deps, prompted } = addHarness({ linkedTokens: 1234 })

    try {
      const task = await addRpcTask(deps, {
        sessionID: "ses_caller",
        title: "Linked",
        status: "working",
        linkSessionID: "ses_linked",
      })

      expect(task.status).toBe("working")
      expect(prompted).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  test("a linked working card survives a session lookup failure", async () => {
    const { dir, deps, prompted, announced } = addHarness({ getThrows: true })

    try {
      const task = await addRpcTask(deps, {
        sessionID: "ses_caller",
        title: "Linked",
        status: "working",
        linkSessionID: "ses_linked",
      })

      expect(task.status).toBe("working")
      expect(task.sessionID).toBe("ses_linked")
      expect(prompted).toEqual([])
      expect(announced).toEqual([dir])
    } finally {
      cleanup(dir)
    }
  })
})
