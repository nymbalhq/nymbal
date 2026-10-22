import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import { buildSecurityHeaders } from '../../src/adapters/security/headers.js'
import { serveKernel } from '../support/http.js'
import { createKernel, kernelConfig } from '../support/kernel.js'
import {
  startFakeCloudflare,
  type FakeCloudflare,
} from '../../../security-cloudflare/src/tests/fake-cloudflare.js'

// Acceptance tests for P2-04 AC-2 (spec P2-04-cloudflare-waf, Decisions 1, 2 and 6): `createApp` honours
// `security.adapter`. With `cloudflare` (its apiBase on the fake) it builds the Cloudflare adapter, so the capability
// report lists `edge-rules`, it sets the same response headers on GET /health as a `middleware` store, and it makes no
// request to Cloudflare at boot. With `aws-waf` or `akamai` it refuses with a ConfigError naming the adapters that
// exist. Without the package installed it fails with the loader's install line (the P2-01 child process, from the
// built dist: `pnpm build` first). Kills: a registry that ignores `security.adapter`, a boot that writes to the zone,
// and `aws-waf` silently running middleware.

const exec = promisify(execFile)
const CHILD = fileURLToPath(new URL('./fixtures/adapter-graph/child.mjs', import.meta.url))
const TOKEN = 'cf-p2-04-boot-token'

let fake: FakeCloudflare
let zoneId = ''
const dirs: string[] = []

beforeAll(async () => {
  fake = await startFakeCloudflare()
  zoneId = fake.addZone({ plan: 'pro', token: TOKEN })
})
afterAll(async () => {
  await fake.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function withAdapter(adapter: string, extra: Record<string, unknown> = {}) {
  return (config: NymbalConfig): NymbalConfig =>
    nymbalConfigSchema.parse({ ...config, security: { ...config.security, adapter, ...extra } })
}

const withCloudflare = (apiBase: () => string) =>
  withAdapter('cloudflare', {
    cloudflare: { zoneId, apiToken: TOKEN, apiBase: apiBase() },
    geo: { block: ['RU'] },
  })

type Report = Record<string, { provider: string; capabilities: readonly string[] }>

describe('P2-04 AC-2: createApp builds the adapter security.adapter names', () => {
  it('AC-2 (a)(b)(c): with cloudflare, the capability report lists edge-rules, GET /health carries the same security headers as a middleware store, and the fake saw no request during boot', async () => {
    const requestsBefore = fake.requests.length
    const cloudflare = await serveKernel(
      await createKernel({ dialect: 'sqlite', configure: withCloudflare(() => fake.url) }),
    )
    const middleware = await serveKernel(await createKernel({ dialect: 'sqlite' }))
    try {
      const report = (cloudflare.kernel.app as unknown as { capabilities(): Report }).capabilities()
      expect(report['security']?.provider).toBe('cloudflare')
      expect(report['security']?.capabilities).toContain('edge-rules')

      const names = Object.keys(buildSecurityHeaders(middleware.kernel.config.security))
      expect(names.length).toBeGreaterThan(0)
      const [cf, mw] = await Promise.all([
        fetch(new URL('/health', cloudflare.baseUrl)),
        fetch(new URL('/health', middleware.baseUrl)),
      ])
      const pick = (headers: Headers) => names.map((n) => [n, headers.get(n)])
      expect(pick(cf.headers)).toEqual(pick(mw.headers))
      expect(pick(mw.headers).every(([, v]) => v !== null)).toBe(true)

      expect(fake.requests.length).toBe(requestsBefore)
    } finally {
      await cloudflare.stop()
      await middleware.stop()
    }
  }, 60_000)

  it.each(['aws-waf', 'akamai'])(
    'AC-2: with %s, createApp throws a ConfigError naming middleware, cloudflare',
    async (adapter) => {
      const outcome = await createKernel({
        dialect: 'sqlite',
        configure: withAdapter(adapter),
      }).then(
        async (k) => {
          await k.close()
          return null
        },
        (error: unknown) => error,
      )
      expect(outcome).toBeInstanceOf(ConfigError)
      expect(String((outcome as Error).message)).toContain('middleware, cloudflare')
    },
    60_000,
  )

  it('AC-2: with @nymbalhq/security-cloudflare not installed, createApp fails adapter.package_missing with the install line and no SDK in it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p2-04-missing-'))
    dirs.push(dir)
    const out = join(dir, 'resolved.txt')
    writeFileSync(out, '')
    const config = withCloudflare(() => fake.url)(kernelConfig('sqlite'))
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env['npm_config_user_agent']
    const { stdout } = await exec(process.execPath, [CHILD, JSON.stringify(config)], {
      cwd: dir,
      env: {
        ...env,
        P2_01_GRAPH: JSON.stringify({ out, hide: ['@nymbalhq/security-cloudflare'] }),
      },
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    const line = stdout.split('\n').find((l) => l.startsWith('P2-01-OUTCOME '))
    const outcome = JSON.parse(line!.slice('P2-01-OUTCOME '.length)) as {
      started?: unknown
      error?: { code?: string; message: string }
    }

    expect(outcome.error?.code, JSON.stringify(outcome)).toBe('adapter.package_missing')
    expect(outcome.error?.message).toContain('npm install @nymbalhq/security-cloudflare')
    expect(outcome.error?.message).not.toContain('undefined')
    expect(readFileSync(out, 'utf8').length).toBeGreaterThan(0)
  }, 90_000)
})
