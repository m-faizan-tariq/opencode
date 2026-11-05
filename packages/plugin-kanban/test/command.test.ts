import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { registerCommands } from "../src/command"
import { BoardStore } from "../src/store"

interface CapturedCommand {
  name: string
  description?: string
  execute: (invocation: any) => Promise<void>
}

interface Synthetic {
  sessionID: string
  text: string
  description?: string
  resume?: boolean
}

interface Prompt {
  sessionID: string
  text: string
  delivery?: string
}

/**
 * A temp directory that looks like a project root.
 *
 * `resolvePath` walks up for `.git` and only falls back to the global `~/.opencode/kanban.json`
 * when it finds none. Without this the capture lands on the user's real board file.
 */
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "kanban-command-"))
  mkdirSync(join(dir, ".git"), { recursive: true })

  return dir
}

function harness(options: { readonly promptThrows?: boolean; readonly removeThrows?: boolean } = {}) {
  const dir = temp()
  const store = new BoardStore(() => dir)
  const commands: CapturedCommand[] = []
  const synthetic: Synthetic[] = []
  const prompts: Prompt[] = []
  const created: { agent?: string; title?: string; location?: { directory: string } }[] = []
  const removed: string[] = []
  const logged: string[] = []
  const announced: string[] = []

  const ctx = {
    command: {
      transform: (callback: (editor: { add: (command: CapturedCommand) => void }) => void) => {
        callback({ add: (command) => commands.push(command) })

        return Promise.resolve({ dispose: async () => undefined })
      },
    },
  }

  registerCommands(ctx as unknown as Pick<Plugin.Context, "command">, {
    store,
    log: (message) => logged.push(message),
    changed: (directory) => void announced.push(directory),
    session: {
      create: async (input) => {
        created.push(input)
        return { id: "ses_worker" }
      },
      prompt: async (input) => {
        if (options.promptThrows) throw new Error("prompt failed")
        prompts.push(input)
      },
      remove: async (input) => {
        if (options.removeThrows) throw new Error("remove failed")
        removed.push(input.sessionID)
      },
      synthetic: async (input) => {
        synthetic.push(input)
      },
    },
  })

  const invocation = (text: string, delivery: "steer" | "queue" = "steer") => ({
    sessionID: "ses_phone",
    prompt: { text },
    delivery,
  })

  return { dir, store, commands, synthetic, prompts, created, removed, logged, announced, invocation }
}

describe("kanban commands", () => {
  test("registers note and kanban with descriptions", async () => {
    const { commands } = harness()

    expect(commands.map((command) => command.name).sort()).toEqual(["kanban", "note"])
    expect(commands.every((command) => command.description?.length)).toBe(true)
  })

  test("/note captures a card in the session's project and records the outcome", async () => {
    const { dir, store, commands, synthetic, announced, invocation } = harness()
    const note = commands.find((command) => command.name === "note")!

    try {
      await note.execute(invocation("Buy milk"))

      // The card lands in the project the session belongs to, and is persisted there.
      const [task] = store.tasks(dir)
      expect(task?.title).toBe("Buy milk")
      expect(task?.source).toBe("note")
      expect(existsSync(join(dir, ".opencode", "kanban.json"))).toBe(true)
      expect(announced).toEqual([dir])

      expect(synthetic).toHaveLength(1)
      expect(synthetic[0]?.sessionID).toBe("ses_phone")
      expect(synthetic[0]?.description).toContain(task!.id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/note records the note as model-visible text", async () => {
    const { dir, commands, synthetic, invocation } = harness()
    const note = commands.find((command) => command.name === "note")!

    try {
      await note.execute(invocation("Buy milk"))

      // `text` is what the model sees (`core/src/session/recent-text.ts:57`), so this is the
      // field that puts the note in the session history.
      expect(synthetic[0]?.text).toBe("Buy milk")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/note's confirmation is visible to the user", async () => {
    const { dir, commands, synthetic, invocation } = harness()
    const note = commands.find((command) => command.name === "note")!

    try {
      await note.execute(invocation("Buy milk"))

      // `description` is the only field either client renders for a synthetic — the TUI shows
      // it as the notice body, the app as the notice label. Both drop a synthetic that has no
      // description, so without this the confirmation would be admitted and never shown.
      expect(synthetic[0]?.description?.trim()).toBeString()
      expect(synthetic[0]?.description).toContain("Buy milk")
      expect(synthetic[0]?.description).toContain("session ses_worker")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/note records with resume false so the session does not start a run", async () => {
    const { dir, commands, synthetic, invocation } = harness()
    const note = commands.find((command) => command.name === "note")!

    try {
      await note.execute(invocation("Buy milk"))

      // This is the load-bearing assertion. `synthetic` wakes the session unless `resume` is
      // explicitly false, and a run on the confirmation is not what the user asked for.
      expect(synthetic[0]?.resume).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/note starts a worker session prompted with the note", async () => {
    const { dir, commands, created, prompts, invocation } = harness()
    const note = commands.find((command) => command.name === "note")!

    try {
      await note.execute(invocation("Buy milk"))

      expect(created).toHaveLength(1)
      expect(created[0]?.title).toBe("Buy milk")

      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.sessionID).toBe("ses_worker")
      expect(prompts[0]?.text).toContain("Buy milk")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/note removes the orphaned worker session when the run cannot start", async () => {
    const { dir, store, commands, removed, invocation } = harness({ promptThrows: true })
    const note = commands.find((command) => command.name === "note")!

    try {
      // Capture is all-or-nothing on this door too: a session that was created and never
      // prompted is a session with no card behind it, and the user cannot open it from the board.
      await expect(note.execute(invocation("Buy milk"))).rejects.toThrow(/prompt failed/iu)
      expect(removed).toEqual(["ses_worker"])
      expect(store.tasks(dir)).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/note logs a rollback that could not remove the orphaned session", async () => {
    const { dir, commands, removed, logged, invocation } = harness({ promptThrows: true, removeThrows: true })
    const note = commands.find((command) => command.name === "note")!

    try {
      // The rollback is best-effort — the original error is the one worth reporting — but a
      // rollback that silently failed leaves an orphan session with no diagnostic.
      await expect(note.execute(invocation("Buy milk"))).rejects.toThrow(/prompt failed/iu)
      expect(removed).toEqual([])
      expect(logged.some((line) => line.includes("remove failed"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/note with no text asks instead of capturing", async () => {
    const { dir, store, commands, synthetic, prompts, invocation } = harness()
    const note = commands.find((command) => command.name === "note")!

    try {
      await note.execute(invocation("   "))

      expect(store.tasks(dir)).toHaveLength(0)
      expect(synthetic).toHaveLength(0)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.text).toContain("no text")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/note with no text passes the invocation's delivery through", async () => {
    const { dir, commands, prompts, invocation } = harness()
    const note = commands.find((command) => command.name === "note")!

    try {
      await note.execute(invocation("   ", "queue"))

      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.delivery).toBe("queue")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/kanban with no text asks the agent for the board", async () => {
    const { dir, commands, prompts, invocation } = harness()
    const kanban = commands.find((command) => command.name === "kanban")!

    try {
      await kanban.execute(invocation(""))

      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.text).toContain("kanban_list")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/kanban add passes the title through", async () => {
    const { dir, commands, prompts, invocation } = harness()
    const kanban = commands.find((command) => command.name === "kanban")!

    try {
      await kanban.execute(invocation("add Ship the report"))

      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.text).toContain("Ship the report")
      expect(prompts[0]?.text).toContain("kanban_add")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/kanban add keeps the title in a labelled block", async () => {
    const { dir, commands, prompts, invocation } = harness()
    const kanban = commands.find((command) => command.name === "kanban")!

    try {
      // Quoting the body into a sentence breaks on an embedded quote, and a sentence gives a
      // crafted note a chance to read as an instruction. A labelled block keeps the boundary
      // explicit and survives a quote in the title.
      await kanban.execute(invocation('add Ship the "report"'))

      expect(prompts[0]?.text).toContain('title:\n\nShip the "report"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/kanban move names the move tool", async () => {
    const { dir, commands, prompts, invocation } = harness()
    const kanban = commands.find((command) => command.name === "kanban")!

    try {
      await kanban.execute(invocation("move k_abc123 review"))

      expect(prompts[0]?.text).toContain("kanban_move")
      expect(prompts[0]?.text).toContain("k_abc123")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/kanban with an unknown form explains the command", async () => {
    const { dir, commands, prompts, invocation } = harness()
    const kanban = commands.find((command) => command.name === "kanban")!

    try {
      await kanban.execute(invocation("frobnicate"))

      expect(prompts).toHaveLength(1)
      expect(prompts[0]?.text).toContain("/kanban add")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/kanban passes the invocation's delivery through", async () => {
    const { dir, commands, prompts, invocation } = harness()
    const kanban = commands.find((command) => command.name === "kanban")!

    try {
      await kanban.execute(invocation("", "queue"))

      expect(prompts[0]?.delivery).toBe("queue")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/note inherits caller session agent and model when env overrides are unset", async () => {
    const dir = temp()
    const store = new BoardStore(() => dir)
    const commands: CapturedCommand[] = []
    const created: { agent?: string; model?: { providerID: string; id: string }; title?: string }[] = []

    const ctx = {
      command: {
        transform: (callback: (editor: { add: (command: CapturedCommand) => void }) => void) => {
          callback({ add: (command) => commands.push(command) })
          return Promise.resolve({ dispose: async () => undefined })
        },
      },
    }

    registerCommands(ctx as unknown as Pick<Plugin.Context, "command">, {
      store,
      session: {
        get: async () => ({
          agent: "build",
          model: { providerID: "openai", id: "gpt-5.4" },
        }),
        create: async (input) => {
          created.push(input)
          return { id: "ses_worker" }
        },
        prompt: async () => undefined,
        remove: async () => undefined,
        synthetic: async () => undefined,
      },
    })

    const note = commands.find((command) => command.name === "note")!

    try {
      await note.execute({ sessionID: "ses_caller", prompt: { text: "Inherit my model" }, delivery: "steer" })
      expect(created).toHaveLength(1)
      expect(created[0]?.agent).toBe("build")
      expect(created[0]?.model).toEqual({ providerID: "openai", id: "gpt-5.4" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
