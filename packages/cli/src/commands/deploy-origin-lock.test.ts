import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { parse as parseToml } from 'smol-toml'
import { afterEach, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { cliEnv, runCli } from '../../../../tests/support/doctor.js'
import { storeConfig, storeProject } from '../../../../tests/support/start.js'
import { flyRecipe, railwayRecipe, type DeployProject } from './deploy.js'

// On a Cloudflare store the origin lock refuses the platform's own host, so the Fly and Railway recipes point the store
// at its own domain (NYMBAL_PUBLIC_URL from .env) and set NYMBAL_ORIGIN_SECRET from .env before the deploy step. A
// missing or platform-host public URL stops the command before anything is written; every `<from .env>` a live run
// needs is checked before the platform's CLI is first called, in one message. A `middleware` store's recipes are as
// they were. The CLI cases spawn the built CLI (`pnpm build` first).

const VAR = 'NYMBAL_ORIGIN_SECRET'

function configOf(adapter: 'cloudflare' | 'middleware', payments = 'native'): NymbalConfig {
  const raw = storeConfig() as {
    security: Record<string, unknown>
    commerce: Record<string, unknown>
  }
  return nymbalConfigSchema.parse({
    ...raw,
    security:
      adapter === 'cloudflare'
        ? {
            ...raw.security,
            adapter,
            cloudflare: { zoneId: 'zone-deploy', apiToken: 'token-deploy' },
          }
        : raw.security,
    commerce: { ...raw.commerce, payments: { provider: payments } },
  })
}

const CLOUDFLARE = configOf('cloudflare')
const MIDDLEWARE = configOf('middleware')

/** The recipes for a project; `publicUrl` is .env's NYMBAL_PUBLIC_URL. */
function recipes(name: string, config: NymbalConfig, publicUrl: string) {
  const project = { name, root: '/srv/shop', config, publicUrl } as DeployProject
  return { fly: flyRecipe(project), railway: railwayRecipe(project) }
}

const appName = fc.stringMatching(/^[a-z][a-z0-9]{1,10}(-[a-z0-9]{1,8})?$/)
const PLATFORM_HOST = /(^|\.)(fly\.dev|railway\.app)$/
const publicUrlArb = fc
  .domain()
  .filter((host) => !PLATFORM_HOST.test(host))
  .map((host) => `https://${host}`)

describe('AC-13: the recipes on a Cloudflare store', () => {
  it("AC-13: property: for any app name and non-platform https public URL U, a cloudflare store's fly.toml has NYMBAL_PUBLIC_URL U and no .fly.dev host, its Railway steps set NYMBAL_PUBLIC_URL from .env and never name RAILWAY_PUBLIC_DOMAIN, and each platform sets NYMBAL_ORIGIN_SECRET from .env before its deploy step; a middleware store's recipes keep the platform host and set no secret", () => {
    fc.assert(
      fc.property(appName, publicUrlArb, (name, url) => {
        const cf = recipes(name, CLOUDFLARE, url)
        const mw = recipes(name, MIDDLEWARE, url)
        const flyEnv = (toml: string) =>
          (parseToml(toml) as { env?: Record<string, string> }).env ?? {}
        const flySecret = `flyctl secrets set ${VAR}=<from .env> --app ${name} --stage`
        const railwaySecret = `railway variables --service ${name} --set ${VAR}=<from .env>`
        const before = (steps: string[], step: string, deploy: string) =>
          steps.indexOf(step) >= 0 && steps.indexOf(step) < steps.indexOf(deploy)

        expect(flyEnv(cf.fly.toml)['NYMBAL_PUBLIC_URL']).toBe(url)
        expect(cf.fly.toml.includes('.fly.dev')).toBe(false)
        expect(cf.railway.steps).toContain(
          `railway variables --service ${name} --set NYMBAL_PUBLIC_URL=<from .env>`,
        )
        expect(cf.railway.steps.filter((s) => s.includes('RAILWAY_PUBLIC_DOMAIN'))).toEqual([])
        expect(before(cf.fly.steps, flySecret, `flyctl deploy --app ${name}`)).toBe(true)
        expect(before(cf.railway.steps, railwaySecret, `railway up --service ${name}`)).toBe(true)

        expect(flyEnv(mw.fly.toml)['NYMBAL_PUBLIC_URL']).toBe(`https://${name}.fly.dev`)
        expect(mw.railway.steps.filter((s) => s.includes('RAILWAY_PUBLIC_DOMAIN')).length).toBe(1)
        expect([...mw.fly.steps, ...mw.railway.steps].filter((s) => s.includes(VAR))).toEqual([])
      }),
      { numRuns: 100 },
    )
  })
})

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

/** A cloudflare store project with `dotEnv` as its .env and a PATH holding node and, when given, a recording flyctl. */
function cloudflareProject(
  dotEnv: Record<string, string>,
  opts: { payments?: string; flyctl?: boolean } = {},
) {
  const raw = storeConfig() as {
    security: Record<string, unknown>
    commerce: Record<string, unknown>
  }
  const p = storeProject({
    ...raw,
    security: {
      ...raw.security,
      adapter: 'cloudflare',
      cloudflare: { zoneId: 'zone-deploy', apiToken: 'token-deploy' },
    },
    commerce: { ...raw.commerce, payments: { provider: opts.payments ?? 'native' } },
  })
  cleanup.push(() => p.remove())
  writeFileSync(
    join(p.dir, '.env'),
    `${Object.entries(dotEnv)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
  )
  writeFileSync(join(p.dir, 'Dockerfile'), 'FROM node:26.12.1\n')
  const bin = join(p.dir, 'path-bin')
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  const calls = join(p.dir, 'flyctl-calls.log')
  if (opts.flyctl === true) {
    const stub = join(bin, 'flyctl')
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`)
    chmodSync(stub, 0o755)
  }
  const env = cliEnv({
    PATH: bin,
    NYMBAL_PUBLIC_URL: undefined,
    NYMBAL_SECRETS_KEY: undefined,
    NYMBAL_JWT_SECRET: undefined,
    [VAR]: undefined,
  })
  return {
    dir: p.dir,
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : ''),
    deploy: (...args: string[]) => runCli(['deploy', ...args], { cwd: p.dir, env }),
  }
}

describe('AC-13: nymbal deploy on a Cloudflare store', () => {
  it('AC-13: deploy fly --dry-run and deploy railway --dry-run with .env’s NYMBAL_PUBLIC_URL unset, https://shop.fly.dev, https://shop.railway.app or https://shop.up.railway.app exit 1 naming NYMBAL_PUBLIC_URL and the Cloudflare domain and write no file; with https://shop.example they write the recipe', async () => {
    const refused = [
      undefined,
      'https://shop.fly.dev',
      'https://shop.railway.app',
      'https://shop.up.railway.app',
    ]
    const outcomes: Array<{ code: number; names: boolean; wrote: boolean }> = []
    for (const url of refused) {
      for (const platform of ['fly', 'railway'] as const) {
        const p = cloudflareProject(url === undefined ? {} : { NYMBAL_PUBLIC_URL: url })
        const run = await p.deploy(platform, '--dry-run')
        outcomes.push({
          code: run.code,
          names: run.out.includes('NYMBAL_PUBLIC_URL') && /cloudflare/i.test(run.out),
          wrote: existsSync(join(p.dir, 'fly.toml')) || existsSync(join(p.dir, 'railway.json')),
        })
      }
    }
    const accepted = cloudflareProject({ NYMBAL_PUBLIC_URL: 'https://shop.example' })
    const ok = await accepted.deploy('fly', '--dry-run')
    const toml = existsSync(join(accepted.dir, 'fly.toml'))
      ? readFileSync(join(accepted.dir, 'fly.toml'), 'utf8')
      : ''

    expect(outcomes).toEqual(outcomes.map(() => ({ code: 1, names: true, wrote: false })))
    expect(ok.code, ok.out).toBe(0)
    expect((parseToml(toml) as { env?: Record<string, string> }).env?.['NYMBAL_PUBLIC_URL']).toBe(
      'https://shop.example',
    )
  }, 180_000)

  it(`AC-13: deploy fly (not a dry run) on a cloudflare store with Stripe payments, with ${VAR} and NYMBAL_JWT_SECRET missing from .env, exits 1 naming both (nymbal security:apply for the first) before flyctl is called at all`, async () => {
    const p = cloudflareProject(
      {
        NYMBAL_PUBLIC_URL: 'https://shop.example',
        NYMBAL_SECRETS_KEY: 'c2VjcmV0cy1rZXktZm9yLWRlcGxveS10ZXN0LTMyYnl0ZXM=',
      },
      { payments: 'stripe', flyctl: true },
    )

    const run = await p.deploy('fly')
    expect(run.code, run.out).toBe(1)
    expect(
      [VAR, 'NYMBAL_JWT_SECRET', 'nymbal security:apply'].filter((w) => !run.out.includes(w)),
    ).toEqual([])
    expect(p.calls()).toBe('')
  }, 60_000)
})
