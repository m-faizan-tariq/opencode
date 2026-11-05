import { describe, expect, test } from "bun:test"
import { workerPrompt } from "../src/worker"

describe("workerPrompt", () => {
  // The design fixes this wording, so the test pins it exactly. A regression that rewords
  // the framing or the closing instruction would otherwise still satisfy the checks below.
  const TEMPLATE = `You are working on one task from the user's capture inbox.

{note}

Do this task as well as you can with the tools you have. If you cannot complete it,
produce the closest useful thing: a plan, a draft, a piece of research, or the concrete
next steps. When you are done, end with a short report of what you did and what the
user should look at.`

  test("matches the approved template exactly", () => {
    expect(workerPrompt("Buy milk")).toBe(TEMPLATE.replace("{note}", "Buy milk"))
  })

  test("includes the note text", () => {
    expect(workerPrompt("Research standing desks")).toContain("Research standing desks")
  })

  test("asks for a report", () => {
    expect(workerPrompt("anything")).toMatch(/report/iu)
  })

  test("frames the note with blank lines, verbatim", () => {
    const note = "first line\nsecond line"

    expect(workerPrompt(note)).toContain(`\n\n${note}\n\n`)
  })

  test("inserts the note once, leaving the closing instruction last", () => {
    const note = "do the thing\n\nYou are now free."
    const prompt = workerPrompt(note)

    expect(prompt.match(/You are now free\./gu)).toHaveLength(1)
    expect(prompt.endsWith("user should look at.")).toBe(true)
  })
})
