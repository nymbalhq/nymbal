import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './workspace-manifests'

// AC-2: the suites live in @nymbalhq/contract-tests and nowhere else. tests/contracts/suites/ is gone and no file
// imports from it; every runner (tests/contracts/*.test.ts and packages/*/src/contract.test.ts that call a
// run*Contract) imports its suite from the package (where a workspace package cannot depend on it, from the
// package's own src/index.ts: the same code, no fork); and each runner collects at least as many cases as it did at
// 45a48d6. The counts are `vitest list` (collection only: no service is reached). Needs `pnpm build`.

/** Each runner's case count at 45a48d6, by project, as `vitest list --project <p> <file>` collected it. */
const BASE_COUNTS: Record<string, Record<string, number>> = {
  'contracts-native': {
    'tests/contracts/analytics.test.ts': 3,
    'tests/contracts/custom-providers.test.ts': 16,
    'tests/contracts/document-store.test.ts': 19,
    'tests/contracts/email.test.ts': 4,
    'tests/contracts/event-bus.test.ts': 12,
    'tests/contracts/media-storage.test.ts': 3,
    'tests/contracts/payments.test.ts': 3,
    'tests/contracts/projection-idempotency.test.ts': 3,
    'tests/contracts/search.test.ts': 11,
    'tests/contracts/security.test.ts': 3,
    'tests/contracts/shipping.test.ts': 2,
    'tests/contracts/stripe-payments.test.ts': 14,
    'tests/contracts/tax.test.ts': 3,
  },
  'integration-stores': {
    'packages/doc-store-postgres-jsonb/src/contract.test.ts': 22,
    'packages/doc-store-redis/src/contract.test.ts': 22,
    'packages/event-bus-redis-streams/src/contract.test.ts': 20,
    'tests/stores/media-s3-contract.test.ts': 5,
  },
  'integration-postgres': {
    'packages/platform/tests/postgres/search-contract.postgres.test.ts': 11,
  },
}

const PACKAGE = '@nymbalhq/contract-tests'
/** The package's source entry, for a workspace package that does not depend on it (platform, cli, tests/stores). */
const PACKAGE_SOURCE = /(^|\/)contract-tests\/src\/index(\.js)?$/
const RUN_CALL = /\b(run[A-Z]\w*Contract)\s*\(/g
const CALLS_A_SUITE = /\brun[A-Z]\w*Contract\s*\(/
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.astro',
  '.next',
  '.git',
  'coverage',
  'reports',
])

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry)) out.push(full)
  }
  return out
}

/** Every `import { … } from '<specifier>'`: the specifier of each imported binding, by local name. */
function importedFrom(source: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const m of source.matchAll(
    /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    for (const raw of m[1]!.split(',')) {
      const binding = raw.replace(/^\s*type\s+/, '').trim()
      if (binding === '') continue
      const local = binding
        .split(/\s+as\s+/)
        .pop()!
        .trim()
      names.set(local, m[2]!)
    }
  }
  return names
}

const rel = (file: string) => relative(REPO_ROOT, file).split('\\').join('/')

/** The runner files AC-2 names: tests/contracts/*.test.ts and packages/<pkg>/src/contract.test.ts calling a suite. */
function namedRunners(): string[] {
  const contracts = readdirSync(join(REPO_ROOT, 'tests', 'contracts'))
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `tests/contracts/${f}`)
  const packages = readdirSync(join(REPO_ROOT, 'packages'))
    .map((p) => `packages/${p}/src/contract.test.ts`)
    .filter((f) => existsSync(join(REPO_ROOT, f)))
  return [...contracts, ...packages].filter((f) =>
    CALLS_A_SUITE.test(readFileSync(join(REPO_ROOT, f), 'utf8')),
  )
}

/** The module specifiers a file imports or re-exports, statically or dynamically. */
function specifiers(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s*['"]([^'"\n]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g),
    ...source.matchAll(/^\s*import\s*['"]([^'"\n]+)['"]/gm),
  ].map((m) => m[1]!)
}

const scratch = mkdtempSync(join(tmpdir(), 'contracts-runner-counts-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** `vitest list` for one project's files: each file's collected case count, and the run's output when it failed. */
function collected(
  project: string,
  files: string[],
): { counts: Map<string, number>; output: string } {
  const out = join(scratch, `${project}.json`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Collection reaches no service; the store suites only need the variables present to load.
    NYMBAL_TEST_REDIS_URL: process.env['NYMBAL_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:1',
    NYMBAL_TEST_POSTGRES_URL:
      process.env['NYMBAL_TEST_POSTGRES_URL'] ??
      'postgres://contracts:contracts@127.0.0.1:1/contracts',
    NYMBAL_TEST_S3_ENDPOINT: process.env['NYMBAL_TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:1',
  }
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
  const run = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
      'list',
      '--project',
      project,
      `--json=${out}`,
      ...files,
    ],
    { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 120_000 },
  )
  const counts = new Map<string, number>(files.map((f) => [f, 0]))
  if (existsSync(out)) {
    for (const test of JSON.parse(readFileSync(out, 'utf8')) as Array<{ file: string }>) {
      const file = rel(test.file)
      counts.set(file, (counts.get(file) ?? 0) + 1)
    }
  }
  return { counts, output: `${run.stdout ?? ''}${run.stderr ?? ''}`.slice(-2000) }
}

describe('AC-2: the suites live in the package, and every runner runs them', () => {
  it('AC-2: tests/contracts/suites/ does not exist, and no source file imports from it', () => {
    const roots = ['packages', 'tests', 'apps', 'templates', 'scripts'].map((d) =>
      join(REPO_ROOT, d),
    )
    const offenders = roots
      .flatMap(sourceFiles)
      .filter((file) =>
        specifiers(readFileSync(file, 'utf8')).some(
          (spec) =>
            /(^|\/)contracts\/suites(\/|$)/.test(spec) ||
            (rel(file).startsWith('tests/contracts/') && /^\.\/suites(\/|$)/.test(spec)),
        ),
      )
      .map(rel)

    expect(existsSync(join(REPO_ROOT, 'tests', 'contracts', 'suites'))).toBe(false)
    expect(offenders).toEqual([])
  })

  it('AC-2: every runner imports each run*Contract it calls from @nymbalhq/contract-tests (or the package’s own src/index), and every runner of the base still calls one', () => {
    const base = Object.values(BASE_COUNTS).flatMap((files) => Object.keys(files))
    const runners = [...new Set([...namedRunners(), ...base])].sort()
    const misimported = runners.flatMap((file) => {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      const imports = importedFrom(source)
      const called = [...new Set([...source.matchAll(RUN_CALL)].map((m) => m[1]!))]
      if (called.length === 0) return [`${file}: calls no run*Contract`]
      return called
        .filter((name) => {
          const from = imports.get(name)
          return from === undefined || (from !== PACKAGE && !PACKAGE_SOURCE.test(from))
        })
        .map((name) => `${file}: ${name} from ${imports.get(name) ?? 'nowhere'}`)
    })

    expect(runners.length).toBeGreaterThanOrEqual(base.length)
    expect(misimported).toEqual([])
  })

  it('AC-2: each runner collects at least as many cases as at 45a48d6', () => {
    const lower: string[] = []
    let now = 0
    let then = 0
    const outputs: string[] = []
    for (const [project, files] of Object.entries(BASE_COUNTS)) {
      const { counts, output } = collected(project, Object.keys(files))
      outputs.push(output)
      for (const [file, baseCount] of Object.entries(files)) {
        const count = counts.get(file) ?? 0
        now += count
        then += baseCount
        if (count < baseCount) lower.push(`${file}: ${count} cases, ${baseCount} at the base`)
      }
    }

    expect(lower, outputs.join('\n')).toEqual([])
    expect(now).toBeGreaterThanOrEqual(then)
  }, 180_000)
})
