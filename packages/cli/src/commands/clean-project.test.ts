import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { seedCategories, seedProducts } from '@nymbalhq/platform'

// AC-7 to AC-10: the real `nymbal` bin, run in a project outside this repo as a scaffold leaves it once installed
// (packages linked to the workspace, so run `pnpm build` first). The database is read back directly.

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(HERE, '..', '..', 'bin', 'nymbal.mjs')
const PACKAGES = resolve(HERE, '..', '..', '..')
const Database = createRequire(join(PACKAGES, 'platform', 'package.json'))(
  'better-sqlite3',
) as new (
  path: string,
  opts?: { readonly?: boolean; fileMustExist?: boolean },
) => { prepare(sql: string): { get(): { n: number } }; exec(sql: string): void; close(): void }

const TABLES = ['categories', 'products', 'variants', 'customers'] as const
type Counts = Record<(typeof TABLES)[number], number>

// The config create-nymbal-app generates (native payments, no ai), for either template.
const config = (
  template: 'astro' | 'nextjs',
): string => `import { defineConfig } from '@nymbalhq/config'

export default defineConfig({
  store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
  template: '${template}',
  infrastructure: {
    commandStore: 'sqlite',
    documentStore: { provider: 'in-memory' },
    eventBus: { provider: 'in-process' },
  },
  security: { adapter: 'middleware', csrf: true },
  commerce: {
    payments: { provider: 'native' },
    email: { provider: 'native' },
    reviews: { provider: 'native' },
    search: { provider: 'native' },
    analytics: { provider: 'native' },
    shipping: { provider: 'native' },
    tax: { provider: 'native' },
    ai: { provider: 'none' },
  },
  http: { adapter: 'fastify', port: 3001 },
  deployment: { strategy: 'standard' },
})
`

const scratch: string[] = []
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

async function project(template: 'astro' | 'nextjs' = 'astro'): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), `scaffold-cli-${template}-`)))
  scratch.push(dir)
  await writeFile(join(dir, 'nymbal.config.ts'), config(template))
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'shop',
        private: true,
        type: 'module',
        scripts: { build: `${template === 'astro' ? 'astro' : 'next'} build` },
      },
      null,
      2,
    ),
  )
  await mkdir(join(dir, 'node_modules', '@nymbalhq'), { recursive: true })
  for (const pkg of ['config', 'platform']) {
    await symlink(join(PACKAGES, pkg), join(dir, 'node_modules', '@nymbalhq', pkg), 'dir')
  }
  return dir
}

/** The process environment minus anything that would pick the database for us. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra }
  if (!('NYMBAL_SQLITE_PATH' in extra)) delete env['NYMBAL_SQLITE_PATH']
  return env
}

function nymbal(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = cleanEnv(),
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  })
}

/** The last lines of a run's output, as the assertion message, so a red run says why. */
const why = (r: SpawnSyncReturns<string>): string =>
  `exit ${r.status}: ${`${r.stderr}\n${r.stdout}`.trim().split('\n').slice(-6).join('\n')}`

function counts(dbPath: string): Counts {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    return Object.fromEntries(
      TABLES.map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]),
    ) as Counts
  } finally {
    db.close()
  }
}

describe('nymbal seed in a fresh project', () => {
  it('AC-7: seed on a project with no database migrates first, exits 0 and leaves the demo categories and products', async () => {
    const dir = await project()
    const db = join(dir, 'nymbal.db')
    expect(existsSync(db)).toBe(false)

    const run = nymbal(dir, ['seed'])
    expect(run.status, why(run)).toBe(0)

    const after = counts(db)
    expect(after.categories).toBe(seedCategories.length)
    expect(after.products).toBe(seedProducts.length)
    expect(after.variants).toBeGreaterThanOrEqual(after.products)
  }, 60_000)

  it('AC-8: on one project, a second seed exits 0 and leaves every table count as the first left it; a seed over a partial demo (categories present, products gone) then exits 0 and duplicates nothing', async () => {
    const dir = await project()
    const db = join(dir, 'nymbal.db')
    // Migrate explicitly, so this test isolates idempotency from AC-7's migrate-first.
    const migrate = nymbal(dir, ['migrate'])
    expect(migrate.status, why(migrate)).toBe(0)

    const first = nymbal(dir, ['seed'])
    expect(first.status, why(first)).toBe(0)
    const once = counts(db)
    expect(once.products).toBeGreaterThan(0)
    expect(once.categories).toBeGreaterThan(0)
    expect(once.customers).toBeGreaterThan(0)

    const second = nymbal(dir, ['seed'])
    expect(second.status, why(second)).toBe(0)
    expect(counts(db)).toEqual(once)

    // As a seed interrupted after the categories, or a merchant who deleted every product, leaves it.
    const writer = new Database(db, { fileMustExist: true })
    try {
      writer.exec('DELETE FROM product_categories; DELETE FROM variants; DELETE FROM products;')
    } finally {
      writer.close()
    }
    const partial = counts(db)
    expect(partial.products).toBe(0)
    expect(partial.categories).toBe(once.categories)

    const again = nymbal(dir, ['seed'])
    expect(again.status, why(again)).toBe(0)
    const after = counts(db)
    for (const table of TABLES) {
      expect(after[table], `${table} after the partial seed`).toBeLessThanOrEqual(once[table])
    }
  }, 90_000)
})

describe('.env', () => {
  it('AC-9: .env sets NYMBAL_SQLITE_PATH for seed, and the same variable in the environment wins over it', async () => {
    const fromDotEnv = await project()
    await writeFile(join(fromDotEnv, '.env'), 'NYMBAL_SQLITE_PATH=./custom.db\n')
    const run = nymbal(fromDotEnv, ['seed'])
    expect(existsSync(join(fromDotEnv, 'custom.db')), `custom.db from .env; ${why(run)}`).toBe(true)
    expect(existsSync(join(fromDotEnv, 'nymbal.db')), 'nymbal.db despite .env').toBe(false)
    expect(run.status, why(run)).toBe(0)
    expect(counts(join(fromDotEnv, 'custom.db')).products).toBe(seedProducts.length)

    const envWins = await project()
    await writeFile(join(envWins, '.env'), 'NYMBAL_SQLITE_PATH=./custom.db\n')
    const run2 = nymbal(envWins, ['seed'], cleanEnv({ NYMBAL_SQLITE_PATH: './from-env.db' }))
    expect(existsSync(join(envWins, 'from-env.db')), `from-env.db; ${why(run2)}`).toBe(true)
    expect(existsSync(join(envWins, 'custom.db')), '.env overrode the environment').toBe(false)
    expect(run2.status, why(run2)).toBe(0)
  }, 60_000)
})

describe('nymbal build outside the workspace', () => {
  for (const template of ['astro', 'nextjs'] as const) {
    it(`AC-10: ${template}: build runs the project's local ${template === 'astro' ? 'astro' : 'next'} binary with \`build\` in the project root, never pnpm --filter`, async () => {
      const dir = await project(template)
      const bin = template === 'astro' ? 'astro' : 'next'
      await writeFile(join(dir, `${bin}.config.mjs`), 'export default {}\n')

      // Every candidate records "<name>|<physical cwd>|<argv>" and succeeds.
      const log = join(dir, 'invocations.log')
      const recorder = `#!/bin/sh\nprintf '%s|%s|%s\\n' "$(basename "$0")" "$(pwd -P)" "$*" >> '${log}'\n`
      const localBin = join(dir, 'node_modules', '.bin')
      const pathBin = join(dir, 'path-bin')
      await mkdir(localBin, { recursive: true })
      await mkdir(pathBin, { recursive: true })
      for (const file of [join(localBin, 'astro'), join(localBin, 'next'), join(pathBin, 'pnpm')]) {
        await writeFile(file, recorder)
        await chmod(file, 0o755)
      }

      const run = nymbal(
        dir,
        ['build'],
        cleanEnv({ PATH: `${pathBin}:${process.env['PATH'] ?? ''}` }),
      )
      const calls = existsSync(log)
        ? (await readFile(log, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => {
              const [name, cwd, args] = line.split('|')
              return { name, cwd, args: args ?? '' }
            })
        : []

      const viaWorkspace = calls.filter((c) => c.name === 'pnpm' || c.args.includes('--filter'))
      expect(viaWorkspace.map((c) => `${c.name} ${c.args}`)).toEqual([])
      const framework = calls.filter((c) => c.name === bin)
      expect(framework, why(run)).toHaveLength(1)
      expect(framework[0]!.args.split(' ')[0]).toBe('build')
      expect(framework[0]!.cwd).toBe(dir)
      expect(run.status, why(run)).toBe(0)
    }, 60_000)
  }
})
