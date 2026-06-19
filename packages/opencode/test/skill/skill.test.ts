import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import { scanAvailableSkills } from "../../src/skill/scanner"
import { loadSkillContent } from "../../src/skill/loader"
import { Discovery } from "../../src/skill/discovery"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Config } from "../../src/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { provideInstance, provideTmpdirInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"

const node = LayerNode.compile(CrossSpawnSpawner.node)

const it = testEffect(Layer.mergeAll(LayerNode.compile(Skill.node), node, testInstanceStoreLayer))
const itWithoutClaudeCodeSkills = testEffect(
  Layer.mergeAll(
    LayerNode.compile(Skill.node, [[RuntimeFlags.node, RuntimeFlags.layer({ disableClaudeCodeSkills: true })]]),
    node,
    testInstanceStoreLayer,
  ),
)
const itWithoutExternalSkills = testEffect(
  Layer.mergeAll(
    LayerNode.compile(Skill.node, [[RuntimeFlags.node, RuntimeFlags.layer({ disableExternalSkills: true })]]),
    node,
    testInstanceStoreLayer,
  ),
)

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

const withHome = <A, E, R>(home: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = home
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        process.env.OPENCODE_TEST_HOME = prev
      }),
  )

describe("skill", () => {
  it.effect("formats verbose locations as XML-safe filesystem paths", () =>
    Effect.sync(() => {
      const output = Skill.fmt(
        [
          {
            name: "tagged-skill",
            description: "A tagged skill.",
            location: "/tmp/plugin.git#v1.3.0/SKILL.md",
            content: "",
          },
          {
            name: "built-in-skill",
            description: "A built-in skill.",
            location: "<built-in>",
            content: "",
          },
        ],
        { verbose: true },
      )

      expect(output).toContain("<location>/tmp/plugin.git#v1.3.0/SKILL.md</location>")
      expect(output).toContain("<location>&lt;built-in&gt;</location>")
      expect(output).not.toContain("file://")
      expect(output).not.toContain("%23")
    }),
  )

  it.live("discovers skills from .opencode/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "test-skill", "SKILL.md"),
              `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "test-skill")
          expect(item).toBeDefined()
          expect(item!.description).toBe("A test skill for verification.")
          expect(item!.location).toContain(path.join("skill", "test-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("returns skill directories from Skill.dirs", () =>
    provideTmpdirInstance(
      (dir) =>
        withHome(
          dir,
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(
                path.join(dir, ".opencode", "skill", "dir-skill", "SKILL.md"),
                `---
name: dir-skill
description: Skill for dirs test.
---

# Dir Skill
`,
              ),
            )

            const skill = yield* Skill.Service
            const dirs = yield* skill.dirs()
            expect(dirs).toContain(path.join(dir, ".opencode", "skill", "dir-skill"))
            expect(dirs.length).toBe(1)
          }),
        ),
      { git: true },
    ),
  )

  it.live("discovers multiple skills from .opencode/skill/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".opencode", "skill", "skill-one", "SKILL.md"),
                `---
name: skill-one
description: First test skill.
---

# Skill One
`,
              ),
              Bun.write(
                path.join(dir, ".opencode", "skill", "skill-two", "SKILL.md"),
                `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(2)
          expect(list.find((x) => x.name === "skill-one")).toBeDefined()
          expect(list.find((x) => x.name === "skill-two")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("skips skills with missing frontmatter", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "no-frontmatter", "SKILL.md"),
              `# No Frontmatter

Just some content without YAML frontmatter.
`,
            ),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.all()).filter((s) => s.location !== "<built-in>")).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("discovers skills without descriptions", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "manual-skill", "SKILL.md"),
              `---
name: manual-skill
---

# Manual Skill

Instructions here.
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "manual-skill")
          expect(item).toBeDefined()
          expect(item!.description).toBeUndefined()
          expect(Skill.fmt(list, { verbose: false })).toBe("No skills are currently available.")
          expect(Skill.fmt(list, { verbose: true })).toBe("No skills are currently available.")
        }),
      { git: true },
    ),
  )

  it.live("discovers skills from .claude/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
              `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "claude-skill")
          expect(item).toBeDefined()
          expect(item!.location).toContain(path.join(".claude", "skills", "claude-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers global skills from ~/.claude/skills/ directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          yield* Effect.promise(() => createGlobalSkill(tmp.path))
          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
            expect(list.length).toBe(1)
            expect(list[0].name).toBe("global-test-skill")
            expect(list[0].description).toBe("A global skill from ~/.claude/skills for testing.")
            expect(list[0].location).toContain(path.join(".claude", "skills", "global-test-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live("parses skill with type: core frontmatter", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "core-skill", "SKILL.md"),
              `---
name: core-skill
type: core
description: A core skill.
---

# Core Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const item = (yield* skill.all()).find((s) => s.name === "core-skill")
          expect(item).toBeDefined()
          expect(item!.type).toBe("core")
        }),
      { git: true },
    ),
  )

  it.live("parses skill with type: non-core frontmatter", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "noncore-skill", "SKILL.md"),
              `---
name: noncore-skill
type: non-core
description: A non-core skill.
---

# Non-Core Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const item = (yield* skill.all()).find((s) => s.name === "noncore-skill")
          expect(item).toBeDefined()
          expect(item!.type).toBe("non-core")
        }),
      { git: true },
    ),
  )

  it.live("defaults to non-core when type is absent from frontmatter", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "untyped-skill", "SKILL.md"),
              `---
name: untyped-skill
description: A skill without type.
---

# Untyped Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const item = (yield* skill.all()).find((s) => s.name === "untyped-skill")
          expect(item).toBeDefined()
          expect(item!.type).toBe("non-core")
        }),
      { git: true },
    ),
  )

  it.live("defaults to non-core when type has invalid value", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "bad-skill", "SKILL.md"),
              `---
name: bad-skill
type: invalid
description: A skill with bad type.
---

# Bad Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const item = (yield* skill.all()).find((s) => s.name === "bad-skill")
          expect(item).toBeDefined()
          expect(item!.type).toBe("non-core")
        }),
      { git: true },
    ),
  )

  it.live("built-in customize-opencode skill has type: core", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const item = yield* skill.get("customize-opencode")
          expect(item).toBeDefined()
          expect(item!.type).toBe("core")
        }),
      { git: true },
    ),
  )

  it.live("type field does not break skills without frontmatter", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "no-frontmatter", "SKILL.md"),
              `# No Frontmatter

Just content.
`,
            ),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.all()).filter((s) => s.location !== "<built-in>")).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("returns empty array when no skills exist", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          expect((yield* skill.all()).filter((s) => s.location !== "<built-in>")).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("fails with typed error when requiring a missing skill", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const error = yield* Effect.flip(skill.require("missing-skill"))
          expect(error).toBeInstanceOf(Skill.NotFoundError)
          expect(error._tag).toBe("Skill.NotFoundError")
          expect(error.name).toBe("missing-skill")
          expect(error.message).toContain('Skill "missing-skill" not found.')
        }),
      { git: true },
    ),
  )

  it.effect("exposes tagged expected skill failure classes", () =>
    Effect.sync(() => {
      const invalid = new Skill.InvalidError({ path: "/tmp/SKILL.md", message: "Invalid skill frontmatter" })
      const mismatch = new Skill.NameMismatchError({
        path: "/tmp/SKILL.md",
        expected: "expected-skill",
        actual: "actual-skill",
      })

      expect(invalid).toBeInstanceOf(Skill.InvalidError)
      expect(invalid._tag).toBe("SkillInvalidError")
      expect(mismatch).toBeInstanceOf(Skill.NameMismatchError)
      expect(mismatch._tag).toBe("SkillNameMismatchError")
    }),
  )

  it.live("discovers skills from .agents/skills/ directory", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
              `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(1)
          const item = list.find((x) => x.name === "agent-skill")
          expect(item).toBeDefined()
          expect(item!.location).toContain(path.join(".agents", "skills", "agent-skill", "SKILL.md"))
        }),
      { git: true },
    ),
  )

  it.live("discovers global skills from ~/.agents/skills/ directory", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )

      yield* withHome(
        tmp.path,
        Effect.gen(function* () {
          const skillDir = path.join(tmp.path, ".agents", "skills", "global-agent-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: global-agent-skill
description: A global skill from ~/.agents/skills for testing.
---

# Global Agent Skill

This skill is loaded from the global home directory.
`,
            ),
          )

          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
            expect(list.length).toBe(1)
            expect(list[0].name).toBe("global-agent-skill")
            expect(list[0].description).toBe("A global skill from ~/.agents/skills for testing.")
            expect(list[0].location).toContain(path.join(".agents", "skills", "global-agent-skill", "SKILL.md"))
          }).pipe(provideInstance(tmp.path))
        }),
      )
    }),
  )

  it.live("discovers skills from both .claude/skills/ and .agents/skills/", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.length).toBe(2)
          expect(list.find((x) => x.name === "claude-skill")).toBeDefined()
          expect(list.find((x) => x.name === "agent-skill")).toBeDefined()
        }),
      { git: true },
    ),
  )

  itWithoutClaudeCodeSkills.live("skips Claude Code skills when disabled", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.map((s) => s.name)).toEqual(["agent-skill"])
        }),
      { git: true },
    ),
  )

  itWithoutExternalSkills.live("skips external skill directories when disabled", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
              Bun.write(
                path.join(dir, ".opencode", "skill", "opencode-skill", "SKILL.md"),
                `---
name: opencode-skill
description: A skill in the .opencode/skill directory.
---

# OpenCode Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const list = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(list.map((s) => s.name)).toEqual(["opencode-skill"])
        }),
      { git: true },
    ),
  )

  it.live("properly resolves directories that skills live in", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".claude", "skills", "claude-skill", "SKILL.md"),
                `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
              ),
              Bun.write(
                path.join(dir, ".agents", "skills", "agent-skill", "SKILL.md"),
                `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
              ),
              Bun.write(
                path.join(dir, ".opencode", "skill", "agent-skill", "SKILL.md"),
                `---
name: opencode-skill
description: A skill in the .opencode/skill directory.
---

# OpenCode Skill
`,
              ),
              Bun.write(
                path.join(dir, ".opencode", "skills", "agent-skill", "SKILL.md"),
                `---
name: opencode-skill
description: A skill in the .opencode/skills directory.
---

# OpenCode Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          expect((yield* skill.dirs()).length).toBe(4)
        }),
      { git: true },
    ),
  )

  it.live("scanAvailableSkills returns metadata for all skills", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "scan-skill", "SKILL.md"),
              `---
name: scan-skill
type: core
description: A scanned skill.
---

# Scan Skill
`,
            ),
          )

          const metas = yield* scanAvailableSkills()
          const scanSkill = metas.find((m) => m.name === "scan-skill")
          expect(scanSkill).toBeDefined()
          expect(scanSkill!.type).toBe("core")
          expect(scanSkill!.description).toBe("A scanned skill.")
          expect(scanSkill!.loaded).toBe(false)
        }),
      { git: true },
    ),
  )

  it.live("scanAvailableSkills shows loaded status after loadIntoSession", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "loadable", "SKILL.md"),
              `---
name: loadable
type: non-core
description: A loadable skill.
---

# Loadable Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          yield* skill.loadIntoSession("loadable")
          const metas = yield* scanAvailableSkills()
          const loaded = metas.find((m) => m.name === "loadable")
          expect(loaded).toBeDefined()
          expect(loaded!.loaded).toBe(true)
        }),
      { git: true },
    ),
  )

  it.live("loadIntoSession is idempotent (duplicate load is no-op)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "dup-skill", "SKILL.md"),
              `---
name: dup-skill
description: A duplicate skill.
---

# Dup Skill
`,
            ),
          )

          const skill = yield* Skill.Service
          const first = yield* skill.loadIntoSession("dup-skill")
          const second = yield* skill.loadIntoSession("dup-skill")
          expect(first).toBe(second)
        }),
      { git: true },
    ),
  )

  it.live("loadSkillContent returns skill content without marking as loaded", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(
              path.join(dir, ".opencode", "skill", "preview-skill", "SKILL.md"),
              `---
name: preview-skill
description: A skill for preview.
---

# Preview Skill
`,
            ),
          )

          const content = yield* loadSkillContent("preview-skill")
          expect(content).toContain("# Preview Skill")

          const skill = yield* Skill.Service
          const loaded = yield* skill.isLoaded("preview-skill")
          expect(loaded).toBe(false)
        }),
      { git: true },
    ),
  )
})

describe("bundle-aware skill filtering", () => {
  it.live("filters sub-skills from available() but keeps bundle and standalone", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".opencode", "skill", "bundle", "SKILL.md"),
                `---
name: bundle
type: core
description: A bundle dispatcher.
---

# Bundle
`,
              ),
              Bun.write(
                path.join(dir, ".opencode", "skill", "bundle", "sub-skill", "SKILL.md"),
                `---
name: sub-skill
type: non-core
description: A sub-skill inside a bundle.
---

# Sub Skill
`,
              ),
              Bun.write(
                path.join(dir, ".opencode", "skill", "standalone", "SKILL.md"),
                `---
name: standalone
type: non-core
description: A standalone top-level skill.
---

# Standalone
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const avail = (yield* skill.available()).filter((s) => s.location !== "<built-in>")
          expect(avail.find((s) => s.name === "bundle")).toBeDefined()
          expect(avail.find((s) => s.name === "sub-skill")).toBeUndefined()
          expect(avail.find((s) => s.name === "standalone")).toBeDefined()

          const metas = yield* scanAvailableSkills()
          expect(metas.find((m) => m.name === "bundle")).toBeDefined()
          expect(metas.find((m) => m.name === "sub-skill")).toBeUndefined()
          expect(metas.find((m) => m.name === "standalone")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("all() returns full list including sub-skills", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".opencode", "skill", "bundle", "SKILL.md"),
                `---
name: bundle
type: core
description: A bundle dispatcher.
---

# Bundle
`,
              ),
              Bun.write(
                path.join(dir, ".opencode", "skill", "bundle", "sub-skill", "SKILL.md"),
                `---
name: sub-skill
type: non-core
description: A sub-skill inside a bundle.
---

# Sub Skill
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const all = (yield* skill.all()).filter((s) => s.location !== "<built-in>")
          expect(all.length).toBe(2)
          expect(all.find((s) => s.name === "bundle")).toBeDefined()
          expect(all.find((s) => s.name === "sub-skill")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("require() works for sub-skills by name", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".opencode", "skill", "bundle", "SKILL.md"),
                `---
name: bundle
type: core
description: A bundle dispatcher.
---

# Bundle
`,
              ),
              Bun.write(
                path.join(dir, ".opencode", "skill", "bundle", "sub-skill", "SKILL.md"),
                `---
name: sub-skill
type: non-core
description: A sub-skill inside a bundle.
---

# Sub Skill Content
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service
          const info = yield* skill.require("sub-skill")
          expect(info.name).toBe("sub-skill")
          expect(info.content).toContain("Sub Skill Content")
        }),
      { git: true },
    ),
  )

  it.live("loadIntoSession works for sub-skills excluded from available()", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".opencode", "skill", "bundle", "SKILL.md"),
                `---
name: bundle
type: core
description: A bundle dispatcher.
---

# Bundle
`,
              ),
              Bun.write(
                path.join(dir, ".opencode", "skill", "bundle", "sub-skill", "SKILL.md"),
                `---
name: sub-skill
type: non-core
description: A sub-skill inside a bundle.
---

# Sub Skill Content
`,
              ),
            ]),
          )

          const skill = yield* Skill.Service

          const avail = (yield* skill.available()).filter((s) => s.location !== "<built-in>")
          expect(avail.find((s) => s.name === "sub-skill")).toBeUndefined()

          const content = yield* skill.loadIntoSession("sub-skill")
          expect(content).toContain("Sub Skill Content")

          const loaded = yield* skill.isLoaded("sub-skill")
          expect(loaded).toBe(true)
        }),
      { git: true },
    ),
  )
})
