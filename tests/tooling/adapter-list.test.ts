// Reads: registry/adapters.json, tests/architecture/**, tests/tooling/*.ts, pnpm-workspace.yaml
// Reads: packages/*/package.json, packages/adapters/*/*/package.json
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isPublished, workspaceMembers } from '../architecture/workspace-manifests'
import { REPO, removeCopies, resetCopy, workTreeCopy } from './work-tree-copy'
import { failedRows, rowKey, vitestReport, type TestRow } from './vitest-report'

// AC-3: registry/adapters.json is the one hand-pinned list of first-party adapters. The architecture project reads it,
// so it fails, naming the adapter, when the registry lists a package the workspace lacks or the workspace holds an
// adapter the registry does not list; and no architecture or tooling test pins the adapter count again, in an
// assertion or a title, so adding an adapter edits no test.

interface RegistryEntry {
  package: string
  slot: string
  provider: string
  tier: string
  source: { dir?: string; npm?: string }
}

const readRegistry = (root: string): { adapters: RegistryEntry[] } =>
  JSON.parse(readFileSync(join(root, 'registry', 'adapters.json'), 'utf8')) as {
    adapters: RegistryEntry[]
  }

// Each nested run is the whole architecture project beside the outer suite: two workers keep it from taking every core
// of a four-core runner from the outer run's tests, and a test that makes two such runs gets twice one run's time.
const ARCHITECTURE = '--project architecture --maxWorkers=2'
const NESTED_RUN_MS = 120_000

let copy = ''
/** The architecture tests that fail in an unchanged copy (a copy has no origin remote, for one). */
let baseline = new Set<string>()

beforeAll(async () => {
  copy = workTreeCopy()
  baseline = new Set(failedRows(await vitestReport(copy, ARCHITECTURE)).map(rowKey))
}, NESTED_RUN_MS)

afterAll(removeCopies)

/** The architecture tests that fail after a change to the copy; the copy is reset after. */
async function failuresAfterChange(): Promise<TestRow[]> {
  try {
    return failedRows(await vitestReport(copy, ARCHITECTURE))
  } finally {
    resetCopy(copy)
  }
}

const added = (rows: TestRow[]): TestRow[] => rows.filter((t) => !baseline.has(rowKey(t)))

const naming = (rows: TestRow[], names: readonly string[]): TestRow[] =>
  rows.filter((r) => r.messages.some((m) => names.some((n) => m.includes(n))))

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
]
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** A count under a hundred as an English title spells it: `twenty-six`, also written `twenty six`. */
function spelled(n: number): RegExp {
  const word =
    n < 20 ? ONES[n]! : `${TENS[Math.floor(n / 10)]!}${n % 10 === 0 ? '' : `-${ONES[n % 10]!}`}`
  return new RegExp(`\\b${word.replace('-', '[- ]')}\\b`, 'i')
}

/** Every test title in a source text (it, test, describe and their modifiers), with its line. */
function titles(text: string): Array<{ line: number; title: string }> {
  const call = /\b(?:it|test|describe)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g
  return [...text.matchAll(call)].map((m) => ({
    line: text.slice(0, m.index).split('\n').length,
    title: m[2]!,
  }))
}

describe('AC-3: registry/adapters.json is the one list of first-party adapters', () => {
  it('AC-3: when the registry and the workspace disagree either way, the architecture project fails naming the adapter', async () => {
    // A first-party entry with no package behind it.
    const registry = readRegistry(copy)
    registry.adapters.push({
      package: '@nymbalhq/search-ghost',
      slot: 'search',
      provider: 'ghost',
      tier: 'first-party',
      source: { dir: 'packages/adapters/search/ghost' },
    })
    registry.adapters.sort((a, b) => a.package.localeCompare(b.package))
    writeFileSync(join(copy, 'registry', 'adapters.json'), `${JSON.stringify(registry, null, 2)}\n`)
    const listedOnly = await failuresAfterChange()

    // A workspace adapter with no entry.
    const stray = join(copy, 'packages', 'adapters', 'search', 'stray')
    mkdirSync(join(stray, 'src'), { recursive: true })
    writeFileSync(
      join(stray, 'package.json'),
      `${JSON.stringify({ name: '@nymbalhq/search-stray', version: '0.0.0', type: 'module' }, null, 2)}\n`,
    )
    writeFileSync(
      join(stray, 'src', 'index.ts'),
      "export const slot = 'search'\nexport const provider = 'stray'\n",
    )
    const unlisted = await failuresAfterChange()

    expect(listedOnly.length, listedOnly.map(rowKey).join('\n')).toBeGreaterThan(baseline.size)
    expect(
      naming(added(listedOnly), ['search/ghost', '@nymbalhq/search-ghost']).map(rowKey),
      `no failure the entry adds names it:\n${added(listedOnly).map(rowKey).join('\n')}`,
    ).not.toEqual([])
    expect(unlisted.length, unlisted.map(rowKey).join('\n')).toBeGreaterThan(baseline.size)
    expect(
      naming(added(unlisted), ['search/stray', '@nymbalhq/search-stray']).map(rowKey),
      `no failure the package adds names it:\n${added(unlisted).map(rowKey).join('\n')}`,
    ).not.toEqual([])
  }, 2 * NESTED_RUN_MS)

  it('AC-3: no architecture or tooling test asserts the first-party or published package count, or spells it in a title', () => {
    const firstParty = readRegistry(REPO).adapters.filter((e) => e.tier === 'first-party').length
    const published = workspaceMembers(REPO).filter(
      (m) => m.dir !== '' && isPublished(m.manifest),
    ).length
    const files = ['tests/architecture', 'tests/tooling'].flatMap((dir) =>
      readdirSync(join(REPO, dir))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `${dir}/${f}`),
    )

    const offences = files.flatMap((file) => {
      const text = readFileSync(join(REPO, file), 'utf8')
      const lines = text.split('\n')
      return [firstParty, published].flatMap((n) => {
        const asserted = new RegExp(
          `\\.(?:toBe|toHaveLength|toEqual|toStrictEqual)\\(\\s*${n}\\s*\\)`,
        )
        return [
          ...lines.flatMap((l, i) => (asserted.test(l) ? [`${file}:${i + 1} asserts ${n}`] : [])),
          ...titles(text)
            .filter((t) => spelled(n).test(t.title))
            .map((t) => `${file}:${t.line} spells ${n} in "${t.title.slice(0, 80)}"`),
        ]
      })
    })

    expect(offences).toEqual([])
  })
})
