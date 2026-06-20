import path from "path"
import fs from "fs/promises"
import { Effect, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"

export class InstallError extends Schema.TaggedErrorClass<InstallError>()("SkillInstallError", {
  url: Schema.String,
  message: Schema.String,
}) {}

export class InvalidStructureError extends Schema.TaggedErrorClass<InvalidStructureError>()(
  "SkillInvalidStructureError",
  { url: Schema.String, message: Schema.String, detail: Schema.String },
) {}

export interface InstallResult {
  name: string
  type: "core" | "non-core"
  location: string
  isBundle: boolean
  subSkills: string[]
}

interface ParsedFrontmatter {
  name: string | undefined
  description: string | undefined
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith("---")) return { name: undefined, description: undefined }
  const endIdx = trimmed.indexOf("---", 3)
  if (endIdx === -1) return { name: undefined, description: undefined }
  const block = trimmed.slice(3, endIdx)
  let name: string | undefined
  let description: string | undefined
  for (const line of block.split("\n")) {
    const nMatch = line.match(/^name:\s*(.+)/)
    if (nMatch) name = nMatch[1].trim()
    const dMatch = line.match(/^description:\s*(.+)/)
    if (dMatch) description = dMatch[1].trim()
  }
  return { name, description }
}

interface StructureDetect {
  isBundle: boolean
  name: string
  rootMd: string
  description: string | undefined
  subNames: string[]
}

const detectSingle = Effect.fnUntraced(function* (repoDir: string, mdPath: string) {
  const raw = yield* Effect.promise(() => fs.readFile(mdPath, "utf-8"))
  const fm = parseFrontmatter(raw)
  return {
    isBundle: false as const,
    name: fm.name ?? path.basename(repoDir),
    rootMd: mdPath,
    description: fm.description,
    subNames: [] as string[],
  }
})

const detectBundle = Effect.fnUntraced(function* (repoDir: string, rootMd: string, subMds: string[]) {
  const raw = yield* Effect.promise(() => fs.readFile(rootMd, "utf-8").catch(() => ""))
  const fm = raw ? parseFrontmatter(raw) : { name: undefined, description: undefined }
  const name = fm.name ?? path.basename(repoDir)
  const subNames: string[] = []
  for (const sm of subMds) {
    const rawSub = yield* Effect.promise(() => fs.readFile(sm, "utf-8").catch(() => ""))
    if (rawSub) {
      const subFm = parseFrontmatter(rawSub)
      if (subFm.name) subNames.push(subFm.name)
    }
  }
  return { isBundle: true as const, name, rootMd, description: fm.description, subNames }
})

const detectStructure = Effect.fnUntraced(function* (repoDir: string) {
  const entries = yield* Effect.promise(() => fs.readdir(repoDir, { withFileTypes: true }))
  const rootSkillMds = entries
    .filter((e) => e.isFile() && e.name === "SKILL.md")
    .map((e) => path.join(repoDir, e.name))
  const subDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."))
  const subMds: string[] = []
  for (const dir of subDirs) {
    const candidate = path.join(repoDir, dir.name, "SKILL.md")
    const exists = yield* Effect.promise(() => fs.stat(candidate).then(() => true).catch(() => false))
    if (exists) subMds.push(candidate)
  }
  if (rootSkillMds.length === 0 && subMds.length === 0) {
    return yield* new InvalidStructureError({
      url: repoDir,
      message: "No SKILL.md found. Skills must have a SKILL.md file at the repo root.",
      detail: "A skill repo must contain at least a top-level SKILL.md file.",
    })
  }
  if (rootSkillMds.length === 0 && subMds.length > 0) {
    return yield* new InvalidStructureError({
      url: repoDir,
      message: "Bundle repo has no dispatcher SKILL.md at the root.",
      detail: "A bundle repo must have a dispatcher SKILL.md at the top level.",
    })
  }
  const rootMd = rootSkillMds[0]
  if (subMds.length > 0) {
    return yield* detectBundle(repoDir, rootMd, subMds)
  }
  return yield* detectSingle(repoDir, rootMd)
})

const ensureFrontmatter = Effect.fnUntraced(function* (targetMd: string, name: string, skillType: "core" | "non-core") {
  let raw = yield* Effect.promise(() => fs.readFile(targetMd, "utf-8").catch(() => ""))
  const hasFrontmatter = raw.trimStart().startsWith("---")
  if (hasFrontmatter) {
    const lines = raw.split("\n")
    let endIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && lines[i].trim() === "---") { endIdx = i; break }
    }
    if (endIdx > 0) {
      const frontmatter = lines.slice(1, endIdx)
      const body = lines.slice(endIdx + 1).join("\n")
      const newFrontmatter = frontmatter
        .filter((l) => !/^name:\s*/.test(l))
        .filter((l) => !/^type:\s*/.test(l))
      newFrontmatter.unshift(`name: ${name}`)
      newFrontmatter.push(`type: ${skillType}`)
      raw = "---\n" + newFrontmatter.join("\n") + "\n---\n" + body.trimStart()
    }
  } else {
    raw = `---\nname: ${name}\ntype: ${skillType}\n---\n${raw.trimStart()}`
  }
  yield* Effect.promise(() => fs.writeFile(targetMd, raw, "utf-8"))
})

function generateDispatcherContent(name: string, subNames: string[]): string {
  const tableRows = subNames.map((s) => `| ${s} | Sub-skill in ${name} | ${s}/SKILL.md |`).join("\n")
  return [
    "---",
    `name: ${name}`,
    `type: non-core`,
    `description: Bundle of ${subNames.length} skills. Auto-selects for task.`,
    "---",
    "",
    `# ${name}`,
    "",
    "| name | description | path |",
    "|---|---|---|",
    tableRows,
    "",
    "Read task → select relevant sub-skill → read its SKILL.md → apply.",
  ].join("\n")
}

export function installFromDirectory(
  srcPath: string,
  services: { fsys: FSUtil.Interface; global: Global.Interface },
  opts: { name?: string; type?: "core" | "non-core"; overwrite?: boolean } = {},
): Effect.Effect<InstallResult, InstallError | InvalidStructureError> {
  const { fsys, global } = services
  return Effect.gen(function* () {
    const structure = yield* detectStructure(srcPath)
    const name = opts.name ?? structure.name
    const skillType = opts.type ?? "non-core"
    const targetDir = path.join(global.home, ".opencode", "skills", name)

    const exists = yield* fsys.exists(targetDir).pipe(Effect.orDie)
    if (exists && !opts.overwrite) {
      return yield* new InstallError({
        url: srcPath,
        message: `Target directory already exists: ${targetDir}. Pass overwrite: true to replace.`,
      })
    }
    if (exists && opts.overwrite) {
      yield* Effect.promise(() => fs.rm(targetDir, { recursive: true, force: true }))
    }

    yield* Effect.promise(() => fs.mkdir(targetDir, { recursive: true }))

    const subSkills = structure.isBundle ? [...structure.subNames] : []
    if (structure.isBundle) {
      const dispatcherContent = generateDispatcherContent(name, structure.subNames)
      yield* Effect.promise(() => fs.writeFile(path.join(targetDir, "SKILL.md"), dispatcherContent, "utf-8"))
      const entries = yield* Effect.promise(() => fs.readdir(srcPath, { withFileTypes: true }))
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          yield* Effect.promise(() =>
            fs.cp(path.join(srcPath, entry.name), path.join(targetDir, entry.name), { recursive: true }),
          )
        }
      }
    } else {
      const content = yield* Effect.promise(() => fs.readFile(structure.rootMd, "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(targetDir, "SKILL.md"), content, "utf-8"))
    }

    yield* ensureFrontmatter(path.join(targetDir, "SKILL.md"), name, skillType)

    return { name, type: skillType, location: targetDir, isBundle: structure.isBundle, subSkills } as InstallResult
  })
}

export function installFromGitHub(
  url: string,
  services: { fsys: FSUtil.Interface; global: Global.Interface },
  opts: { name?: string; type?: "core" | "non-core"; overwrite?: boolean } = {},
): Effect.Effect<InstallResult, InstallError | InvalidStructureError> {
  const { fsys, global } = services
  return Effect.gen(function* () {
    const repoName = url.replace(/\.git$/, "").split("/").pop()
    if (!repoName) {
      return yield* new InstallError({ url, message: `Could not determine repo name from URL: ${url}` })
    }
    const tmpDir = path.join(global.tmp, `skill-install-${repoName}-${Date.now()}`)
    const finalName = opts.name ?? repoName

    yield* Effect.tryPromise({
      try: () =>
        fs.mkdir(tmpDir, { recursive: true }).then(() => {
          const { execSync } = require("child_process") as { execSync: (cmd: string, opts: object) => Buffer }
          execSync(`git clone --depth=1 "${url}" "${tmpDir}"`, { stdio: "pipe", timeout: 60000 })
        }),
      catch: (err) => {
        fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        return new InstallError({
          url,
          message: `Failed to clone repository: ${err instanceof Error ? err.message : String(err)}`,
        })
      },
    })

    const result = yield* installFromDirectory(tmpDir, services, { name: finalName, type: opts.type, overwrite: opts.overwrite }).pipe(
      Effect.catch((err) => {
        fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        return Effect.fail(err as InstallError | InvalidStructureError)
      }),
    )

    yield* Effect.promise(() => fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}))

    return result
  })
}

export * as Installer from "./installer"
