// Reads: packages/adapters/ai/openai/**
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packageRecipeFile } from '../../packages/cli/src/recipes/holders.js'
import type { SpecRecipe as Recipe } from '../../packages/cli/src/recipes/fixtures/linked-project.js'
import { ROOT as REPO_ROOT } from './adapter-table'

// AC-5: @nymbalhq/ai-openai publishes the recipe `nymbal add ai openai` reads, as the adapter packages with a recipe
// do: `recipes` in `files` and `./recipes/*` exported, so a project that installs the package resolves
// `@nymbalhq/ai-openai/recipes/openai.json` through its exports. The recipe sets commerce.ai alone, installs the
// package, and lists OPENAI_API_KEY as optional exactly when the package's own setting is.

const OPENAI = { dir: 'packages/adapters/ai/openai', name: '@nymbalhq/ai-openai' }
const RECIPE = join(REPO_ROOT, OPENAI.dir, 'recipes', 'openai.json')

interface OpenAiManifest {
  files?: unknown
  exports?: Record<string, unknown>
}

interface Setting {
  path: string
  env?: string
  optional?: boolean
  optionalWith?: string
}

function manifest(): OpenAiManifest {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, OPENAI.dir, 'package.json'), 'utf8'),
  ) as OpenAiManifest
}

function recipe(): Recipe {
  expect(existsSync(RECIPE), RECIPE).toBe(true)
  return JSON.parse(readFileSync(RECIPE, 'utf8')) as Recipe
}

describe('AC-5: @nymbalhq/ai-openai ships the openai recipe', () => {
  it('AC-5: its files hold dist and recipes, it exports ./recipes/*, and a project that installs it resolves recipes/openai.json to the file in the package', () => {
    const m = manifest()
    const files = (Array.isArray(m.files) ? (m.files as string[]) : []).map((f) =>
      f.replace(/^\.\//, '').replace(/\/$/, ''),
    )
    // The kernel links every first-party adapter into its node_modules, as a project's install does.
    const project = join(REPO_ROOT, 'packages', 'platform')

    expect(['dist', 'recipes'].filter((f) => !files.includes(f))).toEqual([])
    expect(m.exports?.['./recipes/*']).toBe('./recipes/*')
    expect(packageRecipeFile(OPENAI.name, 'openai', project)).toBe(RECIPE)
  })

  it("AC-5: recipes/openai.json is the openai recipe: it sets commerce.ai to { provider: 'openai' } and nothing else, installs the package, and its next lines name commerce.ai.config.model and baseUrl", () => {
    const r = recipe()

    expect(r.name).toBe('openai')
    expect(r.set).toEqual([{ path: 'commerce.ai', value: { provider: 'openai' } }])
    expect(r.install).toEqual([OPENAI.name])
    expect(r.next.filter((l) => l.includes('commerce.ai.config.model'))).toHaveLength(1)
    expect(r.next.filter((l) => /\bbaseUrl\b/.test(l))).toHaveLength(1)
  })

  it("AC-5: the recipe lists each variable the package's settings read once, required exactly when the setting is neither optional nor optional with another setting", async () => {
    const mod = (await import(join(REPO_ROOT, OPENAI.dir, 'src/index.ts'))) as {
      settings: Setting[]
    }
    const fromEnv = mod.settings.filter((s) => s.env !== undefined)
    const r = recipe()

    expect(r.env.map((v) => [v.name, v.required])).toEqual(
      fromEnv.map((s) => [s.env, s.optional !== true && s.optionalWith === undefined]),
    )
  })
})
