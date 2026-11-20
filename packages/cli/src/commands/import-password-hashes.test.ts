import { randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { buildRepositories, createCommandStore, InMemoryDocumentStore } from '@nymbalhq/platform'
import { cliEnv, MIGRATIONS_ROOT, runCli, type CliRun } from '../../../../tests/support/doctor.js'
import { readRows } from '../../../../tests/support/store-tables.js'

// `nymbal import --source woocommerce --password-hashes <file>` through the built CLI (`pnpm build` first) on a SQLite
// project: a WP-CLI export of emails and WordPress password hashes attached to the imported customers who still have no
// password, with counts only on the terminal, never a hash or an email, and nothing stored without a sunset date.
// The database is read afterwards by a second connection.

const IMPORTED_NO_PASSWORD = 'IMPORTED_NO_PASSWORD'
const NATIVE = '$2a$04$abcdefghijklmnopqrstuuJ8m1XbHbpb2wZpWmbzQ0OdD3Pq3HY7e'
const DAY_MS = 24 * 60 * 60_000
const LABELS = {
  stored: 'stored',
  hasPassword: 'already have a password',
  unmatched: 'no customer with this email',
  format: 'hash not supported (format)',
  cost: 'hash not supported (cost)',
  duplicate: 'listed more than once',
} as const
type Counts = Record<keyof typeof LABELS, number>

const hashes = JSON.parse(
  readFileSync(
    new URL('../../../platform/src/services/fixtures/wordpress-hashes.json', import.meta.url),
    'utf8',
  ),
) as { vectors: Array<{ name: string; hash: string }> }

const hashOf = (name: string): string => {
  const v = hashes.vectors.find((x) => x.name === name)
  if (v === undefined) throw new Error(`no vector ${name}`)
  return v.hash
}

const dateIn = (days: number, from = Date.now()): string =>
  new Date(from + days * DAY_MS).toISOString().slice(0, 10)

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Project {
  dir: string
  dbPath: string
  file: string
  env: NodeJS.ProcessEnv
  /** Every email the file names, as it names them, and every hash in it. */
  secrets: string[]
  /** Email (lowercased) → what its row held before any run. */
  before: Map<string, string>
  emails: Record<'stored' | 'native' | 'format' | 'cost' | 'duplicate', string[]>
}

function writeConfig(dir: string, legacy: Record<string, unknown> | undefined): void {
  const config = {
    store: { name: 'password-hashes', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware', ...(legacy !== undefined && { auth: { legacy } }) },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native', config: { transport: 'console' } },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3999, host: '127.0.0.1' },
    deployment: { strategy: 'standard' },
  }
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
}

/**
 * A migrated project whose store holds imported customers with no password and customers with one of their own, and a
 * hash file built so every count differs: 6 stored, 5 no customer, 4 already have a password, 3 format, 2 cost, and one
 * email listed twice in two cases. A header, CRLF line ends and blank lines, as an export and an editor leave them.
 */
async function project(legacy: Record<string, unknown> | undefined): Promise<Project> {
  const dir = mkdtempSync(join(tmpdir(), 'password-hashes-'))
  dirs.push(dir)
  writeConfig(dir, legacy)
  symlinkSync(MIGRATIONS_ROOT, join(dir, 'migrations'), 'dir')
  const dbPath = join(dir, 'nymbal.db')
  const env = cliEnv({
    NYMBAL_SQLITE_PATH: dbPath,
    WOOCOMMERCE_URL: undefined,
    WOOCOMMERCE_KEY: undefined,
    WOOCOMMERCE_SECRET: undefined,
  })
  const migrated = await runCli(['migrate'], { cwd: dir, env, timeoutMs: 120_000 })
  expect(migrated.code, migrated.out.slice(-2000)).toBe(0)

  const run = randomUUID().slice(0, 6)
  const make = (kind: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${kind}${i}-${run}@shop.example`)
  const emails = {
    stored: make('stored', 6),
    native: make('native', 4),
    format: make('format', 3),
    cost: make('cost', 2),
    duplicate: make('dup', 1),
  }
  const unmatched = make('nobody', 5)

  const minimal = {
    infrastructure: { commandStore: 'sqlite' },
    store: { name: 'password-hashes', currency: 'GBP' },
  } as unknown as NymbalConfig
  const store = createCommandStore(minimal, { sqlitePath: dbPath })
  try {
    const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
    const at = new Date()
    await store.transaction(async (tx) => {
      for (const [kind, list] of Object.entries(emails)) {
        for (const email of list) {
          await repos.customer.insert(tx, {
            id: randomUUID(),
            email,
            passwordHash: kind === 'native' ? NATIVE : IMPORTED_NO_PASSWORD,
            requiresPasswordReset: kind !== 'native',
            createdAt: at,
            updatedAt: at,
          })
        }
      }
    })
  } finally {
    await store.close()
  }

  const stored = [
    'phpass ascii',
    'phpass utf-8',
    'phpass 5 characters',
    'wp bcrypt 10 ascii',
    'wp bcrypt 10 utf-8',
    'bcrypt 10 ascii',
  ].map(hashOf)
  const accepted = [
    'wp bcrypt 10 5 characters',
    'wp bcrypt 10 100 bytes',
    'bcrypt 10 utf-8',
    'phpass 256 bytes',
    'phpass 300 bytes',
  ].map(hashOf)
  const format = [
    '5f4dcc3b5aa765d61d8327deb882cf99',
    `$H$${hashOf('phpass ascii').slice(3)}`,
    `$argon2id$v=19$m=65536,t=4,p=1$c2FsdHNhbHQ$${'h'.repeat(43)}`,
  ]
  const cost = ['wp bcrypt 11 ascii', 'wp bcrypt 12 ascii'].map(hashOf)
  const lines: Array<[string, string]> = [
    ...emails.stored.map((e, i): [string, string] => [
      i % 2 === 0 ? e.toUpperCase() : e,
      stored[i]!,
    ]),
    ...unmatched.map((e, i): [string, string] => [e, accepted[i]!]),
    ...emails.native.map((e, i): [string, string] => [e, stored[i]!]),
    ...emails.format.map((e, i): [string, string] => [e, format[i]!]),
    ...emails.cost.map((e, i): [string, string] => [e, cost[i]!]),
    [emails.duplicate[0]!, stored[0]!],
    [emails.duplicate[0]!.replace(/^d/, 'D').replace('shop.example', 'SHOP.example'), stored[3]!],
  ]
  const file = join(dir, 'hashes.tsv')
  writeFileSync(
    file,
    ['user_email\tuser_pass', '', ...lines.map(([e, h]) => `${e}\t${h}`), '', ''].join('\r\n'),
  )
  const secrets = [...lines.map(([e]) => e), ...lines.map(([, h]) => h)]
  return { dir, dbPath, file, env, secrets, before: holding(dbPath), emails }
}

/** Email (lowercased) → password_hash, as the store holds them now. */
function holding(dbPath: string): Map<string, string> {
  return new Map(
    readRows<{ email: string; password_hash: string }>(
      dbPath,
      'SELECT email, password_hash FROM customers',
    ).map((r) => [r.email.toLowerCase(), r.password_hash]),
  )
}

function nymbal(p: Project, ...extra: string[]): Promise<CliRun> {
  return runCli(['import', '--source', 'woocommerce', '--password-hashes', p.file, ...extra], {
    cwd: p.dir,
    env: p.env,
    timeoutMs: 60_000,
  })
}

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The count printed beside `label` on a line of its own (`label: n` or `n label`), or undefined. */
function countOf(out: string, label: string): number | undefined {
  const l = escaped(label)
  const m = new RegExp(`^[^\\w(]*(?:(\\d+)\\s+${l}|${l}\\s*:?\\s*(\\d+))\\s*$`, 'im').exec(out)
  return m === null ? undefined : Number(m[1] ?? m[2])
}

function countsIn(out: string): Partial<Counts> {
  return Object.fromEntries(
    Object.entries(LABELS).map(([key, label]) => [key, countOf(out, label)]),
  )
}

/** Every file the run could have written in the project, but the database, the config and the hash file itself. */
function writtenFiles(p: Project): Array<[string, string]> {
  const skip = new Set([
    'nymbal.db',
    'nymbal.db-wal',
    'nymbal.db-shm',
    'nymbal.config.ts',
    'hashes.tsv',
    'migrations',
  ])
  return readdirSync(p.dir)
    .filter((name) => !skip.has(name) && statSync(join(p.dir, name)).isFile())
    .map((name) => [name, readFileSync(join(p.dir, name), 'utf8')])
}

/** Which of the file's emails and hashes a text holds, compared without case. */
const leaked = (p: Project, text: string): string[] =>
  p.secrets.filter((secret) => text.toLowerCase().includes(secret.toLowerCase()))

describe('nymbal import --password-hashes, with a sunset date set', () => {
  let p: Project
  let dry: CliRun
  let afterDry: Map<string, string>
  let real: CliRun

  beforeAll(async () => {
    p = await project({ until: dateIn(90) })
    dry = await nymbal(p, '--dry-run')
    afterDry = holding(p.dbPath)
    real = await nymbal(p)
  }, 300_000)

  it('AC-10: it exits 0 and prints each count under its label: 6 stored, 5 no customer, 4 already have a password, 3 format, 2 cost, 1 listed more than once, and a closing line telling the operator to delete the file', () => {
    expect(real.code, real.out.slice(-3000)).toBe(0)
    expect(countsIn(real.out), real.out.slice(-3000)).toEqual({
      stored: 6,
      unmatched: 5,
      hasPassword: 4,
      format: 3,
      cost: 2,
      duplicate: 1,
    })
    const lastLines = real.out.trim().split('\n').slice(-3).join('\n')
    expect(lastLines, real.out.slice(-1000)).toMatch(/delete/i)
  })

  it('AC-10: the matched imported customers hold their tagged hash and keep the reset flag; a password of the store’s own, a refused line and a twice-listed email change nothing', () => {
    const now = holding(p.dbPath)
    const flags = new Map(
      readRows<{ email: string; requires_password_reset: number }>(
        p.dbPath,
        'SELECT email, requires_password_reset FROM customers',
      ).map((r) => [r.email, r.requires_password_reset]),
    )
    const stored = p.emails.stored.map((e) => now.get(e))
    expect(stored.every((h) => h?.startsWith('legacy:wordpress:'))).toBe(true)
    expect(p.emails.stored.map((e) => flags.get(e))).toEqual(p.emails.stored.map(() => 1))
    for (const e of [
      ...p.emails.native,
      ...p.emails.format,
      ...p.emails.cost,
      ...p.emails.duplicate,
    ]) {
      expect([e, now.get(e)]).toEqual([e, p.before.get(e)])
    }
    expect(now.size, 'no customer was created for an unknown email').toBe(p.before.size)
  })

  it('AC-10: --dry-run prints the same counts and changes no row', () => {
    expect(dry.code, dry.out.slice(-3000)).toBe(0)
    expect(countsIn(dry.out)).toEqual(countsIn(real.out))
    expect(afterDry).toEqual(p.before)
  })

  it('AC-10: no email or hash from the file reaches stdout, stderr, the state file or any report the runs that read it wrote', () => {
    expect([dry.code, real.code], 'both runs read the file').toEqual([0, 0])
    expect({
      dry: leaked(p, dry.stdout + dry.stderr),
      real: leaked(p, real.stdout + real.stderr),
      files: writtenFiles(p).flatMap(([name, text]) => leaked(p, text).map((s) => `${name}: ${s}`)),
    }).toEqual({ dry: [], real: [], files: [] })
  })
})

describe('nymbal import --password-hashes, with maxCost 12', () => {
  it('AC-10: with maxCost 12 in the config the two cost lines are stored too: 8 stored and none refused for cost', async () => {
    const p = await project({ until: dateIn(90), maxCost: 12 })
    const run = await nymbal(p)
    const now = holding(p.dbPath)
    expect(run.code, run.out.slice(-3000)).toBe(0)
    expect([countOf(run.out, LABELS.stored), countOf(run.out, LABELS.cost) ?? 0]).toEqual([8, 0])
    expect(p.emails.cost.map((e) => now.get(e)?.startsWith('legacy:wordpress:$wp$2y$1'))).toEqual([
      true,
      true,
    ])
  }, 300_000)
})

describe('nymbal import --password-hashes refuses', () => {
  it('AC-10: with no security.auth.legacy, or with its date passed, it exits 1, names security.auth.legacy.until with a ready date 180 days out, and changes no row', async () => {
    for (const legacy of [undefined, { until: '2026-01-01' }]) {
      const p = await project(legacy)
      const from = Date.now()
      const run = await nymbal(p)
      const dates = [dateIn(180, from), dateIn(180)]
      expect(run.code, run.out.slice(-2000)).toBe(1)
      expect(run.out).toContain('security.auth.legacy.until')
      expect(
        dates.some((d) => run.out.includes(d)),
        `${dates.join(' or ')} in: ${run.out.slice(-1000)}`,
      ).toBe(true)
      expect(holding(p.dbPath)).toEqual(p.before)
      expect(leaked(p, run.stdout + run.stderr)).toEqual([])
    }
  }, 300_000)

  it('AC-10: alongside --rollback, --since or --fresh it exits 1 naming the flag it will not combine with, and changes no row', async () => {
    const p = await project({ until: dateIn(90) })
    const flags: Array<[string, string[]]> = [
      ['--rollback', ['--rollback', '--yes']],
      ['--since', ['--since', '2026-10-01']],
      ['--fresh', ['--fresh']],
    ]
    const refused: Array<[string, number, boolean]> = []
    for (const [flag, args] of flags) {
      const run = await nymbal(p, ...args)
      refused.push([
        flag,
        run.code,
        run.out.includes('--password-hashes') && run.out.includes(flag),
      ])
    }
    expect(refused).toEqual(flags.map(([flag]) => [flag, 1, true]))
    expect(holding(p.dbPath)).toEqual(p.before)
  }, 300_000)
})
