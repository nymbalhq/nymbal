// Reads: registry/adapters.json, tests/contracts/**, tests/stores/**, packages/adapters/**, vitest.config.ts, .github/workflows/ci.yml, package.json
import { execFile } from 'node:child_process'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { CONTRACT_KINDS } from '../../packages/contract-tests/src/kinds'
import { ROOT } from './adapter-table'

// AC-8: every first-party adapter the registry lists ships on its own slot's contract suite, run in CI: a runner file
// that calls the slot's `run<Kind>Contract` with a build importing that adapter's package, collected by a Vitest
// project a ci.yml job runs. Another provider's suite, or the adapter's feedback or webhook suite alone, is not it.

const exec = promisify(execFile)

/** The suite each contract kind (and `security`) is held to. */
const SUITE: Record<string, string> = {
  payments: 'runPaymentsContract',
  email: 'runEmailContract',
  reviews: 'runReviewsContract',
  search: 'runSearchContract',
  analytics: 'runAnalyticsContract',
  shipping: 'runShippingContract',
  tax: 'runTaxContract',
  ai: 'runAiContract',
  documentStore: 'runDocumentStoreContract',
  eventBus: 'runEventBusContract',
  media: 'runMediaStorageContract',
  security: 'runSecurityContract',
}

/**
 * Adapters held to another suite of their slot, with why and the methods whose rejection is the why. EasyPost serves
 * tracker webhooks only: its rate, createLabel and track reject by design (its README), so the slot's rate suite cannot
 * pass on it; the tracking suite holds it. The hold follows the code, not the name: it lapses once the listed adapter
 * implements one of those methods, and `pnpm new-adapter` copies of it, which reject the same methods, are held the same.
 */
const HELD_TO: Record<string, { suite: string; why: string; rejects: readonly string[] }> = {
  '@nymbalhq/shipping-easypost': {
    suite: 'runShippingTrackingContract',
    why: 'tracker webhooks only: rate, createLabel and track reject as unsupported',
    rejects: ['rate', 'createLabel', 'track'],
  },
}

type Entry = { package: string; slot: string; tier: string; source: { dir: string } }

const camel = (slot: string): string => slot.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

const entries = (
  JSON.parse(readFileSync(join(ROOT, 'registry/adapters.json'), 'utf8')) as { adapters: Entry[] }
).adapters.filter((e) => e.tier === 'first-party' && SUITE[camel(e.slot)] !== undefined)

/** Whether every method in `methods` is, in the adapter's source, `<method>: () => unsupported('<method>')`. */
function rejectsAll(e: Entry, methods: readonly string[]): boolean {
  const source = globSync(`${e.source.dir}/src/**/*.ts`, { cwd: ROOT })
    .filter((f) => !f.endsWith('.test.ts'))
    .map((f) => readFileSync(join(ROOT, f), 'utf8'))
    .join('\n')
  return methods.every((m) =>
    new RegExp(`\\b${m}\\s*:\\s*\\(\\)\\s*=>\\s*unsupported\\(\\s*'${m}'\\s*\\)`).test(source),
  )
}

/** The suite `e` is held to: that of a held adapter of its slot whose rejections it shares, else its slot's. */
function suiteOf(e: Entry): string {
  const held = Object.entries(HELD_TO).find(
    ([pkg, h]) =>
      entries.find((x) => x.package === pkg)?.slot === e.slot && rejectsAll(e, h.rejects),
  )
  return held?.[1].suite ?? SUITE[camel(e.slot)]!
}

/** The candidate runner files: the contract and store suites, and each adapter's own contract test. */
function runnerFiles(): string[] {
  const own = entries
    .map((e) => `${e.source.dir}/src/contract.test.ts`)
    .filter((f) => existsSync(join(ROOT, f)))
  return [
    ...globSync('tests/contracts/**/*.test.ts', { cwd: ROOT }),
    ...globSync('tests/stores/**/*.test.ts', { cwd: ROOT }),
    ...own,
  ].sort()
}

/** Whether `file` imports the adapter: by its package name, or a relative path into its directory. */
function importsAdapter(file: string, text: string, e: Entry): boolean {
  const specifiers = [...text.matchAll(/\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/g)].map(
    (m) => m[1] ?? m[2]!,
  )
  return specifiers.some((s) => {
    if (s === e.package || s.startsWith(`${e.package}/`)) return true
    if (!s.startsWith('.')) return false
    const target = normalize(join(dirname(file), s))
    return target === e.source.dir || target.startsWith(`${e.source.dir}/`)
  })
}

/** Whether `file` calls `suite` (not only imports it). */
const calls = (text: string, suite: string): boolean => new RegExp(`\\b${suite}\\s*\\(`).test(text)

/** Every file `vitest list --filesOnly` collects, repo-relative, with its project. */
async function collected(): Promise<Map<string, string>> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITEST') && !key.startsWith('NYMBAL_')) env[key] = value
  }
  const { stdout } = await exec(
    join(ROOT, 'node_modules/.bin/vitest'),
    ['list', '--filesOnly', '--json'],
    { cwd: ROOT, env, maxBuffer: 64 * 1024 * 1024 },
  )
  const rows = JSON.parse(stdout.slice(stdout.indexOf('['))) as Array<{
    file: string
    projectName?: string
  }>
  return new Map(
    rows.map((r) => [relative(ROOT, r.file).split('\\').join('/'), r.projectName ?? '']),
  )
}

/**
 * The projects a ci.yml job runs: each named by `--project` or as a gate step by `--only`, and, through the gate's
 * tests step, every project the `test` script's negated `--project` globs leave in.
 */
function ciProjects(all: Iterable<string>): Set<string> {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  const named = new Set<string>()
  for (const m of ci.matchAll(/--project\s+'?([\w-]+)'?/g)) named.add(m[1]!)
  for (const m of ci.matchAll(/--only\s+"([^"]+)"|--only\s+([\w-]+)/g)) {
    for (const step of (m[1] ?? m[2]!).split(',')) named.add(step.trim())
  }
  if (named.has('tests')) {
    const script = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts['test']!
    const excluded = [...script.matchAll(/--project\s+'!([^']+)'/g)].map(
      (m) => new RegExp(`^${m[1]!.replace(/\*/g, '.*')}$`),
    )
    for (const p of all) if (!excluded.some((re) => re.test(p))) named.add(p)
  }
  return named
}

describe('AC-8: every first-party adapter runs its slot’s suite in CI', () => {
  it('AC-8: the suite table covers every contract kind and security, and each exception names a listed adapter', () => {
    expect(Object.keys(SUITE).sort()).toEqual([...CONTRACT_KINDS, 'security'].sort())
    const listed = new Set(entries.map((e) => e.package))
    expect(Object.keys(HELD_TO).filter((p) => !listed.has(p))).toEqual([])
    expect(entries.length).toBeGreaterThanOrEqual(Object.keys(HELD_TO).length + 1)
  })

  it('AC-8: each listed adapter has a runner calling its suite with a build of its own package, in a project ci.yml runs', async () => {
    const projects = await collected()
    const run = ciProjects(new Set(projects.values()))
    const files = runnerFiles().map((file) => ({
      file,
      text: readFileSync(join(ROOT, file), 'utf8'),
    }))
    const missing = entries.flatMap((e) => {
      const suite = suiteOf(e)
      const runners = files.filter((f) => calls(f.text, suite) && importsAdapter(f.file, f.text, e))
      if (runners.length === 0) return [`${e.package}: no runner calls ${suite} with its package`]
      const inCi = runners.filter((f) => run.has(projects.get(f.file) ?? ''))
      return inCi.length > 0
        ? []
        : [
            `${e.package}: ${runners.map((f) => `${f.file} (${projects.get(f.file) ?? 'no project'})`).join(', ')} not in a project ci.yml runs`,
          ]
    })
    expect(missing).toEqual([])
  }, 60_000)
})
