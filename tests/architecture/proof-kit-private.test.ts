// Reads: pnpm-workspace.yaml, **/package.json, **/src/**
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, trackedFiles, workspaceMembers } from './workspace-manifests'

// AC-17: @nymbalhq/proof-kit (the test-only finalise hook, chaos wrapper and mail sink) is private, and nothing that
// ships can reach it: no src/ file of another workspace member imports it (by name or by a relative path into
// packages/proof-kit), and no member lists it outside devDependencies.

const KIT_DIR = 'packages/proof-kit'
const KIT_NAME = '@nymbalhq/proof-kit'
const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

const SPECIFIER =
  /\b(?:import|export)\b[^'"`]*?from\s*['"`]([^'"`]+)['"`]|\bimport\s*['"`]([^'"`]+)['"`]|\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g

/** Every module specifier in a source text, with the 1-based line it starts on. */
function specifiers(source: string): Array<{ specifier: string; line: number }> {
  return [...source.matchAll(SPECIFIER)].map((m) => ({
    specifier: (m[1] ?? m[2] ?? m[3] ?? m[4])!,
    line: source.slice(0, m.index).split('\n').length,
  }))
}

const TEST_FILE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|astro|vue|svelte)$/

/** True when `specifier`, written in `file` (repo-relative), names the kit or resolves into its directory. */
function reachesKit(file: string, specifier: string): boolean {
  if (specifier === KIT_NAME || specifier.startsWith(`${KIT_NAME}/`)) return true
  if (!specifier.startsWith('.')) return false
  const target = relative(REPO_ROOT, resolve(REPO_ROOT, dirname(file), specifier))
    .split('\\')
    .join('/')
  return target === KIT_DIR || target.startsWith(`${KIT_DIR}/`)
}

describe('AC-17: the proof kit never ships', () => {
  it('AC-17: @nymbalhq/proof-kit is a private member, and no other member imports it from src/ or lists it outside devDependencies', () => {
    const members = workspaceMembers()
    const kit = members.find((m) => m.dir === KIT_DIR)
    expect.soft(kit?.manifest.name).toBe(KIT_NAME)
    expect.soft(kit?.manifest.private).toBe(true)

    const others = members.filter((m) => m.dir !== '' && m.dir !== KIT_DIR)
    const runtimeDeps = others.flatMap((m) =>
      RUNTIME_FIELDS.filter(
        (field) =>
          (m.manifest[field] as Record<string, string> | undefined)?.[KIT_NAME] !== undefined,
      ).map((field) => `${m.dir}/package.json: ${field}`),
    )
    expect(runtimeDeps).toEqual([])

    const srcRoots = others.map((m) => `${m.dir}/src/`)
    const files = trackedFiles().filter(
      (f) =>
        srcRoots.some((root) => f.startsWith(root)) && SOURCE_FILE.test(f) && !TEST_FILE.test(f),
    )
    const offenders = files.flatMap((file) =>
      specifiers(readFileSync(join(REPO_ROOT, file), 'utf8'))
        .filter(({ specifier }) => reachesKit(file, specifier))
        .map(({ specifier, line }) => `${file}:${line} -> ${specifier}`),
    )
    // Guard the guard: the walk saw the shipped source, and the matcher flags each way of reaching the kit.
    expect(files.length).toBeGreaterThan(0)
    expect(
      [
        `import { race } from '${KIT_NAME}/race'`,
        `export * from '${KIT_NAME}'`,
        `const k = await import('${KIT_NAME}/chaos')`,
        `import x from '../../proof-kit/src/index.js'`,
      ].map((src) =>
        specifiers(src).some(({ specifier }) =>
          reachesKit('packages/platform/src/x.ts', specifier),
        ),
      ),
    ).toEqual([true, true, true, true])
    expect(reachesKit('packages/platform/src/x.ts', '@nymbalhq/proof-kitten')).toBe(false)
    expect(offenders).toEqual([])
  })
})
