import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Config } from "../../src/config/config"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    type: "non-core",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    type: "core",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    type: "non-core",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    type: "non-core",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

function makeLayer(skillsConfig?: { autoLoad?: "all" | "core" | "none" }) {
  const configInfo = skillsConfig ? { skills: skillsConfig } : {}
  return LayerNode.compile(SystemPrompt.node, [
    [MCP.node, Layer.mock(MCP.Service, {
      instructions: () =>
        Effect.succeed([
          {
            name: "guide-server",
            instructions: "Use lookup before mutate.",
            tools: [],
          },
          {
            name: "tool-server",
            instructions: "Prefer search before update.",
            tools: ["tool-server_search", "tool-server_update"],
          },
        ]),
    })],
    [Skill.node, Layer.succeed(
      Skill.Service,
      Skill.Service.of({
        get: (name) => Effect.succeed(skills.find((s) => s.name === name)),
        require: (name) => {
          const info = skills.find((s) => s.name === name)
          if (info) return Effect.succeed(info)
          return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((s) => s.name) }))
        },
        all: () => Effect.succeed(skills),
        dirs: () => Effect.succeed([]),
        available: () => Effect.succeed(skills),
        loadIntoSession: () => Effect.succeed(""),
        isLoaded: () => Effect.succeed(false),
        installFromDirectory: () => Effect.die("unimplemented"),
        installFromGitHub: () => Effect.die("unimplemented"),
      }),
    )],
    [Config.node, Layer.succeed(
      Config.Service,
      Config.Service.of({
        get: () => Effect.succeed(configInfo),
        getGlobal: () => Effect.succeed({}),
        getConsoleState: () => Effect.succeed({ consoleManagedProviders: [], activeOrgName: undefined, switchableOrgCount: 0 }),
        update: () => Effect.void,
        updateGlobal: () => Effect.succeed({ info: {}, changed: false }),
        invalidate: () => Effect.void,
        directories: () => Effect.succeed([]),
        waitForDependencies: () => Effect.void,
      }),
    )],
    [LocationServiceMap.node, locationServiceMapLayer],
  ])
}

const it = testEffect(makeLayer())
const itCore = testEffect(makeLayer({ autoLoad: "core" }))
const itNone = testEffect(makeLayer({ autoLoad: "none" }))

describe("session.system", () => {
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    for (const id of ["meta/muse-spark-preview", "muse-spark-1.1", "muse-spark-1.2"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Spark,")
      expect(prompt).toContain("using Meta Muse Spark.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Meta prompt for Muse Glimmer model IDs", () => {
    for (const id of ["meta/muse-glimmer", "meta/muse-glimmer-30b", "muse-glimmer-30b"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Glimmer,")
      expect(prompt).toContain("using Meta Muse Glimmer.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Kimi prompt for official provider model IDs", () => {
    for (const providerID of ["kimi-for-coding", "moonshotai", "moonshotai-cn"]) {
      const prompt = SystemPrompt.provider({ providerID, api: { id: "k3" } } as Provider.Model)[0]
      expect(prompt).toContain("# Prompt and Tool Use")
    }
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("autoLoad all includes all skills with descriptions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = (yield* prompt.skills(build))!
      expect(output).toContain("<name>alpha-skill</name>")
      expect(output).toContain("<name>middle-skill</name>")
      expect(output).toContain("<name>zeta-skill</name>")
      expect(output).not.toContain("<name>manual-skill</name>")
    }),
  )

  itCore.effect("autoLoad core includes only core-tagged skills", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = (yield* prompt.skills(build))!
      expect(output).toContain("<name>alpha-skill</name>")
      expect(output).not.toContain("<name>middle-skill</name>")
      expect(output).not.toContain("<name>zeta-skill</name>")
    }),
  )

  itCore.effect("autoLoad core returns undefined when no core skills match agent", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.skills({ ...build, permission: Permission.fromConfig({ "*": "deny" }) })
      expect(output).toBeUndefined()
    }),
  )

  itNone.effect("autoLoad none includes no skills", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = (yield* prompt.skills(build))!
      expect(output).not.toContain("<name>")
      expect(output).toContain("No skills are currently available.")
    }),
  )

  it.effect("autoLoad missing config defaults to all", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = (yield* prompt.skills(build))!
      expect(output).toContain("<name>alpha-skill</name>")
      expect(output).toContain("<name>middle-skill</name>")
      expect(output).toContain("<name>zeta-skill</name>")
    }),
  )
})
