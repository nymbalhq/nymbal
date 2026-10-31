import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../../../tests/support/doctor.js'
import { workspace } from '../../../../tests/support/project.js'
import { fakeSmtpServer, type FakeSmtpServer } from '../../../../tests/support/smtp-server.js'
import {
  PUBLIC_URL,
  send,
  spawnStart,
  startEnv,
  storeConfig,
  storeProject,
  untilServing,
  upstream,
  type StartRun,
  type StoreProject,
  type Upstream,
} from '../../../../tests/support/start.js'

// AC-6 on one port, without a storefront build: `nymbal start` on a PORT that is not 3001 keeps /api/*, /health and
// /admin for the API and hands every other path to the storefront child, which it starts on 127.0.0.1 with the API's
// actual address and the public origin. The child is the stand-in through NYMBAL_STOREFRONT_ENTRY, which answers with
// the environment it was started with. tests/stores/start-storefront.test.ts proves the same on both built templates.
// The public origin is also one the store's alerts accept a subscribe from, so its own pages can subscribe; email is
// SMTP to a server in this process, since a store whose email does not deliver refuses every subscribe.
// Spawns the built CLI (`pnpm build` first).

let project: StoreProject
let stand: Upstream
let run: StartRun
let smtp: FakeSmtpServer

beforeAll(async () => {
  smtp = await fakeSmtpServer()
  const config = storeConfig()
  config['commerce'] = {
    ...(config['commerce'] as Record<string, unknown>),
    email: { provider: 'smtp', config: { smtp: { host: '127.0.0.1', port: smtp.port } } },
  }
  project = storeProject(config, workspace('@nymbalhq/email-smtp'))
  stand = await upstream(project.dir)
  const env = startEnv({ NYMBAL_STOREFRONT_ENTRY: stand.entry })
  for (const step of [['migrate'], ['seed']]) {
    const done = await runCli(step, { cwd: project.dir, env, timeoutMs: 120_000 })
    if (done.code !== 0) throw new Error(`nymbal ${step[0]} exited ${done.code}:\n${done.out}`)
  }
  run = await spawnStart(['start'], { cwd: project.dir, env })
  await untilServing(run)
}, 180_000)

afterAll(async () => {
  await run?.kill()
  await stand?.close()
  await smtp?.close()
  project?.remove()
})

/** POST /api/alerts/subscribe through the port with `origin`, carrying the double-submit CSRF token. */
async function subscribe(origin: string, variantId: string) {
  const csrf = randomBytes(32).toString('hex')
  const res = await send(`${run.base}/api/alerts/subscribe`, {
    method: 'POST',
    headers: {
      origin,
      cookie: `nymbal.csrf=${csrf}`,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: `alert-${randomBytes(4).toString('hex')}@nymbal.dev`,
      variantId,
      kind: 'back_in_stock',
    }),
  })
  const parsed = JSON.parse(res.body.toString() || '{}') as { error?: { code?: string } }
  return { status: res.status, code: parsed.error?.code }
}

interface Echo {
  page: string
  headers: Record<string, string>
  env: {
    HOST: string | null
    PORT: string | null
    NYMBAL_API_URL: string | null
    NYMBAL_PUBLIC_URL: string | null
  }
}

describe('AC-6: one port for the API, the admin and the storefront', () => {
  it('AC-6: a page path reaches the storefront child, started on 127.0.0.1 on another port with NYMBAL_API_URL at the port start bound and the public origin', async () => {
    expect(run.port).not.toBe(3001)
    const res = await send(`${run.base}/products/some-page?sort=price`)
    const echo = JSON.parse(res.body.toString()) as Echo

    expect(res.status).toBe(200)
    expect(echo.page).toBe('/products/some-page')
    expect(echo.env.NYMBAL_API_URL).toBe(`http://127.0.0.1:${run.port}`)
    expect(new URL(echo.env.NYMBAL_API_URL ?? 'http://unset').port).toBe(String(run.port))
    expect(echo.env.HOST).toBe('127.0.0.1')
    expect(Number(echo.env.PORT)).not.toBe(run.port)
    expect(echo.env.NYMBAL_PUBLIC_URL).toBe(PUBLIC_URL)
    expect(echo.headers['host']).toBe(new URL(PUBLIC_URL).host)
  })

  it('AC-6: /api/products is the API, /api/nope is the API JSON 404 and never reaches the child, /admin is the API 308 to /admin/, and /health is the API', async () => {
    const seenBefore = stand.requests.length
    const products = await send(`${run.base}/api/products`)
    const nope = await send(`${run.base}/api/nope`)
    const admin = await send(`${run.base}/admin`)
    const adminIndex = await send(`${run.base}/admin/`)
    const health = await send(`${run.base}/health`)
    // The stand-in reports each request on one connection, in order: once this page is reported, every earlier
    // request that reached it has been too.
    await send(`${run.base}/after-api`)
    const deadline = Date.now() + 5000
    while (!stand.requests.some((r) => r.path === '/after-api') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(products.status).toBe(200)
    expect(products.headers['content-type']).toMatch(/^application\/json/)
    expect(
      Array.isArray(
        (JSON.parse(products.body.toString()) as { data: { items: unknown } }).data.items,
      ),
    ).toBe(true)
    expect(nope.status).toBe(404)
    expect(nope.headers['content-type']).toMatch(/^application\/json/)
    expect(admin.status).toBe(308)
    expect(admin.headers['location']).toBe('/admin/')
    expect(adminIndex.status).toBe(200)
    expect(adminIndex.body.toString()).toContain('data-admin-stand-in="nymbal-start"')
    expect((JSON.parse(health.body.toString()) as { status: string }).status).toBe('ok')
    expect(stand.requests.slice(seenBefore).map((r) => r.path)).toEqual(['/after-api'])
  })

  it('AC-6: with NYMBAL_PUBLIC_URL=https://shop.example a POST /api/alerts/subscribe from Origin https://shop.example is accepted with 202, and the same subscribe from another origin is refused as before', async () => {
    const listing = JSON.parse(
      (await send(`${run.base}/api/products?limit=1`)).body.toString(),
    ) as {
      data: { items: Array<{ variants?: Array<{ id: string }> }> }
    }
    const variantId = listing.data.items[0]!.variants![0]!.id

    const own = await subscribe(PUBLIC_URL, variantId)
    const other = await subscribe('https://elsewhere.example', variantId)

    expect(new URL(PUBLIC_URL).origin).toBe(PUBLIC_URL)
    expect(own.status, String(own.code)).toBe(202)
    expect(other.status).toBe(400)
    expect(other.code).toBe('alerts.origin_not_allowed')
    expect(own.status).not.toBe(other.status)
  })
})
