import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"

export const Status = Schema.Literals(["backlog", "todo", "working", "review", "done"])
export type Status = typeof Status.Type

export const Priority = Schema.Literals(["low", "med", "high"])
export type Priority = typeof Priority.Type

export const Source = Schema.Literals(["telegram", "note", "manual"])
export type Source = typeof Source.Type

export const Task = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  status: Status,
  priority: Priority,
  source: Source,
  sessionID: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
  /** The Telegram chat a capture came from, so a finished card can be reported back to it. */
  telegramChatID: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type Task = Readonly<typeof Task.Type>

/**
 * `Rpc.define` accepts Effect schemas, but the promise plugin's `ctx.rpc.register` requires a
 * `PortableDefinition`, whose method schemas must be `StandardSchemaV1` or JSON Schema
 * (`packages/plugin/src/promise/rpc.ts:27`, `packages/schema/src/rpc.ts:19`). Effect's `Schema`
 * is not `~standard`-tagged, so every schema is converted. The conversion is type-preserving —
 * `Rpc.Output` still resolves to the decoded type — so the handlers registered in `index.ts`
 * stay typed.
 */
const portable = Schema.toStandardSchemaV1

/**
 * The RPC the GUI panel uses.
 *
 * Every method takes the caller's `sessionID`, because the board is per-project and the panel
 * has no other way to name the project: the session is what resolves it. The panel sends its
 * own session id, so the card it just added lands on the same board it is looking at.
 *
 * `list` returns the whole board rather than a page: boards are small by design (a capture
 * inbox, not a backlog), and a full read lets the panel render five columns in one round trip
 * without a second request per column.
 *
 * The `changed` event carries the directory the write was resolved from — the writing session's
 * directory, which is *not* the board's identity: the board is the `.git` root `resolvePath` walks
 * up to, so two sessions in one repo share a board while announcing different directories. A panel
 * therefore cannot filter on it without dropping a sibling session's write, and re-reads instead.
 */
export const Definition = Rpc.define({
  id: "experimental.kanban",
  methods: {
    list: {
      input: portable(Schema.Struct({ sessionID: Schema.String })),
      output: portable(Schema.Array(Task)),
    },
    add: {
      input: portable(
        Schema.Struct({
          sessionID: Schema.String,
          title: Schema.String,
          description: Schema.optional(Schema.String),
          priority: Schema.optional(Priority),
          status: Schema.optional(Status),
          linkSessionID: Schema.optional(Schema.String),
        }),
      ),
      output: portable(Task),
    },
    move: {
      input: portable(
        Schema.Struct({
          sessionID: Schema.String,
          id: Schema.String,
          status: Status,
        }),
      ),
      output: portable(Task),
    },
    update: {
      input: portable(
        Schema.Struct({
          sessionID: Schema.String,
          id: Schema.String,
          title: Schema.optional(Schema.String),
          description: Schema.optional(Schema.String),
          priority: Schema.optional(Priority),
        }),
      ),
      output: portable(Task),
    },
    remove: {
      input: portable(Schema.Struct({ sessionID: Schema.String, id: Schema.String })),
      output: portable(Schema.Void),
    },
    ensureSession: {
      input: portable(Schema.Struct({ sessionID: Schema.String, id: Schema.String })),
      output: portable(Task),
    },
  },
  events: {
    changed: { schema: portable(Schema.Struct({ directory: Schema.String })) },
  },
})
