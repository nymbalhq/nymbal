import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import fc from 'fast-check'
import { parse as parseToml } from 'smol-toml'
import { afterAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { flyRecipe, railwayRecipe } from './deploy.js'

// AC-9: the Fly and Railway recipes deploy with readiness, migrations once per deploy and the secrets key from the
// platform's secret store. AC-10 (unit half): no recipe file and no step holds a value from the project's .env.

/** `start`'s shutdown bound when NYMBAL_SHUTDOWN_MS is unset. */
const DEFAULT_SHUTDOWN_MS = 10_000

const config: NymbalConfig = nymbalConfigSchema.parse({
  store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
  template: 'astro',
  infrastructure: {
    commandStore: 'postgres',
    documentStore: { provider: 'redis' },
    eventBus: { provider: 'redis-streams' },
  },
  security: { adapter: 'middleware' },
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
  http: { adapter: 'fastify' },
  deployment: { strategy: 'standard' },
})

const roots: string[] = []
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** A project directory named `name`, with `env` as its .env. */
function projectDir(name: string, env: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-recipe-'))
  roots.push(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, private: true, packageManager: 'pnpm@10.18.0' }),
  )
  writeFileSync(join(dir, 'Dockerfile'), 'FROM node:26.12.1\n')
  writeFileSync(
    join(dir, '.env'),
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  )
  return dir
}

const appName = fc.stringMatching(/^[a-z][a-z0-9]{1,10}(-[a-z0-9]{1,8})?$/)

/** Seconds in a Fly duration: a number of seconds or a string such as "15s". */
function seconds(value: unknown): number {
  if (typeof value === 'number') return value
  const m = /^(\d+)s$/.exec(String(value))
  return m ? Number(m[1]) : Number.NaN
}

interface FlyToml {
  app?: string
  kill_signal?: string
  kill_timeout?: unknown
  deploy?: { release_command?: string }
  env?: Record<string, string>
  http_service?: { internal_port?: number; checks?: Array<{ path?: string; method?: string }> }
}

interface RailwayJson {
  build?: { builder?: string }
  deploy?: { healthcheckPath?: string; preDeployCommand?: string | string[]; startCommand?: string }
}

describe('AC-9: the Fly recipe', () => {
  it('AC-9: fly.toml serves 3001 with an http check on /ready, runs nymbal migrate as the release command, gives SIGTERM a kill_timeout above the shutdown bound, and sets NYMBAL_PUBLIC_URL to the app https origin; the key goes through fly secrets, never the file, before the deploy', () => {
    fc.assert(
      fc.property(appName, (name) => {
        const recipe: { file: string; toml: string; steps: string[] } = flyRecipe({
          name,
          root: projectDir(name),
          config,
        })
        const parsed = parseToml(recipe.toml) as FlyToml
        const publicUrl = parsed.env?.['NYMBAL_PUBLIC_URL'] ?? ''
        const keySteps = recipe.steps.filter((step) => step.includes('NYMBAL_SECRETS_KEY'))
        const at = (pattern: RegExp) => recipe.steps.findIndex((step) => pattern.test(step))
        const deployAt = at(/\b(fly|flyctl) deploy\b/)

        expect(basename(recipe.file)).toBe('fly.toml')
        expect(parsed.http_service?.internal_port).toBe(3001)
        expect(
          (parsed.http_service?.checks ?? []).filter(
            (c) => c.path === '/ready' && (c.method ?? 'GET').toUpperCase() === 'GET',
          ),
        ).toHaveLength(1)
        expect(parsed.deploy?.release_command).toMatch(/\bnymbal(\.mjs)? migrate$/)
        expect(parsed.kill_signal).toBe('SIGTERM')
        expect(seconds(parsed.kill_timeout)).toBeGreaterThan(DEFAULT_SHUTDOWN_MS / 1000)
        expect(publicUrl).toBe(`https://${name}.fly.dev`)
        expect(new URL(publicUrl).origin).toBe(publicUrl)
        expect(recipe.toml).not.toContain('NYMBAL_SECRETS_KEY')
        expect(keySteps).toHaveLength(1)
        expect(keySteps[0]).toMatch(/\bsecrets set\b.*NYMBAL_SECRETS_KEY=<from \.env>/)
        expect(deployAt).toBeGreaterThan(at(/NYMBAL_SECRETS_KEY/))
        expect(deployAt).toBeGreaterThan(at(/postgres/i))
        expect(deployAt).toBeGreaterThan(at(/redis/i))
        expect(
          Math.min(at(/postgres/i), at(/redis/i), at(/NYMBAL_SECRETS_KEY/)),
        ).toBeGreaterThanOrEqual(0)
      }),
      { numRuns: 30 },
    )
  })
})

describe('AC-9: the Railway recipe', () => {
  it('AC-9: railway.json builds from the Dockerfile, checks /ready, runs nymbal migrate before each deploy and starts nymbal start; the steps put the key in the service variables, never the file, and set NYMBAL_PUBLIC_URL to the public domain', () => {
    fc.assert(
      fc.property(appName, (name) => {
        const recipe: { file: string; json: string; steps: string[] } = railwayRecipe({
          name,
          root: projectDir(name),
          config,
        })
        const parsed = JSON.parse(recipe.json) as RailwayJson
        const preDeploy = [parsed.deploy?.preDeployCommand ?? []].flat().join(' && ')

        expect(basename(recipe.file)).toBe('railway.json')
        expect(parsed.build?.builder).toBe('DOCKERFILE')
        expect(parsed.deploy?.healthcheckPath).toBe('/ready')
        expect(preDeploy).toMatch(/\bnymbal(\.mjs)? migrate\b/)
        expect(parsed.deploy?.startCommand).toMatch(/\bnymbal(\.mjs)? start\b/)
        expect(recipe.json).not.toContain('NYMBAL_SECRETS_KEY')
        expect(
          recipe.steps.filter((s) => s.includes('NYMBAL_SECRETS_KEY=<from .env>')),
        ).toHaveLength(1)
        expect(
          recipe.steps.filter((s) =>
            s.includes('NYMBAL_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}'),
          ),
        ).toHaveLength(1)
      }),
      { numRuns: 30 },
    )
  })
})

const secret = fc.stringMatching(/^[A-Za-z0-9+/=_.:@-]{16,48}$/).filter((s) => new Set(s).size >= 8)

describe('AC-9: what production refuses comes first', () => {
  it('AC-9: with native payments or the default jwtSecret, each recipe names that change as a step before any platform step, and with neither it names none; an own jwtSecret is in no step', () => {
    fc.assert(
      fc.property(
        appName,
        fc.constantFrom('native', 'stripe'),
        fc.option(
          fc.stringMatching(/^[A-Za-z0-9]{16,40}$/).filter((s) => new Set(s).size >= 6),
          { nil: undefined },
        ),
        (name, payments, jwtSecret) => {
          const variant: NymbalConfig = {
            ...config,
            commerce: {
              ...config.commerce,
              payments: { ...config.commerce.payments, provider: payments },
            },
            security: {
              ...config.security,
              auth: { ...config.security.auth, ...(jwtSecret !== undefined && { jwtSecret }) },
            },
          }
          const root = projectDir(name)
          for (const [tool, recipe] of [
            ['flyctl', flyRecipe({ name, root, config: variant })],
            ['railway', railwayRecipe({ name, root, config: variant })],
          ] as const) {
            const first = recipe.steps.findIndex((step) => step.startsWith(`${tool} `))
            const before = recipe.steps.slice(0, first).join('\n')

            expect(first).toBeGreaterThanOrEqual(0)
            expect([/payments provider/.test(before), /security\.auth\.jwtSecret/.test(before)]).toEqual(
              [payments === 'native', jwtSecret === undefined],
            )
            expect(
              recipe.steps.slice(first).filter((step) => /payments provider|jwtSecret/.test(step)),
            ).toEqual([])
            expect(
              recipe.steps.filter((step) => jwtSecret !== undefined && step.includes(jwtSecret)),
            ).toEqual([])
          }
        },
      ),
      { numRuns: 40 },
    )
  })
})

describe('AC-10: no .env value leaves .env', () => {
  it('AC-10: for random .env values, neither recipe file nor any step holds one', () => {
    fc.assert(
      fc.property(
        appName,
        fc.record({
          NYMBAL_SECRETS_KEY: secret,
          DATABASE_URL: secret.map((s) => `postgres://shop:${s}@db.internal:5432/shop`),
          REDIS_URL: secret.map((s) => `redis://:${s}@cache.internal:6379/0`),
          NYMBAL_ADMIN_PASSWORD: secret,
          STRIPE_SECRET_KEY: secret.map((s) => `sk_live_${s}`),
        }),
        (name, env) => {
          const root = projectDir(name, env)
          const fly: { toml: string; steps: string[] } = flyRecipe({ name, root, config })
          const railway: { json: string; steps: string[] } = railwayRecipe({ name, root, config })
          const out = [fly.toml, ...fly.steps, railway.json, ...railway.steps]

          expect(
            Object.values(env).filter((value) => out.some((text) => text.includes(value))),
          ).toEqual([])
        },
      ),
      { numRuns: 50 },
    )
  })
})
