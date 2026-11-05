import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleEvent, onPrompt } from "../src/events"
import { BoardStore } from "../src/store"

/**
 * A temp directory that looks like a project root.
 *
 * `resolvePath` walks up for `.git` and only falls back to the global `~/.opencode/kanban.json`
 * when it finds none. Without this the board lands on the user's real board file, and every
 * test that runs writes into it.
 */
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "kanban-events-"))
  mkdirSync(join(dir, ".git"), { recursive: true })

  return dir
}

function harness() {
  const dir = temp()
  const store = new BoardStore()
  const { task } = store.add(dir, { title: "Linked", source: "note", sessionID: "ses_worker" })

  return { dir, store, task }
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

describe("session events", () => {
  test("a text event sets the result", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.text.ended", sessionID: "ses_worker", text: "Here is the report" })

      expect(store.find(dir, task.id)?.result).toBe("Here is the report")
    } finally {
      cleanup(dir)
    }
  })

  test("the last text event wins", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.text.ended", sessionID: "ses_worker", text: "first draft" })
      handleEvent(store, dir, { type: "session.text.ended", sessionID: "ses_worker", text: "final answer" })

      expect(store.find(dir, task.id)?.result).toBe("final answer")
    } finally {
      cleanup(dir)
    }
  })

  test("a text event without text does not erase the result", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.text.ended", sessionID: "ses_worker", text: "the report" })
      // A malformed event carries no `text`; `update` drops the explicit `undefined` rather
      // than writing one, so the last real result survives.
      handleEvent(store, dir, { type: "session.text.ended", sessionID: "ses_worker" })

      expect(store.find(dir, task.id)?.result).toBe("the report")
    } finally {
      cleanup(dir)
    }
  })

  test("a text event does not change the status", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.text.ended", sessionID: "ses_worker", text: "still running" })

      expect(store.find(dir, task.id)?.status).toBe("todo")
    } finally {
      cleanup(dir)
    }
  })

  test("a succeeded run moves the card to review", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.execution.succeeded", sessionID: "ses_worker" })

      expect(store.find(dir, task.id)?.status).toBe("review")
    } finally {
      cleanup(dir)
    }
  })

  test("a failed run moves the card to review with the error", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.execution.failed", sessionID: "ses_worker", error: { message: "boom" } })

      expect(store.find(dir, task.id)?.status).toBe("review")
      expect(store.find(dir, task.id)?.result).toBe("boom")
    } finally {
      cleanup(dir)
    }
  })

  test("a failed run without an error message still lands in review", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.execution.failed", sessionID: "ses_worker", error: {} })

      expect(store.find(dir, task.id)?.status).toBe("review")
      expect(store.find(dir, task.id)?.result).toBe("the run failed")
    } finally {
      cleanup(dir)
    }
  })

  test("an interrupted run leaves the status alone", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.execution.interrupted", sessionID: "ses_worker", reason: "user" })

      expect(store.find(dir, task.id)?.status).toBe("todo")
    } finally {
      cleanup(dir)
    }
  })

  test("a started run leaves the status alone", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.execution.started", sessionID: "ses_worker" })

      expect(store.find(dir, task.id)?.status).toBe("todo")
    } finally {
      cleanup(dir)
    }
  })

  test("events for unrelated sessions are ignored", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.execution.succeeded", sessionID: "ses_other" })

      expect(store.find(dir, task.id)?.status).toBe("todo")
    } finally {
      cleanup(dir)
    }
  })

  test("an unrecognised event type is a no-op", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.created", sessionID: "ses_worker" })

      expect(store.find(dir, task.id)?.status).toBe("todo")
      expect(store.find(dir, task.id)?.result).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })

  test("a card with no sessionID is never linked", async () => {
    const dir = temp()

    try {
      const store = new BoardStore()
      const { task } = store.add(dir, { title: "Unlinked", source: "manual" })

      handleEvent(store, dir, { type: "session.execution.succeeded", sessionID: "ses_worker" })
      handleEvent(store, dir, { type: "session.text.ended", sessionID: "ses_worker", text: "report" })

      expect(store.find(dir, task.id)?.status).toBe("todo")
      expect(store.find(dir, task.id)?.result).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })

  test("writes the change through to the board on disk", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.execution.succeeded", sessionID: "ses_worker" })

      // A fresh store has to see the review status, which proves the write was persisted
      // rather than only held in this instance's cache.
      expect(new BoardStore().find(dir, task.id)?.status).toBe("review")
    } finally {
      cleanup(dir)
    }
  })

  test("reports whether the event changed a linked task", async () => {
    const { dir, store, task } = harness()

    try {
      // An update is a change the caller must announce.
      expect(handleEvent(store, dir, { type: "session.execution.succeeded", sessionID: "ses_worker" })).toBe(true)

      // An unrelated session, an unrecognised type, and an ignored type all leave the board
      // alone, so none of them should be announced.
      expect(handleEvent(store, dir, { type: "session.execution.succeeded", sessionID: "ses_other" })).toBe(false)
      expect(handleEvent(store, dir, { type: "session.created", sessionID: "ses_worker" })).toBe(false)
      expect(handleEvent(store, dir, { type: "session.execution.started", sessionID: "ses_worker" })).toBe(false)

      // Sanity: the ignored events really did leave the card untouched.
      expect(store.find(dir, task.id)?.result).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })

  test("a repeated event is not reported as a change", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.execution.succeeded", sessionID: "ses_worker" })
      const settled = store.find(dir, task.id)!

      // A redelivered event — a retry, or a replayed stream — must not rewrite the board or
      // announce a change for a card that is already where it belongs.
      expect(handleEvent(store, dir, { type: "session.execution.succeeded", sessionID: "ses_worker" })).toBe(false)
      expect(store.find(dir, task.id)?.updatedAt).toBe(settled.updatedAt)
    } finally {
      cleanup(dir)
    }
  })

  test("a text event with no text is not reported as a change", async () => {
    const { dir, store, task } = harness()

    try {
      const before = store.find(dir, task.id)!

      // `update` bumps `updatedAt` even for an empty patch, so an event that carries nothing has
      // to be dropped before it reaches the store.
      expect(handleEvent(store, dir, { type: "session.text.ended", sessionID: "ses_worker" })).toBe(false)
      expect(store.find(dir, task.id)?.updatedAt).toBe(before.updatedAt)
    } finally {
      cleanup(dir)
    }
  })
})

describe("the prompt hook", () => {
  test("a prompt in a linked session moves the card to working", async () => {
    const { dir, store, task } = harness()

    try {
      expect(onPrompt(store, dir, "ses_worker")).toBeDefined()
      expect(store.find(dir, task.id)?.status).toBe("working")
    } finally {
      cleanup(dir)
    }
  })

  test("a prompt in an unlinked session is ignored", async () => {
    const { dir, store, task } = harness()

    try {
      expect(onPrompt(store, dir, "ses_other")).toBeUndefined()
      expect(store.find(dir, task.id)?.status).toBe("todo")
    } finally {
      cleanup(dir)
    }
  })

  test("a prompt cannot link a card that has no sessionID", async () => {
    const dir = temp()

    try {
      const store = new BoardStore()
      const { task } = store.add(dir, { title: "Unlinked", source: "manual" })

      expect(onPrompt(store, dir, "ses_worker")).toBeUndefined()
      expect(store.find(dir, task.id)?.status).toBe("todo")
    } finally {
      cleanup(dir)
    }
  })

  test("the card can be picked back up out of review", async () => {
    const { dir, store, task } = harness()

    try {
      handleEvent(store, dir, { type: "session.execution.succeeded", sessionID: "ses_worker" })
      expect(store.find(dir, task.id)?.status).toBe("review")

      // The user reads the result and keeps talking in the same session, which is the whole
      // reason the card carries its session id.
      onPrompt(store, dir, "ses_worker")
      expect(store.find(dir, task.id)?.status).toBe("working")
    } finally {
      cleanup(dir)
    }
  })

  test("writes the change through to the board on disk", async () => {
    const { dir, store, task } = harness()

    try {
      onPrompt(store, dir, "ses_worker")

      expect(new BoardStore().find(dir, task.id)?.status).toBe("working")
    } finally {
      cleanup(dir)
    }
  })

  test("a prompt on a card already working is not a change", async () => {
    const { dir, store, task } = harness()

    try {
      onPrompt(store, dir, "ses_worker")
      const working = store.find(dir, task.id)!

      // A second message in the same turn must not rewrite the board or announce a change.
      expect(onPrompt(store, dir, "ses_worker")).toBeUndefined()
      expect(store.find(dir, task.id)?.updatedAt).toBe(working.updatedAt)
    } finally {
      cleanup(dir)
    }
  })
})
