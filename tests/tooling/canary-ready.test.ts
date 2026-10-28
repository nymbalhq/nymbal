// Reads: scripts/canary-ready.ts
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canaryReady } from '../../scripts/canary-ready'

// AC-11: `scripts/canary-ready.ts` decides whether a canary may publish. For every public workspace package: if it is
// being snapshotted it must already exist on npm (some version), so a canary never becomes a package's first publish
// (npm gives a first publish `latest` whatever `--tag` says); if it is not snapshotted, its current `name@version`
// must exist on npm (`changeset publish` publishes any public package whose current version is missing). Private
// packages are never published and are ignored.
//
// Interface the tests call:
//   canaryReady(packages, snapshotted, registry) -> { ready, missing } (or a promise of it)
//     packages:    { name, version, private }[]  the workspace packages with their versions before the snapshot
//     snapshotted: Set<string>                    names of the packages the snapshot versions
//     registry:    (spec: string) => boolean      `name` (or `name@*` / `name@latest`) asks "any version exists",
//                                                 `name@x.y.z` asks "this exact version exists"
//     missing:     names of the public packages that fail their rule
//   CLI: tsx scripts/canary-ready.ts --before <pnpm-list.json> --after <pnpm-list.json>
//     both files are `pnpm -r list --json --depth -1` output, taken before and after `changeset version --snapshot`;
//     a public package whose version differs is snapshotted. Lookups go through `npm view <spec> version`. Prints
//     `ready=true|false` (and appends it to $GITHUB_OUTPUT when set), a `::notice::` naming each missing package
//     when not ready, and exits 0 either way.

const REPO = fileURLToPath(new URL('../../', import.meta.url))

type Pkg = { name: string; version: string; private: boolean }

/** A fake registry: package name -> published versions. Rejects spec shapes the contract does not define. */
function registryOf(published: Record<string, string[]>): (spec: string) => boolean {
  return (spec: string) => {
    const at = spec.indexOf('@', 1)
    const name = at === -1 ? spec : spec.slice(0, at)
    const range = at === -1 ? '' : spec.slice(at + 1)
    const versions = published[name] ?? []
    if (range === '' || range === '*' || range === 'latest') return versions.length > 0
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(range)) {
      throw new Error(`fake registry: unsupported spec ${spec}`)
    }
    return versions.includes(range)
  }
}

async function decide(
  packages: Pkg[],
  snapshotted: string[],
  published: Record<string, string[]>,
): Promise<{ ready: boolean; missing: string[] }> {
  const result = await canaryReady(packages, new Set(snapshotted), registryOf(published))
  return { ready: result.ready, missing: [...result.missing].sort() }
}

/** The ten public packages of the workspace, plus private ones that are never published. */
const PUBLIC = [
  '@nymbalhq/config',
  '@nymbalhq/http',
  '@nymbalhq/importers',
  '@nymbalhq/platform',
  '@nymbalhq/react',
  '@nymbalhq/sdk',
  '@nymbalhq/types',
  '@nymbalhq/web-components',
  'create-nymbal-app',
  'nymbal',
]
const PRIVATE = ['@nymbalhq/admin', '@nymbalhq/contract-tests', '@nymbalhq/template-astro']
const WORKSPACE: Pkg[] = [
  ...PUBLIC.map((name) => ({ name, version: '0.2.0', private: false })),
  ...PRIVATE.map((name) => ({ name, version: '0.1.0', private: true })),
]
/** Everything public released at its current version, with history. */
const ALL_RELEASED = Object.fromEntries(PUBLIC.map((name) => [name, ['0.1.0', '0.2.0']]))

describe('AC-11: canaryReady', () => {
  it('AC-11: the bootstrap is pending (everything snapshotted, nothing on npm): not ready, every public package missing', async () => {
    const result = await decide(
      WORKSPACE,
      WORKSPACE.map((p) => p.name),
      {},
    )
    expect(result.ready).toBe(false)
    expect(result.missing).toEqual([...PUBLIC].sort())
  })

  it('AC-11: one released package snapshotted, the rest unchanged at versions on npm: ready', async () => {
    // The snapshotted package's current version is not on npm, only an older one: "some version" is enough for it.
    const packages = WORKSPACE.map((p) => (p.name === 'nymbal' ? { ...p, version: '0.3.0' } : p))
    const result = await decide(packages, ['nymbal'], ALL_RELEASED)
    expect(result).toEqual({ ready: true, missing: [] })
  })

  it('AC-11: a snapshotted package new to npm: not ready, naming only it', async () => {
    const published = { ...ALL_RELEASED }
    delete published['@nymbalhq/sdk']
    const result = await decide(WORKSPACE, ['nymbal', '@nymbalhq/sdk'], published)
    expect(result).toEqual({ ready: false, missing: ['@nymbalhq/sdk'] })
  })

  it('AC-11: an unchanged package whose current version is absent from npm: not ready, naming it (changeset publish would sweep it)', async () => {
    // @nymbalhq/types exists on npm, but only at 0.1.0; its current 0.2.0 would be published by the canary run.
    const published = { ...ALL_RELEASED, '@nymbalhq/types': ['0.1.0'] }
    const result = await decide(WORKSPACE, ['nymbal'], published)
    expect(result).toEqual({ ready: false, missing: ['@nymbalhq/types'] })
  })

  it('AC-11: private packages are ignored, snapshotted or not, absent from npm', async () => {
    const result = await decide(WORKSPACE, ['nymbal', '@nymbalhq/admin'], ALL_RELEASED)
    expect(result).toEqual({ ready: true, missing: [] })
  })

  it('AC-11 (property): ready iff every public package satisfies its rule, and missing names exactly those that do not', async () => {
    const semver = fc
      .tuple(fc.nat(9), fc.nat(9), fc.nat(9))
      .map(([a, b, c]) => ({ current: `${a}.${b}.${c}`, other: `${a}.${b}.${c + 1}` }))
    const entry = fc.record({
      name: fc.stringMatching(/^(?:@[a-z]{1,4}\/)?[a-z][a-z0-9-]{0,7}$/),
      v: semver,
      private: fc.boolean(),
      snapshotted: fc.boolean(),
      // absent: never published; other: only a different version; current: the current version (and another).
      npm: fc.constantFrom('absent', 'other', 'current'),
    })
    const workspace = fc
      .uniqueArray(entry, { selector: (e) => e.name, minLength: 1, maxLength: 8 })
      .filter((es) => es.some((e) => !e.private && e.snapshotted))

    await fc.assert(
      fc.asyncProperty(workspace, async (entries) => {
        const packages = entries.map((e) => ({
          name: e.name,
          version: e.v.current,
          private: e.private,
        }))
        const snapshotted = entries.filter((e) => e.snapshotted).map((e) => e.name)
        const published: Record<string, string[]> = {}
        for (const e of entries) {
          if (e.npm === 'other') published[e.name] = [e.v.other]
          if (e.npm === 'current') published[e.name] = [e.v.other, e.v.current]
        }
        const failing = entries
          .filter((e) => !e.private)
          .filter((e) => (e.snapshotted ? e.npm === 'absent' : e.npm !== 'current'))
          .map((e) => e.name)
          .sort()

        const result = await decide(packages, snapshotted, published)
        expect(result.ready).toBe(failing.length === 0)
        expect(result.missing).toEqual(failing)
      }),
      { numRuns: 300 },
    )
  })
})

describe('AC-11: the canary-ready CLI', () => {
  let dir: string
  let bin: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'canary-ready-'))
    bin = join(dir, 'bin')
    mkdirSync(bin)
    // A fake `npm` answering `npm view <spec> [field] [--json]` from $FAKE_NPM_PUBLISHED, the way the real registry
    // does: a match prints the version and exits 0; no match prints E404 and exits 1.
    const fake = join(bin, 'npm')
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const { readFileSync } = require('node:fs')
const published = JSON.parse(readFileSync(process.env.FAKE_NPM_PUBLISHED, 'utf8'))
const args = process.argv.slice(2)
const verb = args.findIndex((a) => ['view', 'info', 'show', 'v'].includes(a))
if (verb === -1) { process.stderr.write('fake npm: only view is supported: ' + args.join(' ') + '\\n'); process.exit(2) }
const rest = args.slice(verb + 1).filter((a) => !a.startsWith('-'))
const json = args.includes('--json')
const spec = rest[0] || ''
const field = rest[1] || 'version'
const at = spec.indexOf('@', 1)
const name = at === -1 ? spec : spec.slice(0, at)
const range = at === -1 ? '' : spec.slice(at + 1)
const versions = published[name] || []
const matched = range === '' || range === '*' || range === 'latest' ? versions : versions.filter((v) => v === range)
if (matched.length === 0) {
  if (json) process.stdout.write(JSON.stringify({ error: { code: 'E404', summary: 'Not found: ' + spec } }) + '\\n')
  process.stderr.write('npm error code E404\\nnpm error 404 Not Found - ' + spec + '\\n')
  process.exit(1)
}
const value = field === 'versions' ? matched : matched[matched.length - 1]
process.stdout.write((json ? JSON.stringify(value) : Array.isArray(value) ? value.join('\\n') : value) + '\\n')
`,
    )
    chmodSync(fake, 0o755)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function listing(
    versionOf: (p: Pkg) => string,
  ): { name: string; version: string; path: string; private: boolean }[] {
    return WORKSPACE.map((p) => ({
      name: p.name,
      version: versionOf(p),
      path: join(dir, 'ws', p.name),
      private: p.private,
    }))
  }

  function runCli(
    label: string,
    snapshotted: string[],
    published: Record<string, string[]>,
  ): { status: number | null; output: string; ghOutput: string } {
    const before = join(dir, `${label}-before.json`)
    const after = join(dir, `${label}-after.json`)
    const registry = join(dir, `${label}-registry.json`)
    const ghOutput = join(dir, `${label}-github-output`)
    writeFileSync(before, JSON.stringify(listing((p) => p.version)))
    writeFileSync(
      after,
      JSON.stringify(
        listing((p) => (snapshotted.includes(p.name) ? `0.0.0-canary-20261017120000` : p.version)),
      ),
    )
    writeFileSync(registry, JSON.stringify(published))
    writeFileSync(ghOutput, '')
    const res = spawnSync(
      join(REPO, 'node_modules', '.bin', 'tsx'),
      [join(REPO, 'scripts', 'canary-ready.ts'), '--before', before, '--after', after],
      {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          FAKE_NPM_PUBLISHED: registry,
          GITHUB_OUTPUT: ghOutput,
        },
      },
    )
    return {
      status: res.status,
      output: `${res.stdout}\n${res.stderr}`,
      ghOutput: readFileSync(ghOutput, 'utf8'),
    }
  }

  const readyLine = (r: { output: string; ghOutput: string }): string[] =>
    `${r.output}\n${r.ghOutput}`.match(/^ready=(?:true|false)$/gm) ?? []

  it('AC-11: bootstrap pending against an empty registry: exits 0, ready=false, a notice naming every public package and no private one', () => {
    const result = runCli(
      'bootstrap',
      WORKSPACE.map((p) => p.name),
      {},
    )
    expect(result.status, result.output).toBe(0)
    expect(new Set(readyLine(result)), result.output).toEqual(new Set(['ready=false']))
    const notices = result.output.split('\n').filter((line) => line.startsWith('::notice::'))
    expect(notices.length, result.output).toBeGreaterThan(0)
    const noticeText = notices.join('\n')
    for (const name of PUBLIC) {
      expect(noticeText, `notice should name ${name}`).toMatch(
        new RegExp(
          `(?:^|[\\s,:(\`'"])${name.replace(/[/@.-]/g, (c) => `\\${c}`)}(?:[@\\s,).;\`'"]|$)`,
          'm',
        ),
      )
    }
    for (const name of PRIVATE) expect(noticeText).not.toContain(name)
  })

  it('AC-11: one released package snapshotted and the rest on npm: exits 0 with ready=true', () => {
    const result = runCli('ready', ['nymbal'], ALL_RELEASED)
    expect(result.status, result.output).toBe(0)
    expect(new Set(readyLine(result)), result.output).toEqual(new Set(['ready=true']))
  })
})
