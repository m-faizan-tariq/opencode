import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Installer } from "../../src/skill/installer"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Global.node])))

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

describe("installer", () => {
  it.live("installFromDirectory copies a single skill to ~/.opencode/skills", () =>
    withHome(
      "",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        process.env.OPENCODE_TEST_HOME = tmp.path

        const fsys = yield* FSUtil.Service
        const global = yield* Global.Service

        const srcDir = path.join(tmp.path, "src-skill")
        yield* Effect.promise(() =>
          fs.mkdir(srcDir, { recursive: true }).then(() =>
            Bun.write(
              path.join(srcDir, "SKILL.md"),
              `---
name: test-skill
description: A test skill for install.
---

# Test Skill

Content here.
`,
            ),
          ),
        )

        const result = yield* Installer.installFromDirectory(srcDir, { fsys, global })

        expect(result.name).toBe("test-skill")
        expect(result.type).toBe("non-core")
        expect(result.location).toContain(path.join(".opencode", "skills", "test-skill"))
        expect(result.isBundle).toBe(false)
        expect(result.subSkills).toEqual([])

        const installed = yield* Effect.promise(() =>
          Bun.file(path.join(global.home, ".opencode", "skills", "test-skill", "SKILL.md")).text(),
        )
        expect(installed).toContain("name: test-skill")
        expect(installed).toContain("type: non-core")
        expect(installed).toContain("Test Skill")
      }),
    ),
  )

  it.live("installFromDirectory adds type: non-core to frontmatter if absent", () =>
    withHome(
      "",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        process.env.OPENCODE_TEST_HOME = tmp.path

        const fsys = yield* FSUtil.Service
        const global = yield* Global.Service

        const srcDir = path.join(tmp.path, "untyped-skill")
        yield* Effect.promise(() =>
          fs.mkdir(srcDir, { recursive: true }).then(() =>
            Bun.write(
              path.join(srcDir, "SKILL.md"),
              `---
name: untyped-skill
---

# Untyped Skill
`,
            ),
          ),
        )

        yield* Installer.installFromDirectory(srcDir, { fsys, global })

        const installed = yield* Effect.promise(() =>
          Bun.file(path.join(global.home, ".opencode", "skills", "untyped-skill", "SKILL.md")).text(),
        )
        expect(installed).toContain("type: non-core")
      }),
    ),
  )

  it.live("installFromDirectory respects type override", () =>
    withHome(
      "",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        process.env.OPENCODE_TEST_HOME = tmp.path

        const fsys = yield* FSUtil.Service
        const global = yield* Global.Service

        const srcDir = path.join(tmp.path, "core-skill")
        yield* Effect.promise(() =>
          fs.mkdir(srcDir, { recursive: true }).then(() =>
            Bun.write(
              path.join(srcDir, "SKILL.md"),
              `---
name: core-skill
---

# Core Skill
`,
            ),
          ),
        )

        const result = yield* Installer.installFromDirectory(srcDir, { fsys, global }, { type: "core" })

        expect(result.type).toBe("core")

        const installed = yield* Effect.promise(() =>
          Bun.file(path.join(global.home, ".opencode", "skills", "core-skill", "SKILL.md")).text(),
        )
        expect(installed).toContain("type: core")
      }),
    ),
  )

  it.live("installFromDirectory fails when target already exists without overwrite", () =>
    withHome(
      "",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        process.env.OPENCODE_TEST_HOME = tmp.path

        const fsys = yield* FSUtil.Service
        const global = yield* Global.Service

        yield* Effect.promise(() =>
          fs.mkdir(path.join(global.home, ".opencode", "skills", "existing-skill"), { recursive: true }),
        )

        const srcDir = path.join(tmp.path, "existing-skill")
        yield* Effect.promise(() =>
          fs.mkdir(srcDir, { recursive: true }).then(() =>
            Bun.write(
              path.join(srcDir, "SKILL.md"),
              `---
name: existing-skill
---

# Existing Skill
`,
            ),
          ),
        )

        const error = yield* Effect.flip(
          Installer.installFromDirectory(srcDir, { fsys, global }),
        )

        expect(error._tag).toBe("SkillInstallError")
        expect(error.message).toContain("already exists")
      }),
    ),
  )

  it.live("installFromDirectory overwrites when opts.overwrite is true", () =>
    withHome(
      "",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        process.env.OPENCODE_TEST_HOME = tmp.path

        const fsys = yield* FSUtil.Service
        const global = yield* Global.Service

        const targetDir = path.join(global.home, ".opencode", "skills", "overwrite-skill")
        yield* Effect.promise(() =>
          fs.mkdir(targetDir, { recursive: true }).then(() =>
            Bun.write(path.join(targetDir, "SKILL.md"), "old content"),
          ),
        )

        const srcDir = path.join(tmp.path, "overwrite-skill")
        yield* Effect.promise(() =>
          fs.mkdir(srcDir, { recursive: true }).then(() =>
            Bun.write(
              path.join(srcDir, "SKILL.md"),
              `---
name: overwrite-skill
---

# New Content
`,
            ),
          ),
        )

        yield* Installer.installFromDirectory(srcDir, { fsys, global }, { overwrite: true })

        const installed = yield* Effect.promise(() => Bun.file(path.join(targetDir, "SKILL.md")).text())
        expect(installed).toContain("New Content")
        expect(installed).not.toContain("old content")
      }),
    ),
  )

  it.live("installFromDirectory supports name override", () =>
    withHome(
      "",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        process.env.OPENCODE_TEST_HOME = tmp.path

        const fsys = yield* FSUtil.Service
        const global = yield* Global.Service

        const srcDir = path.join(tmp.path, "renamed-skill")
        yield* Effect.promise(() =>
          fs.mkdir(srcDir, { recursive: true }).then(() =>
            Bun.write(
              path.join(srcDir, "SKILL.md"),
              `---
name: original-name
---

# Skill
`,
            ),
          ),
        )

        const result = yield* Installer.installFromDirectory(srcDir, { fsys, global }, { name: "custom-name" })

        expect(result.name).toBe("custom-name")
        expect(result.location).toContain(path.join(".opencode", "skills", "custom-name"))

        const installed = yield* Effect.promise(() =>
          Bun.file(path.join(global.home, ".opencode", "skills", "custom-name", "SKILL.md")).text(),
        )
        expect(installed).toContain("name: custom-name")
      }),
    ),
  )

  it.live("installFromDirectory installs a bundle with sub-skills", () =>
    withHome(
      "",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        process.env.OPENCODE_TEST_HOME = tmp.path

        const fsys = yield* FSUtil.Service
        const global = yield* Global.Service

        const bundleDir = path.join(tmp.path, "my-bundle")
        yield* Effect.promise(() =>
          fs.mkdir(path.join(bundleDir, "sub-a"), { recursive: true }).then(() =>
            Promise.all([
              Bun.write(
                path.join(bundleDir, "SKILL.md"),
                `---
name: my-bundle
description: A bundle with sub-skills.
---

# My Bundle
`,
              ),
              Bun.write(
                path.join(bundleDir, "sub-a", "SKILL.md"),
                `---
name: sub-a
description: Sub-skill A.
---

# Sub A
`,
              ),
              Bun.write(
                path.join(bundleDir, "sub-a", "script.ts"),
                "export const foo = 1",
              ),
              fs.mkdir(path.join(bundleDir, "sub-b"), { recursive: true }).then(() =>
                Bun.write(
                  path.join(bundleDir, "sub-b", "SKILL.md"),
                  `---
name: sub-b
description: Sub-skill B.
---

# Sub B
`,
                ),
              ),
            ]),
          ),
        )

        const result = yield* Installer.installFromDirectory(bundleDir, { fsys, global })

        expect(result.name).toBe("my-bundle")
        expect(result.isBundle).toBe(true)
        expect(result.subSkills.sort()).toEqual(["sub-a", "sub-b"])

        const targetBase = path.join(global.home, ".opencode", "skills", "my-bundle")
        const dispatcherContent = yield* Effect.promise(() => Bun.file(path.join(targetBase, "SKILL.md")).text())
        expect(dispatcherContent).toContain("name: my-bundle")
        expect(dispatcherContent).toContain("type: non-core")
        expect(dispatcherContent).toContain("| sub-a |")
        expect(dispatcherContent).toContain("| sub-b |")

        const subAContent = yield* Effect.promise(() => Bun.file(path.join(targetBase, "sub-a", "SKILL.md")).text())
        expect(subAContent).toContain("name: sub-a")

        const subBContent = yield* Effect.promise(() => Bun.file(path.join(targetBase, "sub-b", "SKILL.md")).text())
        expect(subBContent).toContain("name: sub-b")

        const scriptExists = yield* Effect.promise(() =>
          Bun.file(path.join(targetBase, "sub-a", "script.ts")).exists(),
        )
        expect(scriptExists).toBe(true)
      }),
    ),
  )

  it.live("installFromDirectory fails on directory without a root SKILL.md", () =>
    withHome(
      "",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        process.env.OPENCODE_TEST_HOME = tmp.path

        const fsys = yield* FSUtil.Service
        const global = yield* Global.Service

        const srcDir = path.join(tmp.path, "no-skill-dir")
        yield* Effect.promise(() => fs.mkdir(srcDir, { recursive: true }))

        const error = yield* Effect.flip(
          Installer.installFromDirectory(srcDir, { fsys, global }),
        )

        expect(error._tag).toBe("SkillInvalidStructureError")
      }),
    ),
  )

  it.live("installFromGitHub fails with invalid URL", () =>
    withHome(
      "",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        process.env.OPENCODE_TEST_HOME = tmp.path

        const fsys = yield* FSUtil.Service
        const global = yield* Global.Service

        const error = yield* Effect.flip(
          Installer.installFromGitHub("not-a-url", { fsys, global }),
        )

        expect(error._tag).toBe("SkillInstallError")
      }),
    ),
  )
})
