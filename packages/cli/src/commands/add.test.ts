import { execFile } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { conventionPackage, loadConfig } from '@nymbalhq/config'
import { readRecipe } from '../recipes/index.js'
import { WINDOW_PERIODS } from '../../../adapters/security/cloudflare/src/rules.js'
import {
  REPO,
  changedPaths,
  copyProject,
  listing,
  removeAll,
  tempDir,
} from '../recipes/fixtures/linked-project.js'

// AC-4: `nymbal add` through the built CLI on temp copies of a create-nymbal-app --no-install scaffold, always with
// --no-install; each copy's files (node_modules aside) are hashed before and after a run. Needs `pnpm build`.

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
    if (/^(STRIPE_|S3_|AWS_|NYMBAL_S3_|NYMBAL_REDIS_|REDIS_|CLOUDFLARE_|DATABASE_URL$)/.test(k))
      continue
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

// Quarantined to the nightly project (vitest.config.ts): the CLI spawns time out under load, red then green with no
// code change.
describe('AC-4: nymbal add', { timeout: 30_000 }, () => {
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
  }, 60_000)

  it("AC-4: after a hand edit to documentStore: { provider: 'postgres-jsonb' }, `nymbal add redis` exits 1 naming the path and both values, and leaves the files byte-identical", async () => {
    const dir = project('conflict')
    const path = join(dir, 'nymbal.config.ts')
    const original = readFileSync(path, 'utf8')
    const edited = original.replace(
      /documentStore: \{ provider: 'in-memory' \}/,
      "documentStore: { provider: 'postgres-jsonb' }",
    )
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

  it('AC-4: an unknown recipe exits 1, lists cloudflare, postgres, redis, s3, stripe, and changes nothing', async () => {
    const dir = project('unknown')
    const before = listing(dir)

    const result = await add(dir, 'recipes-no-such-recipe', '--no-install')
    expect(result.code, result.output).toBe(1)
    expect(result.output).toMatch(/cloudflare,\s*postgres,\s*redis,\s*s3,\s*stripe/)
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

  // A variable the package declares as a setting can come from the admin's Settings as well.
  it('AC-4: `nymbal add stripe` with no Stripe env set exits 0 and prints "set STRIPE_SECRET_KEY in .env or in the admin\'s Settings"', async () => {
    const dir = project('stripe')
    const before = listing(dir)

    const result = await add(dir, 'stripe', '--no-install')
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("set STRIPE_SECRET_KEY in .env or in the admin's Settings")
    expect(result.output).toContain("set STRIPE_WEBHOOK_SECRET in .env or in the admin's Settings")
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
      .replace("xFrameOptions: 'deny'", "xFrameOptions: env('RECIPES_X_FRAME_OPTIONS', 'deny')")
    expect(
      edited.match(/env\(/g)?.length,
      'the edited config has one env() read more than the scaffold: the field',
    ).toBe((original.match(/env\(/g)?.length ?? 0) + 1)
    expect(edited).toContain('import { defineConfig, env }')
    writeFileSync(path, edited)
    expect(cleanEnv()['RECIPES_X_FRAME_OPTIONS']).toBeUndefined()

    const postgres = await add(dir, 'postgres', '--no-install')
    expect(postgres.code, postgres.output).toBe(0)
    const after = readFileSync(path, 'utf8')
    expect(after).toMatch(/commandStore: ['"]postgres['"]/)
    expect(after).toContain("xFrameOptions: env('RECIPES_X_FRAME_OPTIONS', 'deny')")
  })

  it("AC-4: with an enum field read as env('X', <valid default>) and an invalid X in .env, `nymbal add postgres` exits 1 and leaves the config byte-identical: .env applies as `nymbal dev` loads it", async () => {
    const dir = project('env-default-dotenv')
    const path = join(dir, 'nymbal.config.ts')
    const original = readFileSync(path, 'utf8')
    const edited = original
      .replace(
        "import { defineConfig } from '@nymbalhq/config'",
        "import { defineConfig, env } from '@nymbalhq/config'",
      )
      .replace("xFrameOptions: 'deny'", "xFrameOptions: env('RECIPES_X_FRAME_OPTIONS', 'deny')")
    expect(
      edited.match(/env\(/g)?.length,
      'the edited config has one env() read more than the scaffold: the field',
    ).toBe((original.match(/env\(/g)?.length ?? 0) + 1)
    expect(edited).toContain('import { defineConfig, env }')
    writeFileSync(path, edited)
    writeFileSync(join(dir, '.env'), 'RECIPES_X_FRAME_OPTIONS=not-a-frame-option\n')
    expect(cleanEnv()['RECIPES_X_FRAME_OPTIONS']).toBeUndefined()
    const before = listing(dir)

    const postgres = await add(dir, 'postgres', '--no-install')
    expect(postgres.code, postgres.output).toBe(1)
    expect(postgres.output).toContain('xFrameOptions')
    expect(readFileSync(path, 'utf8')).toBe(edited)
    expect(changedPaths(before, listing(dir))).toHaveLength(0)
  })
})

// AC-9: `nymbal add cloudflare` installs the security package, sets `security.adapter` and `security.cloudflare` to
// two `env()` reads, adds both variables to .env.example, and names the token scopes and `http.trustProxy`. The
// scaffold's rate limits use windows Cloudflare has a period for, so the first `security:plan` is not refused.

describe('AC-9: nymbal add cloudflare', () => {
  const securityPackage = (): string => conventionPackage('security', 'cloudflare')

  it("AC-9: --dry-run names the install of the package conventionPackage('security', 'cloudflare') names and changes nothing; the run sets security.adapter and security.cloudflare to the two env() reads and adds both variables to .env.example", async () => {
    const dir = project('cloudflare')
    const before = listing(dir)
    const pkg = securityPackage()
    expect(pkg).toBe('@nymbalhq/security-cloudflare')

    const dry = await add(dir, 'cloudflare', '--dry-run')
    expect(dry.code, dry.output).toBe(0)
    expect(dry.output).toContain(`pnpm add ${pkg}`)
    expect((await readRecipe('cloudflare', dir)).install).toEqual([pkg])
    expect(changedPaths(before, listing(dir))).toHaveLength(0)

    const result = await add(dir, 'cloudflare', '--no-install')
    expect(result.code, result.output).toBe(0)
    expect(changedPaths(before, listing(dir))).toEqual(['.env.example', 'nymbal.config.ts'])
    const source = readFileSync(join(dir, 'nymbal.config.ts'), 'utf8')
    expect(source).toMatch(/zoneId: env\(['"]CLOUDFLARE_ZONE_ID['"]\)/)
    expect(source).toMatch(/apiToken: env\(['"]CLOUDFLARE_API_TOKEN['"]\)/)
    const example = readFileSync(join(dir, '.env.example'), 'utf8')
    expect(example).toMatch(/^CLOUDFLARE_ZONE_ID=$/m)
    expect(example).toMatch(/^CLOUDFLARE_API_TOKEN=$/m)

    // Loaded with both variables set, as `nymbal dev` loads it, the config carries what the environment holds.
    const set = { CLOUDFLARE_ZONE_ID: 'cf-zone-3f9a', CLOUDFLARE_API_TOKEN: 'cf-token-8c1d' }
    const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]))
    Object.assign(process.env, set)
    let security: Record<string, unknown>
    try {
      security = (await loadConfig(dir)).config.security as Record<string, unknown>
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    expect(security['adapter']).toBe('cloudflare')
    expect(security['cloudflare']).toEqual(
      expect.objectContaining({
        zoneId: set.CLOUDFLARE_ZONE_ID,
        apiToken: set.CLOUDFLARE_API_TOKEN,
      }),
    )

    // Every rate limit the scaffold ships keeps a window the Cloudflare adapter has a period for, so the store's
    // first security:plan is refused only for what the zone's plan disallows, never for the window itself.
    const rateLimit = security['rateLimit'] as Record<string, { window: string }>
    expect(Object.keys(rateLimit).length).toBeGreaterThanOrEqual(4)
    for (const [path, rule] of Object.entries(rateLimit)) {
      expect(Object.keys(WINDOW_PERIODS), `${path}: window ${rule.window}`).toContain(rule.window)
    }
  }, 60_000)

  // The fragment cache rule needs Zone › Cache Rules › Edit, named beside the other two scopes in the same step.
  it("AC-9: the recipe's next steps name the token scopes (Zone Read, Zone WAF Edit, Cache Rules Edit), http.trustProxy, that throttle needs the Enterprise plan and that the plan caps the rate limits", async () => {
    const dir = project('cloudflare-next')
    const next = (await readRecipe('cloudflare', dir)).next.join('\n')
    expect(next).toMatch(/Zone WAF/)
    expect(next).toMatch(/Zone\s*›?\s*Zone\s*›?\s*Read|Zone Read/)
    const tokenStep = (await readRecipe('cloudflare', dir)).next.find((s) => /Zone WAF/.test(s))
    expect(tokenStep).toMatch(/Zone\s*›\s*Cache Rules\s*›\s*Edit/)
    expect(next).toContain('trustProxy')
    expect(next).toMatch(/throttle[^.]*Enterprise/)
    expect(next).toMatch(/block or challenge/)
    expect(next).toMatch(/Free plan allows one rate limit/)
  })
})
