import { Schema } from "effect"
import { Plugin } from "@opencode/plugin"
import { Tool } from "@opencode/schema/tool"
import { COLUMNS, Task } from "./board"
import type { BoardStore } from "./store"

export interface ToolDeps {
  readonly store: BoardStore
  /**
   * Announces a write so an open panel refreshes. The design requires `changed` "after every
   * write", and the RPC handlers and the session event handler both emit it — without this, a
   * card added by `kanban_add` reaches disk but not the side panel until something else changes.
   */
  readonly changed: (directory: string) => Promise<void> | void
}

const status = Schema.Literals(["backlog", "todo", "working", "review", "done"])
const priority = Schema.Literals(["low", "med", "high"])

/**
 * The output of every mutating tool: the whole affected task.
 *
 * The design names the field `task` and gives the affected task as the output, not a projection.
 * Returning three of the task's fields would force the caller to make a second call to learn the
 * rest, and a card's `result` — the thing that makes `review` worth reading — is not among them.
 */
const taskOutput = Schema.Struct({ task: Task })

interface Result {
  readonly output?: any
  readonly content?: string
}

/**
 * The board ops signal a missing card or an invalid title with a plain `Error`. Converting it
 * once, here, keeps a single source of truth for the message and guarantees every tool
 * surfaces a `Tool.Error` rather than a bare rejection.
 */
async function run(body: () => Promise<Result>): Promise<Result> {
  try {
    return await body()
  } catch (error) {
    if (error instanceof Tool.Error) throw error
    throw new Tool.Error({ message: error instanceof Error ? error.message : String(error), error })
  }
}

/**
 * Registers the five board tools under the `kanban` namespace, which the host renders as
 * `kanban_add`, `kanban_move`, `kanban_list`, `kanban_update`, and `kanban_delete`.
 */
export function registerTools(ctx: Pick<Plugin.Context, "tool">, deps: ToolDeps) {
  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "kanban",
      description:
        "A persistent Kanban board for the current project. Use kanban_list when the user asks to see their board. Capturing from Telegram or /note creates a card and starts work automatically; these tools read and edit the board.",
    })

    editor.add({
      name: "add",
      description:
        "Add a card to the board. Does not start work; capture from Telegram or /note to create a card and start work.",
      input: Schema.Struct({
        title: Schema.String,
        description: Schema.optional(Schema.String),
        priority: Schema.optional(priority),
        status: Schema.optional(status),
      }),
      output: taskOutput,
      options: { namespace: "kanban" },
      execute: (input, context) =>
        run(async () => {
          const directory = await deps.store.directory(context.sessionID)
          const { task } = deps.store.add(directory, {
            title: input.title,
            description: input.description,
            priority: input.priority,
            status: input.status,
            sessionID: context.sessionID,
          })
          await deps.changed(directory)

          // The design's "confirmation + board summary": the confirmation names the new card, and
          // the rendered board is the summary the user asked for.
          return {
            output: { task },
            content: `Added "${task.title}" as \`${task.id}\`.\n\n${deps.store.render(directory)}`,
          }
        }),
    })

    editor.add({
      name: "move",
      description: `Move a card to another column. Valid statuses: ${COLUMNS.join(", ")}.`,
      input: Schema.Struct({ id: Schema.String, status }),
      output: taskOutput,
      options: { namespace: "kanban" },
      execute: (input, context) =>
        run(async () => {
          const directory = await deps.store.directory(context.sessionID)
          // `move` throws "kanban: no task with id …" for an unknown id; `run` surfaces it.
          const task = deps.store.move(directory, input.id, input.status).tasks.find((item) => item.id === input.id)!
          await deps.changed(directory)

          return { output: { task }, content: `Moved "${task.title}" to \`${task.status}\`.` }
        }),
    })

    editor.add({
      name: "list",
      description: "List the board, or one column. Returns the markdown board for display.",
      input: Schema.Struct({ status: Schema.optional(status) }),
      output: Schema.Struct({ tasks: Schema.Array(Task), markdown: Schema.String }),
      options: { namespace: "kanban" },
      execute: (input, context) =>
        run(async () => {
          const directory = await deps.store.directory(context.sessionID)
          const tasks = deps.store.list(directory, input.status)
          const markdown = deps.store.render(directory, input.status)

          return { output: { tasks, markdown }, content: markdown }
        }),
    })

    editor.add({
      name: "update",
      description: "Change a card's title, description, priority, or status.",
      input: Schema.Struct({
        id: Schema.String,
        title: Schema.optional(Schema.String),
        description: Schema.optional(Schema.String),
        priority: Schema.optional(priority),
        status: Schema.optional(status),
      }),
      output: taskOutput,
      options: { namespace: "kanban" },
      execute: (input, context) =>
        run(async () => {
          const directory = await deps.store.directory(context.sessionID)
          // `update` throws "kanban: no task with id …" for an unknown id; `run` surfaces it.
          const board = deps.store.update(directory, input.id, {
            title: input.title,
            description: input.description,
            priority: input.priority,
            status: input.status,
          })
          const task = board.tasks.find((item) => item.id === input.id)!
          await deps.changed(directory)

          return { output: { task }, content: `Updated "${task.title}".` }
        }),
    })

    editor.add({
      name: "delete",
      description: "Delete a card from the board.",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({ id: Schema.String }),
      options: { namespace: "kanban" },
      execute: (input, context) =>
        run(async () => {
          const directory = await deps.store.directory(context.sessionID)
          // `remove` throws "kanban: no task with id …" for an unknown id; `run` surfaces it.
          deps.store.remove(directory, input.id)
          await deps.changed(directory)

          return { output: { id: input.id }, content: `Deleted card \`${input.id}\`.` }
        }),
    })
  })
}
