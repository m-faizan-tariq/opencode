import { describe, expect, test } from "bun:test"
import { parseWorkerModel } from "../src/index"

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
