import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * The Telegram capture door's configuration, resolved once at plugin setup.
 *
 * The `.env` file is deliberately gated: a short-lived `opencode run` CLI command and OpenCode
 * Prod must never poll Telegram, because two pollers on one bot produce `409 Conflict` and the
 * bot stalls. Only the Dev desktop bundle (or an explicit `KANBAN_TELEGRAM_ENABLE=1`) may read
 * the file, and an explicit `KANBAN_TELEGRAM_TOKEN` in the environment always wins.
 */
export interface TelegramConfig {
  readonly token: string | undefined
  readonly chats: ReadonlySet<string>
  readonly groqApiKey: string | undefined
  readonly lockPath: string
  /** Where the config came from, for the one-time setup log. */
  readonly source: "env" | "file" | "none"
}

interface LockFile {
  readonly pid: number
  readonly startedAt: string
}

function parseChats(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((chat) => chat.trim())
      .filter(Boolean),
  )
}

/**
 * Parses `KEY=VALUE` lines, skipping blanks and comments, trimming whitespace, and stripping a
 * matching pair of quotes. A line without `=` is ignored rather than treated as an error: the
 * file is user-edited, and one bad line must not disable the bot.
 */
function parseEnvFile(content: string): Map<string, string> {
  const out = new Map<string, string>()

  for (const raw of content.split(/\r\n|\r|\n/u)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue

    const eq = line.indexOf("=")
    if (eq <= 0) continue

    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()

    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1)
    }

    out.set(key, value)
  }

  return out
}

export function loadTelegramConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME || homedir(),
): TelegramConfig {
  const lockPath = env.KANBAN_TELEGRAM_LOCK || join(home, ".opencode", "kanban-telegram.lock")

  if (env.KANBAN_TELEGRAM_TOKEN) {
    return {
      token: env.KANBAN_TELEGRAM_TOKEN,
      chats: parseChats(env.KANBAN_TELEGRAM_CHATS),
      groqApiKey: env.GROQ_API_KEY || env.KANBAN_GROQ_API_KEY,
      lockPath,
      source: "env",
    }
  }

  const devBundle = env.__CFBundleIdentifier === "ai.opencode.desktop.dev"
  if (!devBundle && env.KANBAN_TELEGRAM_ENABLE !== "1") {
    return { token: undefined, chats: new Set(), groqApiKey: undefined, lockPath, source: "none" }
  }

  let file = new Map<string, string>()

  try {
    file = parseEnvFile(readFileSync(join(home, ".opencode", "kanban-telegram.env"), "utf8"))
  } catch {
    // A missing or unreadable file is the same as an empty one: the bot stays off.
  }

  return {
    token: file.get("KANBAN_TELEGRAM_TOKEN"),
    chats: parseChats(file.get("KANBAN_TELEGRAM_CHATS")),
    groqApiKey: file.get("GROQ_API_KEY") || file.get("KANBAN_GROQ_API_KEY"),
    lockPath,
    source: "file",
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readLock(lockPath: string): LockFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockFile>
    return typeof parsed.pid === "number" ? { pid: parsed.pid, startedAt: parsed.startedAt ?? "" } : undefined
  } catch {
    return undefined
  }
}

function releaseLock(lockPath: string, pid: number): () => void {
  return () => {
    try {
      // Only remove the lock while it still records this process: a stale release must not
      // unlink a lock a newer owner has since taken.
      if (readLock(lockPath)?.pid === pid) unlinkSync(lockPath)
    } catch {
      // The lock is already gone or unreadable; nothing to release.
    }
  }
}

/**
 * Takes the process-wide Telegram lock, or returns `undefined` when another live process holds it.
 *
 * The lock is what keeps two OpenCode processes from long-polling one bot: Telegram answers a
 * second `getUpdates` with `409 Conflict`, and the bot stalls until one poller backs off. The
 * file records the owner's PID so a lock left behind by a crashed process is recognised as
 * stale and taken over, while a lock held by a live process is respected.
 *
 * A stale or corrupt lock is removed and the create is retried once. A live lock owned by a
 * *different* PID returns `undefined`, which tells the caller to skip `startTelegram` entirely.
 */
export function acquireTelegramLock(lockPath: string, pid: number = process.pid): (() => void) | undefined {
  const startedAt = new Date().toISOString()

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // The lock lives in `~/.opencode`, which a fresh install may not have created yet; the
      // `wx` create below would otherwise fail with ENOENT rather than take the lock.
      mkdirSync(dirname(lockPath), { recursive: true })
      writeFileSync(lockPath, JSON.stringify({ pid, startedAt }), { flag: "wx", mode: 0o600 })
      return releaseLock(lockPath, pid)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error

      const existing = readLock(lockPath)

      // A live lock owned by another process is a real conflict, not a stale file.
      if (existing && existing.pid !== pid && isAlive(existing.pid)) return undefined

      try {
        unlinkSync(lockPath)
      } catch {
        // Already gone; the retry's `wx` create either succeeds or reports a live holder.
      }
    }
  }

  return undefined
}
