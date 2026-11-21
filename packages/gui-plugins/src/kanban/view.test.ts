import { describe, expect, test } from "bun:test"
import type { Task } from "@opencode/plugin-kanban/rpc"
import {
  filterTasks,
  formatTaskDate,
  readStoredListGroup,
  readStoredListSort,
  readStoredView,
  sectionCollapsed,
  sectionExpanded,
  sortTasks,
  writeStoredListGroup,
  writeStoredListSort,
  writeStoredView,
} from "./view"

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "k_1",
    title: "Task",
    description: "",
    status: "review",
    priority: "med",
    source: "manual",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  }
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial))

  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  }
}

const throwing: Storage = {
  get length() {
    return 0
  },
  clear: () => undefined,
  getItem: () => {
    throw new Error("blocked")
  },
  key: () => {
    throw new Error("blocked")
  },
  removeItem: () => {
    throw new Error("blocked")
  },
  setItem: () => {
    throw new Error("blocked")
  },
}

describe("filterTasks", () => {
  const tasks = [
    task({ id: "a", title: "Alpha", description: "First", status: "review", priority: "high", source: "manual", result: "Done" }),
    task({ id: "b", title: "Beta", description: "Second", status: "todo", priority: "low", source: "note", result: "Pending" }),
  ]

  test("keeps every task for an empty query", () => {
    expect(filterTasks(tasks, "")).toBe(tasks)
    expect(filterTasks(tasks, "   ")).toBe(tasks)
  })

  test("matches case-insensitively across every field", () => {
    expect(filterTasks(tasks, "alpha").map((item) => item.id)).toEqual(["a"])
    expect(filterTasks(tasks, "SECOND").map((item) => item.id)).toEqual(["b"])
    expect(filterTasks(tasks, "pending").map((item) => item.id)).toEqual(["b"])
    expect(filterTasks(tasks, "review").map((item) => item.id)).toEqual(["a"])
    expect(filterTasks(tasks, "HIGH").map((item) => item.id)).toEqual(["a"])
    expect(filterTasks(tasks, "note").map((item) => item.id)).toEqual(["b"])
  })

  test("returns nothing when no field matches", () => {
    expect(filterTasks(tasks, "missing")).toEqual([])
  })
})

describe("sortTasks", () => {
  const tasks = [
    task({ id: "low", priority: "low", updatedAt: "2026-11-03T10:00:00.000Z" }),
    task({ id: "high", priority: "high", updatedAt: "2026-11-01T10:00:00.000Z" }),
    task({ id: "med", priority: "med", updatedAt: "2026-11-02T10:00:00.000Z" }),
  ]

  test("default keeps board order", () => {
    expect(sortTasks(tasks, "default")).toBe(tasks)
  })

  test("updated sorts newest first", () => {
    expect(sortTasks(tasks, "updated").map((item) => item.id)).toEqual(["low", "med", "high"])
  })

  test("priority sorts high to low", () => {
    expect(sortTasks(tasks, "priority").map((item) => item.id)).toEqual(["high", "med", "low"])
  })
})

describe("sectionCollapsed", () => {
  test("empty sections collapse by default and non-empty sections expand", () => {
    expect(sectionCollapsed(undefined, 0)).toBe(true)
    expect(sectionCollapsed(undefined, 12)).toBe(false)
  })

  test("an explicit toggle wins over the default", () => {
    expect(sectionCollapsed(true, 0)).toBe(false)
    expect(sectionCollapsed(false, 12)).toBe(true)
  })

  test("sectionExpanded is the inverse and stores the toggle directly", () => {
    expect(sectionExpanded(undefined, 0)).toBe(false)
    expect(sectionExpanded(undefined, 12)).toBe(true)
    expect(sectionExpanded(true, 0)).toBe(true)
    expect(sectionExpanded(false, 12)).toBe(false)
  })
})

describe("formatTaskDate", () => {
  test("renders the time alone for today", () => {
    const now = new Date(2026, 10, 12, 15, 0, 0)
    const today = new Date(2026, 10, 12, 8, 5, 0)

    expect(formatTaskDate(today.toISOString(), now)).toBe("08:05")
  })

  test("renders a short month date for another day", () => {
    const now = new Date(2026, 10, 12, 15, 0, 0)
    const other = new Date(2026, 10, 10, 14, 30, 0)

    expect(formatTaskDate(other.toISOString(), now)).toBe("Nov 10, 14:30")
  })

  test("renders an empty string for an unparseable timestamp", () => {
    expect(formatTaskDate("not-a-date")).toBe("")
  })
})

describe("stored view preferences", () => {
  test("defaults to the board, sections and board order", () => {
    const target = memoryStorage()

    expect(readStoredView(target)).toBe("board")
    expect(readStoredListGroup(target)).toBe("sections")
    expect(readStoredListSort(target)).toBe("default")
  })

  test("persists the view mode", () => {
    const target = memoryStorage()

    writeStoredView("list", target)
    expect(readStoredView(target)).toBe("list")
    expect(target.getItem("opencode.kanban.view")).toBe("list")
  })

  test("persists the grouping and sort", () => {
    const target = memoryStorage()

    writeStoredListGroup("flat", target)
    writeStoredListSort("priority", target)
    expect(readStoredListGroup(target)).toBe("flat")
    expect(readStoredListSort(target)).toBe("priority")
  })

  test("falls back when the stored value is unknown", () => {
    const target = memoryStorage({
      "opencode.kanban.view": "grid",
      "opencode.kanban.listGroup": "rows",
      "opencode.kanban.listSort": "title",
    })

    expect(readStoredView(target)).toBe("board")
    expect(readStoredListGroup(target)).toBe("sections")
    expect(readStoredListSort(target)).toBe("default")
  })

  test("survives a storage that throws", () => {
    expect(readStoredView(throwing)).toBe("board")
    expect(readStoredListGroup(throwing)).toBe("sections")
    expect(readStoredListSort(throwing)).toBe("default")
    expect(() => writeStoredView("list", throwing)).not.toThrow()
  })
})
