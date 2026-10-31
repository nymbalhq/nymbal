// Reads: packages/*/package.json, packages/adapters/*/*/package.json, pnpm-workspace.yaml
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  isBuildInput,
  plan,
  workspaceClosure,
  type PlanInput,
  type StepSpec,
} from '../../scripts/gate'

// AC-18 (the kit runs in gate and CI), the build half: workspace packages read one another through `dist`, so a gate
// that tests without building after a package's source changed tests a stale build and goes green. The plain gate
// builds before typecheck and tests when a build input changed, and runs the proof-kit project when the change is in
// the kit's dependency closure; gate:full always builds first, and the steps that read `dist` need that build.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const KIT = 'packages/proof-kit'
const KIT_PROJECT = /\bvitest\b[^;&|\n]*--project(?:=|\s+)['"]?proof-kit['"]?(?:\s|$)/

/**
 * The plain gate's plan for a change. With `kitClosure` the kit's closure is computed on this repository, as main()
 * does; it only matters to a change that is a build input.
 */
function plainPlan(changed: string[], kitClosure = true): StepSpec[] {
  return plan({
    full: false,
    base: 'HEAD',
    changed,
    mutated: [],
    ...(kitClosure ? { proofKitPackages: workspaceClosure(REPO, KIT) } : {}),
  }).steps
}

function fullPlan(extra: Partial<PlanInput> = {}): StepSpec[] {
  return plan({
    full: true,
    base: 'HEAD',
    changed: [],
    mutated: [],
    services: 'compose',
    ...extra,
  }).steps
}

const at = (steps: StepSpec[], name: string): number => steps.findIndex((s) => s.name === name)
const step = (steps: StepSpec[], name: string): StepSpec | undefined =>
  steps.find((s) => s.name === name)

describe('AC-18: the plain gate builds what it tests', () => {
  it('AC-18: a kernel source change builds before typecheck and tests, tests needs the build, and the proof-kit project runs', () => {
    const steps = plainPlan(['packages/platform/src/services/inventory-service.ts'])
    const build = step(steps, 'build')
    const tests = step(steps, 'tests')

    expect(build?.skip, 'build runs').toBeUndefined()
    expect(at(steps, 'build')).toBeGreaterThan(-1)
    expect(at(steps, 'build')).toBeLessThan(at(steps, 'typecheck'))
    expect(at(steps, 'build')).toBeLessThan(at(steps, 'tests'))
    expect(tests?.needs ?? []).toContain('build')
    expect(tests?.command ?? '').toMatch(KIT_PROJECT)
  })

  it("AC-18: a change outside the kit's closure (the CLI) still builds, but does not add the proof-kit project", () => {
    const changed = 'packages/cli/src/commands/dev.ts'
    // Precondition on the real manifests: the CLI is not something the kit imports.
    expect(workspaceClosure(REPO, KIT).some((dir) => changed.startsWith(`${dir}/`))).toBe(false)

    const steps = plainPlan([changed])
    expect(step(steps, 'build')?.skip, 'build runs').toBeUndefined()
    expect(at(steps, 'build')).toBeLessThan(at(steps, 'tests'))
    expect(step(steps, 'tests')?.needs ?? []).toContain('build')
    expect(step(steps, 'tests')?.command ?? '').not.toMatch(KIT_PROJECT)
  })

  it.each([
    { label: 'a docs change', changed: ['docs/x.md'] },
    {
      label: 'a test file only',
      changed: ['packages/platform/src/services/inventory-service.test.ts'],
    },
  ])('AC-18: $label leaves build an idle skip and tests without a build need', ({ changed }) => {
    const steps = plainPlan(changed, false)
    const build = step(steps, 'build')

    expect(at(steps, 'build')).toBeGreaterThan(-1)
    expect({ skipped: build?.skip !== undefined, idle: build?.idle === true }).toEqual({
      skipped: true,
      idle: true,
    })
    expect(step(steps, 'tests')?.needs ?? []).not.toContain('build')
  })
})

describe('AC-18: the kit closure and build inputs', () => {
  it('AC-18: workspaceClosure of the kit holds the kit and every workspace package it imports, and not the CLI', async () => {
    const { workspacePackageDirs } = (await import('../../scripts/workspace-packages')) as {
      workspacePackageDirs: (root: string) => string[]
    }
    const closure = workspaceClosure(REPO, KIT)
    for (const dir of [KIT, 'packages/platform', 'packages/types']) expect(closure).toContain(dir)
    expect(closure).not.toContain('packages/cli')
    // Every workspace package the kit's manifest names is in it, and it is closed under dependency.
    const manifest = (dir: string): Record<string, Record<string, string> | string | undefined> =>
      JSON.parse(readFileSync(join(REPO, dir, 'package.json'), 'utf8'))
    // Every workspace package, at any depth under packages/, by name.
    const dirOf = new Map(
      workspacePackageDirs(REPO)
        .filter((dir) => dir.startsWith('packages/'))
        .map((dir) => [manifest(dir).name as string, dir]),
    )
    const kit = manifest(KIT)
    const named = ['dependencies', 'devDependencies', 'peerDependencies']
      .flatMap((field) => Object.keys((kit[field] as Record<string, string> | undefined) ?? {}))
      .flatMap((name) => (dirOf.has(name) ? [dirOf.get(name)!] : []))
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((dir) => !closure.includes(dir))).toEqual([])
    for (const dir of closure) {
      expect(workspaceClosure(REPO, dir).filter((d) => !closure.includes(d))).toEqual([])
    }
  })

  const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/)
  const dirs = fc
    .array(segment, { maxLength: 3 })
    .map((parts) => parts.map((p) => `${p}/`).join(''))

  it('AC-18: property: isBuildInput is never true for a test file, and true for packages/<x>/src/<y>.ts that is not one', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant('packages/'), fc.constant('tests/'), fc.constant('')),
        segment,
        dirs,
        segment,
        fc.constantFrom('test', 'spec'),
        fc.constantFrom('ts', 'tsx', 'js', 'mts', 'cjs'),
        (root, pkg, sub, name, kind, ext) => {
          expect(isBuildInput(`${root}${pkg}/src/${sub}${name}.${kind}.${ext}`)).toBe(false)
        },
      ),
      { numRuns: 300 },
    )
    fc.assert(
      fc.property(segment, dirs, segment, (pkg, sub, name) => {
        expect(isBuildInput(`packages/${pkg}/src/${sub}${name}.ts`)).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})

describe('AC-18: gate:full builds before the steps that read dist', () => {
  it('AC-18: tests follows build and needs it; proof-kit-services needs build; tests-fail-on-base sets NYMBAL_TEST_MAILPIT_URL', () => {
    const steps = fullPlan()
    const tests = step(steps, 'tests')

    expect(step(steps, 'build')?.skip, 'build runs').toBeUndefined()
    expect(at(steps, 'tests')).toBeGreaterThan(at(steps, 'build'))
    expect(at(steps, 'build')).toBeGreaterThan(-1)
    expect(tests?.needs ?? []).toContain('build')
    expect(step(steps, 'proof-kit-services')?.needs ?? []).toContain('build')
    expect(step(steps, 'tests-fail-on-base')?.command ?? '').toMatch(
      /(?:^|\s)NYMBAL_TEST_MAILPIT_URL=\S+/,
    )
  })
})
