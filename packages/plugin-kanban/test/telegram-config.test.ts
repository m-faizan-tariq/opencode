import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireTelegramLock, loadTelegramConfig } from "../src/telegram-config"

/**
 * The config and lock are the safety boundary around the Telegram bot: a second poller earns a
 * `409 Conflict` on every `getUpdates` and stalls the bot. These tests pin the gating that keeps
 * a short-lived CLI command and OpenCode Prod from reading the `.env` file, and the lock that
 * keeps two processes from polling at once.
 */

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "kanban-tgconfig-"))
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  return dir
}

function writeEnv(home: string, body: string) {
  writeFileSync(join(home, ".opencode", "kanban-telegram.env"), body, { mode: 0o600 })
}

function cleanup(home: string) {
  rmSync(home, { recursive: true, force: true })
}

describe("loadTelegramConfig", () => {
  test("an explicit token wins without the dev bundle", () => {
    const config = loadTelegramConfig(
      { KANBAN_TELEGRAM_TOKEN: "env-token", KANBAN_TELEGRAM_CHATS: "1, 2", GROQ_API_KEY: "env-groq" },
      "/tmp",
    )

    expect(config.token).toBe("env-token")
    expect(config.chats).toEqual(new Set(["1", "2"]))
    expect(config.groqApiKey).toBe("env-groq")
    expect(config.source).toBe("env")
  })

  test("a CLI process without a token does not read the env file", () => {
    const home = tempHome()
    try {
      writeEnv(home, 'KANBAN_TELEGRAM_TOKEN="file-token"\n')

      // No `__CFBundleIdentifier` and no `KANBAN_TELEGRAM_ENABLE`: a short-lived `opencode run`
      // command must not poll the bot, so the file is never read.
      const config = loadTelegramConfig({ HOME: home }, home)

      expect(config.token).toBeUndefined()
      expect(config.source).toBe("none")
    } finally {
      cleanup(home)
    }
  })

  test("the dev bundle reads the env file", () => {
    const home = tempHome()
    try {
      writeEnv(
        home,
        '# a comment\nKANBAN_TELEGRAM_TOKEN="file-token"\nKANBAN_TELEGRAM_CHATS="11, 22"\nGROQ_API_KEY="file-groq"\n',
      )

      const config = loadTelegramConfig({ HOME: home, __CFBundleIdentifier: "ai.opencode.desktop.dev" }, home)

      expect(config.token).toBe("file-token")
      expect(config.chats).toEqual(new Set(["11", "22"]))
      expect(config.groqApiKey).toBe("file-groq")
      expect(config.source).toBe("file")
    } finally {
      cleanup(home)
    }
  })

  test("KANBAN_TELEGRAM_ENABLE=1 reads the env file", () => {
    const home = tempHome()
    try {
      writeEnv(home, "KANBAN_TELEGRAM_TOKEN=plain-token\n")

      const config = loadTelegramConfig({ HOME: home, KANBAN_TELEGRAM_ENABLE: "1" }, home)

      expect(config.token).toBe("plain-token")
      expect(config.source).toBe("file")
    } finally {
      cleanup(home)
    }
  })

  test("a missing env file yields no token rather than throwing", () => {
    const home = tempHome()
    try {
      const config = loadTelegramConfig({ HOME: home, __CFBundleIdentifier: "ai.opencode.desktop.dev" }, home)

      expect(config.token).toBeUndefined()
      expect(config.chats.size).toBe(0)
    } finally {
      cleanup(home)
    }
  })

  test("KANBAN_GROQ_API_KEY is a fallback for GROQ_API_KEY", () => {
    const home = tempHome()
    try {
      writeEnv(home, "KANBAN_TELEGRAM_TOKEN=t\nKANBAN_GROQ_API_KEY=fallback\n")

      const config = loadTelegramConfig({ HOME: home, __CFBundleIdentifier: "ai.opencode.desktop.dev" }, home)

      expect(config.groqApiKey).toBe("fallback")
    } finally {
      cleanup(home)
    }
  })

  test("malformed lines are skipped without losing the good ones", () => {
    const home = tempHome()
    try {
      writeEnv(home, "not-a-key-value\nKANBAN_TELEGRAM_TOKEN=t\n\n# comment\n=missing-key\nKANBAN_TELEGRAM_CHATS=7\n")

      const config = loadTelegramConfig({ HOME: home, __CFBundleIdentifier: "ai.opencode.desktop.dev" }, home)

      expect(config.token).toBe("t")
      expect(config.chats).toEqual(new Set(["7"]))
    } finally {
      cleanup(home)
    }
  })

  test("the lock path honours KANBAN_TELEGRAM_LOCK", () => {
    const config = loadTelegramConfig({ KANBAN_TELEGRAM_TOKEN: "t", KANBAN_TELEGRAM_LOCK: "/tmp/custom.lock" }, "/tmp")

    expect(config.lockPath).toBe("/tmp/custom.lock")
  })

  test("the default lock path lives under the home directory", () => {
    const config = loadTelegramConfig({ KANBAN_TELEGRAM_TOKEN: "t" }, "/tmp")

    expect(config.lockPath).toBe(join("/tmp", ".opencode", "kanban-telegram.lock"))
  })
})

describe("acquireTelegramLock", () => {
  function tempLock() {
    const dir = mkdtempSync(join(tmpdir(), "kanban-lock-"))
    return { dir, path: join(dir, "kanban-telegram.lock") }
  }

  test("creates the lock and the release callback removes it", () => {
    const { dir, path } = tempLock()
    try {
      const release = acquireTelegramLock(path, 4321)

      expect(release).toBeDefined()
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ pid: 4321, startedAt: expect.any(String) })

      release?.()
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a corrupt lock is replaced", () => {
    const { dir, path } = tempLock()
    try {
      writeFileSync(path, "not json at all", { mode: 0o600 })

      const release = acquireTelegramLock(path, 4321)

      expect(release).toBeDefined()
      expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(4321)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a stale lock from a dead pid is replaced", () => {
    const { dir, path } = tempLock()
    try {
      writeFileSync(path, JSON.stringify({ pid: 2_000_000_000, startedAt: "old" }), { mode: 0o600 })

      const release = acquireTelegramLock(path, 4321)

      expect(release).toBeDefined()
      expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(4321)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a live lock owned by another pid is respected", () => {
    const { dir, path } = tempLock()
    try {
      // PID 1 is launchd: always present, and `kill(1, 0)` reports EPERM rather than ESRCH.
      writeFileSync(path, JSON.stringify({ pid: 1, startedAt: "live" }), { mode: 0o600 })

      expect(acquireTelegramLock(path, 4321)).toBeUndefined()
      expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a release does not remove another owner's lock", () => {
    const { dir, path } = tempLock()
    try {
      const release = acquireTelegramLock(path, 4321)
      expect(release).toBeDefined()

      // Simulate another process taking over between acquire and release.
      writeFileSync(path, JSON.stringify({ pid: 9999, startedAt: "new" }), { mode: 0o600 })
      release?.()

      expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(9999)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
