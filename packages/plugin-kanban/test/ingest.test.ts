import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ingest, parseNote } from "../src/ingest"
import { onPrompt } from "../src/events"
import { BoardStore } from "../src/store"

interface HarnessOptions {
  readonly createThrows?: boolean
  readonly promptThrows?: boolean
  readonly agent?: string
  readonly model?: { providerID: string; id: string }
}

/**
 * A temp directory that looks like a project root. `resolvePath` walks up for `.git` and
 * only falls back to the global `~/.opencode/kanban.json` when it finds none, so without
 * this the board lands on the user's real board file.
 */
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "kanban-ingest-"))
  mkdirSync(join(dir, ".git"), { recursive: true })

  return dir
}

function harness(options: HarnessOptions = {}) {
  const dir = temp()
  const created: {
    agent?: string
    model?: { providerID: string; id: string }
    title?: string
    location?: { directory: string }
  }[] = []
  const prompted: { sessionID: string; text: string }[] = []
  const removed: string[] = []

  const deps = {
    store: new BoardStore(),
    directory: dir,
    session: {
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
    agent: options.agent,
    model: options.model,
  }

  return { dir, created, prompted, removed, deps }
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

describe("parseNote", () => {
  test("splits the first line into the title", () => {
    expect(parseNote("Buy milk\nfrom the corner shop")).toEqual({
      title: "Buy milk",
      description: "from the corner shop",
    })
  })

  test("trims the description and drops trailing blank lines", () => {
    expect(parseNote("Buy milk\n\n  from the shop  \n\n")).toEqual({
      title: "Buy milk",
      description: "from the shop",
    })
  })

  test("treats a blank first line as no title", () => {
    expect(parseNote("\n\nBuy milk\nfrom the shop")).toEqual({
      title: "Buy milk",
      description: "from the shop",
    })
  })

  test("normalizes CRLF", () => {
    expect(parseNote("Buy milk\r\nfrom the shop\r\n")).toEqual({
      title: "Buy milk",
      description: "from the shop",
    })
  })

  test("names an empty note", () => {
    expect(parseNote("")).toEqual({ title: "Untitled", description: "" })
    expect(parseNote("   \n\n")).toEqual({ title: "Untitled", description: "" })
  })

  test("truncates a very long title", () => {
    expect(parseNote("x".repeat(500)).title).toHaveLength(200)
  })
})

describe("ingest", () => {
  test("creates a card, a session, links them, and starts the run", async () => {
    const { dir, created, prompted, deps } = harness()

    try {
      const task = await ingest(deps, {
        text: "Research standing desks\ncompare three models\nbudget under 800",
        source: "telegram",
      })

      // `todo` is the state `ingest` itself produces. It is not the state a captured card rests
      // in: `ingest` prompts the worker session, and the prompt hook moves a linked card to
      // `working` — see "capture's card reaches working through the prompt hook" below. The
      // harness stubs `session.prompt`, so the hook never runs here, which is exactly why this
      // unit test can assert the creation state.
      expect(task.status).toBe("todo")
      expect(task.source).toBe("telegram")
      expect(task.sessionID).toBe("ses_worker")
      expect(created[0]?.title).toBe("Research standing desks")
      expect(prompted[0]?.sessionID).toBe("ses_worker")

      // The prompt carries the whole note, not just the title the card was given.
      expect(prompted[0]?.text).toContain("Research standing desks")
      expect(prompted[0]?.text).toContain("compare three models")
      expect(prompted[0]?.text).toContain("budget under 800")
    } finally {
      cleanup(dir)
    }
  })

  test("persists the link and the description to the board on disk", async () => {
    const { dir, deps } = harness()

    try {
      const task = await ingest(deps, { text: "Linked\nwith a body", source: "note" })

      expect(task.title).toBe("Linked")
      expect(task.description).toBe("with a body")
      expect(deps.store.find(dir, task.id)?.sessionID).toBe("ses_worker")
      expect(deps.store.find(dir, task.id)?.description).toBe("with a body")
      expect(deps.store.tasks(dir)).toHaveLength(1)
    } finally {
      cleanup(dir)
    }
  })

  test("passes the worker agent and model through", async () => {
    const { dir, created, deps } = harness({ agent: "build", model: { providerID: "anthropic", id: "claude" } })

    try {
      await ingest(deps, { text: "Configured", source: "note" })

      expect(created[0]?.agent).toBe("build")
      expect(created[0]?.model).toEqual({ providerID: "anthropic", id: "claude" })
    } finally {
      cleanup(dir)
    }
  })

  test("opens the worker session in the project the card lives on", async () => {
    const { dir, created, deps } = harness()

    try {
      await ingest(deps, { text: "In the project", source: "note" })

      // `session.create` without `location` falls back to the server's `process.cwd()`, and the
      // board is resolved from the worker session's own directory — so a worker opened anywhere
      // else would never be matched to its card and the card would never reach `review`.
      expect(created[0]?.location).toEqual({ directory: dir })
    } finally {
      cleanup(dir)
    }
  })

  test("capture's card reaches working through the prompt hook", async () => {
    const { dir, deps } = harness()

    try {
      const task = await ingest(deps, { text: "Write the report", source: "note" })

      // The two halves of the capture pipeline are tested separately, so they are composed
      // here: `ingest` creates the card and starts the run, and the prompt hook — which the
      // real server fires for that prompt (`packages/core/src/session/prompt.ts:40`) — moves
      // the linked card to `working`. This is the state a captured card actually rests in while
      // the agent runs, and it is what the board has to show.
      expect(task.status).toBe("todo")
      expect(onPrompt(deps.store, dir, task.sessionID!)).toBeDefined()
      expect(deps.store.find(dir, task.id)?.status).toBe("working")
    } finally {
      cleanup(dir)
    }
  })

  test("rolls the card back when the session cannot be created", async () => {
    const { dir, deps } = harness({ createThrows: true })

    try {
      await expect(ingest(deps, { text: "Doomed", source: "note" })).rejects.toThrow(/create failed/iu)
      expect(deps.store.tasks(dir)).toHaveLength(0)
    } finally {
      cleanup(dir)
    }
  })

  test("rolls the card back when the run cannot be started", async () => {
    const { dir, deps } = harness({ promptThrows: true })

    try {
      await expect(ingest(deps, { text: "Doomed", source: "note" })).rejects.toThrow(/prompt failed/iu)
      expect(deps.store.tasks(dir)).toHaveLength(0)
    } finally {
      cleanup(dir)
    }
  })

  test("removes the orphaned worker session when the run cannot be started", async () => {
    const { dir, removed, deps } = harness({ promptThrows: true })

    try {
      // Capture is all-or-nothing: a session that was created and never prompted is a session
      // with no card behind it, and the user has no way to open it from the board. Leaving it
      // behind would strand it.
      await expect(ingest(deps, { text: "Doomed", source: "note" })).rejects.toThrow(/prompt failed/iu)
      expect(removed).toEqual(["ses_worker"])
    } finally {
      cleanup(dir)
    }
  })

  test("announces a board change only when the capture succeeds", async () => {
    const { dir, deps } = harness()
    const announced: string[] = []

    try {
      await ingest({ ...deps, changed: (directory) => void announced.push(directory) }, { text: "Announce me", source: "note" })
      expect(announced).toEqual([dir])

      const failed = harness({ promptThrows: true })

      try {
        await expect(
          ingest(
            { ...failed.deps, changed: (directory) => void announced.push(directory) },
            { text: "Doomed", source: "note" },
          ),
        ).rejects.toThrow(/prompt failed/iu)
        expect(announced).toEqual([dir])
      } finally {
        cleanup(failed.dir)
      }
    } finally {
      cleanup(dir)
    }
  })

  test("leaves no session to clean up when the session cannot be created", async () => {
    const { dir, removed, deps } = harness({ createThrows: true })

    try {
      // The failure happens before a session exists, so there is nothing to remove — and a
      // spurious `remove` call would be a lie the tests would have to encode.
      await expect(ingest(deps, { text: "Doomed", source: "note" })).rejects.toThrow(/create failed/iu)
      expect(removed).toEqual([])
    } finally {
      cleanup(dir)
    }
  })
})
