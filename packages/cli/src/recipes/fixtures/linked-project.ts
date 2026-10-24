import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Shared by the recipe tests: a project outside the workspace that resolves the built @nymbalhq packages and the
// provider SDKs through node_modules symlinks, and a byte-level listing of a project's files to diff before and after
// a command.

/**
 * The `Recipe` and `RecipeValue` shapes, as the tests use them.
 * tests/architecture/recipe-type.test-d.ts holds the exported types to these, both ways.
 */
export type SpecRecipeValue =
  | string
  | boolean
  | number
  | { env: string; default?: string }
  | { [k: string]: SpecRecipeValue }

export interface SpecRecipe {
  name: string
  summary: string
  install: string[]
  set: Array<{ path: string; value: SpecRecipeValue }>
  env: Array<{ name: string; example: string; required: boolean; comment: string }>
  next: string[]
}

export const REPO = fileURLToPath(new URL('../../../../../', import.meta.url))

/** The recipes and the package that ships each one. */
export const SPEC_HOLDERS: Readonly<Record<string, string>> = {
  cloudflare: '@nymbalhq/security-cloudflare',
  postgres: '@nymbalhq/platform',
  redis: '@nymbalhq/doc-store-redis',
  s3: '@nymbalhq/media-s3',
  stripe: '@nymbalhq/adapter-stripe',
}
export const RECIPE_NAMES = Object.keys(SPEC_HOLDERS).sort()

/** The workspace packages a scaffolded project resolves, by name, and the directory each is built in. */
const NYMBAL_PACKAGES: Readonly<Record<string, string>> = {
  '@nymbalhq/config': 'packages/config',
  '@nymbalhq/types': 'packages/types',
  '@nymbalhq/platform': 'packages/platform',
  '@nymbalhq/doc-store-redis': 'packages/doc-store-redis',
  '@nymbalhq/event-bus-redis-streams': 'packages/event-bus-redis-streams',
  '@nymbalhq/media-s3': 'packages/media-s3',
  '@nymbalhq/adapter-stripe': 'packages/adapter-stripe',
  '@nymbalhq/security-cloudflare': 'packages/security-cloudflare',
}

/** The SDKs the recipes install, and the workspace package whose node_modules already holds each. */
const SDK_HOMES: Readonly<Record<string, string>> = {
  ioredis: 'packages/doc-store-redis',
  stripe: 'packages/adapter-stripe',
  '@aws-sdk/client-s3': 'packages/media-s3',
}

export function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `nymbal-recipes-${label}-`))
}

/**
 * Links every package above into `<dir>/node_modules` except those named in `omit`, so Node resolution from `dir`
 * finds the built workspace copies.
 */
export function linkPackages(dir: string, omit: readonly string[] = []): void {
  const targets: Array<[string, string]> = [
    ...Object.entries(NYMBAL_PACKAGES).map(([name, d]): [string, string] => [name, join(REPO, d)]),
    ...Object.entries(SDK_HOMES).map(([name, home]): [string, string] => [
      name,
      realpathSync(join(REPO, home, 'node_modules', name)),
    ]),
  ]
  for (const [name, target] of targets) {
    if (omit.includes(name)) continue
    const link = join(dir, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link, 'dir')
  }
}

/** An empty project (a package.json and nothing else) with the packages linked. */
export function linkedProject(label: string, omit: readonly string[] = []): string {
  const dir = tempDir(label)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `recipes-${label}`, private: true, type: 'module' }, null, 2),
  )
  linkPackages(dir, omit)
  return dir
}

/** Copies a project without its node_modules, then links the packages into the copy. */
export function copyProject(from: string, label: string, omit: readonly string[] = []): string {
  const dir = tempDir(label)
  cpSync(from, dir, {
    recursive: true,
    filter: (src) => !relative(from, src).split(/[\\/]/).includes('node_modules'),
  })
  linkPackages(dir, omit)
  return dir
}

/** Every file under `dir` but node_modules, relative path to the sha256 of its bytes. */
export function listing(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      if (entry === 'node_modules') continue
      const full = join(at, entry)
      if (statSync(full).isDirectory()) walk(full)
      else
        out.set(relative(dir, full), createHash('sha256').update(readFileSync(full)).digest('hex'))
    }
  }
  walk(dir)
  return out
}

/** The paths added, removed or rewritten between two listings, sorted. */
export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter((p) => before.get(p) !== after.get(p)).sort()
}

export function removeAll(dirs: string[]): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}
