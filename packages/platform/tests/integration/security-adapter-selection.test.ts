import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { buildSecurityHeaders } from '../../src/adapters/security/headers.js'
import { serveKernel } from '../support/http.js'
import { createKernel, kernelConfig } from '../support/kernel.js'
import {
  startFakeCloudflare,
  type FakeCloudflare,
} from '../../../adapters/security/cloudflare/src/tests/fake-cloudflare.js'

// AC-2: `createApp` honours `security.adapter`. With `cloudflare` (its apiBase on the fake) it builds the Cloudflare
// adapter, reports `edge-rules`, sets the same response headers as a `middleware` store and makes no request at boot;
// a missing package fails with the install line (in the adapter-graph child process, from the built dist: `pnpm build`
// first). An adapter nothing provides is adapter-resolution.test.ts.

const exec = promisify(execFile)
const CHILD = fileURLToPath(new URL('./fixtures/adapter-graph/child.mjs', import.meta.url))
const TOKEN = 'cf-boot-token'

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

describe('AC-2: createApp builds the adapter security.adapter names', () => {
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

  it('AC-2: with @nymbalhq/security-cloudflare not installed, createApp fails adapter.package_missing with the install line and no SDK in it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-missing-'))
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
        ADAPTERS_GRAPH: JSON.stringify({ out, hide: ['@nymbalhq/security-cloudflare'] }),
      },
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    const line = stdout.split('\n').find((l) => l.startsWith('ADAPTER-GRAPH-OUTCOME '))
    const outcome = JSON.parse(line!.slice('ADAPTER-GRAPH-OUTCOME '.length)) as {
      started?: unknown
      error?: { code?: string; message: string }
    }

    expect(outcome.error?.code, JSON.stringify(outcome)).toBe('adapter.package_missing')
    expect(outcome.error?.message).toContain('npm install @nymbalhq/security-cloudflare')
    expect(outcome.error?.message).not.toContain('undefined')
    expect(readFileSync(out, 'utf8').length).toBeGreaterThan(0)
  }, 90_000)
})
