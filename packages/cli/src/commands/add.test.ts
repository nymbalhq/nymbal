import { execFile } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  REPO,
  changedPaths,
  copyProject,
  listing,
  removeAll,
  tempDir,
} from '../recipes/fixtures/linked-project.js'

// Acceptance tests for P2-03 AC-4 (spec P2-03-nymbal-add-recipe, decisions 3 to 7): `nymbal add` through the built CLI
// on temp copies of a scaffold made by create-nymbal-app --no-install, each resolving the built @nymbalhq packages and
// the SDKs through node_modules symlinks, always with --no-install, and with npm_config_user_agent unset so the
// lockfile picks the package manager. Each copy's files (node_modules aside) are hashed before and after a run.
// Kills: a command that touches a template file or leaves a temp file, is not idempotent, overwrites on a conflict,
// changes something on --dry-run, names the wrong install command, or fails on an unset secret it should only report.
// Spawns the built CLI and create-app (`pnpm build` first).

const exec = promisify(execFile)
const CLI = join(REPO, 'packages/cli/bin/nymbal.mjs')
const CREATE_APP = join(REPO, 'packages/create-app/bin/create-nymbal-app.mjs')
const PNPM_LOCK = "lockfileVersion: '9.0'\n"
const NPM_LOCK =
  '{\n  "name": "shop",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {}\n}\n'

const dirs: string[] = []
let scaffolded = ''

/** The parent's environment without a package manager's user agent or any variable a recipe reads. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'npm_config_user_agent') continue
    if (/^(STRIPE_|S3_|AWS_|NYMBAL_S3_|NYMBAL_REDIS_|REDIS_|DATABASE_URL$)/.test(k)) continue
    if (k.startsWith('VITEST')) continue
    env[k] = v
  }
  return env
}

async function run(
  cwd: string,
  args: string[],
  bin: string = CLI,
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [bin, ...args], {
      cwd,
      env: cleanEnv(),
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { code: 0, output: stdout + stderr }
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string; message: string }
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}`,
    }
  }
}

const add = (dir: string, ...args: string[]) => run(dir, ['add', ...args])

/** A fresh copy of the scaffold, with the packages linked (but `omit`) and a pnpm lockfile unless told otherwise. */
function project(label: string, opts: { omit?: string[]; lockfile?: 'pnpm' | 'npm' } = {}): string {
  const dir = copyProject(scaffolded, label, opts.omit ?? [])
  dirs.push(dir)
  if ((opts.lockfile ?? 'pnpm') === 'pnpm') writeFileSync(join(dir, 'pnpm-lock.yaml'), PNPM_LOCK)
  else writeFileSync(join(dir, 'package-lock.json'), NPM_LOCK)
  return dir
}

beforeAll(async () => {
  const base = tempDir('add-base')
  dirs.push(base)
  const made = await run(base, ['shop', '--template', 'astro', '--yes', '--no-install'], CREATE_APP)
  if (made.code !== 0) throw new Error(`create-nymbal-app failed:\n${made.output}`)
  scaffolded = join(base, 'shop')
  // A stray lockfile from the scaffold would decide the package manager instead of the one each test writes.
  for (const f of ['pnpm-lock.yaml', 'package-lock.json'])
    rmSync(join(scaffolded, f), { force: true })
}, 120_000)

afterAll(() => removeAll(dirs))

describe('P2-03 AC-4: nymbal add', () => {
  it('AC-4: `nymbal add redis` exits 0 and changes only nymbal.config.ts and .env.example; a second run changes nothing and exits 0', async () => {
    const dir = project('redis')
    const before = listing(dir)

    const first = await add(dir, 'redis', '--no-install')
    expect(first.code, first.output).toBe(0)
    const once = listing(dir)
    expect(changedPaths(before, once)).toEqual(['.env.example', 'nymbal.config.ts'])
    expect(readFileSync(join(dir, 'nymbal.config.ts'), 'utf8')).toMatch(/redis-streams/)

    const second = await add(dir, 'redis', '--no-install')
    expect(second.code, second.output).toBe(0)
    const twice = listing(dir)
    expect(changedPaths(once, twice)).toHaveLength(0)
    expect(twice.get('nymbal.config.ts')).toBe(once.get('nymbal.config.ts'))
  })

  it("AC-4: after a hand edit to documentStore: 'postgres-jsonb', `nymbal add redis` exits 1 naming the path and both values, and leaves the files byte-identical", async () => {
    const dir = project('conflict')
    const path = join(dir, 'nymbal.config.ts')
    const original = readFileSync(path, 'utf8')
    const edited = original.replace(/documentStore: 'in-memory'/, "documentStore: 'postgres-jsonb'")
    expect(edited, 'the scaffold config names the in-memory document store').not.toBe(original)
    writeFileSync(path, edited)
    const before = listing(dir)

    const result = await add(dir, 'redis', '--no-install')
    expect(result.code, result.output).toBe(1)
    expect(result.output).toContain('infrastructure.documentStore')
    expect(result.output).toContain('postgres-jsonb')
    expect(result.output).toMatch(/\bredis\b/)
    const after = listing(dir)
    expect(after.get('nymbal.config.ts'), 'nymbal.config.ts is byte-identical').toBe(
      before.get('nymbal.config.ts'),
    )
    expect(changedPaths(before, after)).toHaveLength(0)
  })

  it('AC-4: `nymbal add redis --dry-run` prints the config change, the .env.example lines and the install line, and changes nothing', async () => {
    const dir = project('dry-run')
    const before = listing(dir)

    const result = await add(dir, 'redis', '--dry-run')
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain('redis-streams')
    expect(result.output).toContain('REDIS_URL=redis://localhost:6379')
    expect(result.output).toMatch(/pnpm add [^\n]*ioredis/)
    expect(changedPaths(before, listing(dir))).toHaveLength(0)
  })

  it('AC-4: an unknown recipe exits 1, lists postgres, redis, s3, stripe, and changes nothing', async () => {
    const dir = project('unknown')
    const before = listing(dir)

    const result = await add(dir, 'p2-03-no-such-recipe', '--no-install')
    expect(result.code, result.output).toBe(1)
    expect(result.output).toMatch(/postgres,\s*redis,\s*s3,\s*stripe/)
    expect(changedPaths(before, listing(dir))).toHaveLength(0)
  })

  it.each([
    ['pnpm', 'pnpm add @nymbalhq/media-s3'],
    ['npm', 'npm install @nymbalhq/media-s3'],
  ] as const)(
    'AC-4: --no-install with the holder not installed exits 1 with the install line for %s (from its lockfile), and changes nothing',
    async (lockfile, line) => {
      const dir = project(`no-holder-${lockfile}`, { omit: ['@nymbalhq/media-s3'], lockfile })
      const before = listing(dir)

      const result = await add(dir, 's3', '--no-install')
      expect(result.code, result.output).toBe(1)
      expect(result.output).toContain(line)
      expect(changedPaths(before, listing(dir))).toHaveLength(0)
    },
  )

  it('AC-4: `nymbal add stripe` with no Stripe env set exits 0 and prints "set STRIPE_SECRET_KEY in .env"', async () => {
    const dir = project('stripe')
    const before = listing(dir)

    const result = await add(dir, 'stripe', '--no-install')
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain('set STRIPE_SECRET_KEY in .env')
    expect(changedPaths(before, listing(dir))).toEqual(['.env.example', 'nymbal.config.ts'])
  })

  it('AC-4: after `nymbal add stripe` with no Stripe env set, `nymbal add postgres` exits 0 and edits the config again', async () => {
    const dir = project('stripe-postgres')

    const stripe = await add(dir, 'stripe', '--no-install')
    expect(stripe.code, stripe.output).toBe(0)
    const afterStripe = listing(dir)

    const postgres = await add(dir, 'postgres', '--no-install')
    expect(postgres.code, postgres.output).toBe(0)
    expect(changedPaths(afterStripe, listing(dir))).toContain('nymbal.config.ts')
    expect(readFileSync(join(dir, 'nymbal.config.ts'), 'utf8')).toMatch(
      /commandStore: ['"]postgres['"]/,
    )
  })

  it("AC-4: with an enum field read as env('X', <valid default>) and X unset, `nymbal add postgres` exits 0: the default, not a placeholder, is validated", async () => {
    const dir = project('env-default')
    const path = join(dir, 'nymbal.config.ts')
    const original = readFileSync(path, 'utf8')
    const edited = original
      .replace(
        "import { defineConfig } from '@nymbalhq/config'",
        "import { defineConfig, env } from '@nymbalhq/config'",
      )
      .replace("xFrameOptions: 'deny'", "xFrameOptions: env('P2_03_X_FRAME_OPTIONS', 'deny')")
    expect(edited.match(/env\(/g), 'the scaffold config has the import and the field').toHaveLength(
      1,
    )
    expect(edited).toContain('import { defineConfig, env }')
    writeFileSync(path, edited)
    expect(cleanEnv()['P2_03_X_FRAME_OPTIONS']).toBeUndefined()

    const postgres = await add(dir, 'postgres', '--no-install')
    expect(postgres.code, postgres.output).toBe(0)
    const after = readFileSync(path, 'utf8')
    expect(after).toMatch(/commandStore: ['"]postgres['"]/)
    expect(after).toContain("xFrameOptions: env('P2_03_X_FRAME_OPTIONS', 'deny')")
  })
})
