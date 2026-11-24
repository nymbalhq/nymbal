import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError } from '@nymbalhq/types'
import { createHttpServer } from '../../../http/src/index.js'
import { createNativeStubPaymentsAdapter } from '../../src/adapters/payments/native-stub.js'
import { createLogger } from '../../src/logger.js'
import { ACP_KEY, ACP_PATH, acpClient, PINNED_VERSION, withAcp } from '../support/acp.js'
import { serveWithAgents, type AgentStore } from '../support/agents.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { adminAccount } from '../support/mcp.js'

// AC-2: `agents.acp` is off by default and nothing of ACP is served; on, it needs a payments adapter that takes a
// delegated token, or attachHttp refuses to start. Its keys are acp-keys.test.ts's.

const ROUTES: Array<['GET' | 'POST', string]> = [
  ['GET', '/feed'],
  ['POST', '/checkout_sessions'],
  ['GET', '/checkout_sessions/cs-unknown'],
  ['POST', '/checkout_sessions/cs-unknown'],
  ['POST', '/checkout_sessions/cs-unknown/complete'],
  ['POST', '/checkout_sessions/cs-unknown/cancel'],
]

interface Surface {
  name: string
  capabilities: unknown
}

const UCP_ENTRY = { name: 'ucp', capabilities: { search: true, lookup: true, checkout: 'handoff' } }
const ACP_ENTRY = {
  name: 'acp',
  capabilities: { search: false, lookup: false, checkout: 'agentic' },
}

/** A request carrying everything an ACP agent sends, so only the route's absence can refuse it. */
async function asAgent(baseUrl: string, method: 'GET' | 'POST', path: string) {
  const res = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${ACP_KEY}`,
      'api-version': PINNED_VERSION,
      ...(method === 'POST' && {
        'content-type': 'application/json',
        'idempotency-key': `acp-${randomUUID()}`,
      }),
    },
    ...(method === 'POST' && { body: '{}' }),
  })
  const text = await res.text()
  // The path is the only thing two not-found answers may differ in.
  return { status: res.status, body: text.replaceAll(path, '<path>') }
}

async function surfaces(store: AgentStore): Promise<Surface[]> {
  const admin = await adminAccount(store.kernel, store.baseUrl)
  const res = await fetch(new URL('/api/admin/dashboard', store.baseUrl), {
    headers: { accept: 'application/json', authorization: `Bearer ${admin.token}` },
  })
  const body = (await res.json()) as { data?: { agents?: { surfaces?: Surface[] } } }
  if (res.status !== 200) throw new Error(`dashboard: ${res.status} ${JSON.stringify(body)}`)
  return body.data?.agents?.surfaces ?? []
}

/** What attachHttp does on a kernel of this config: null when it starts, the error when it refuses. */
async function attach(kernel: Kernel): Promise<unknown> {
  const http = createHttpServer({
    config: kernel.config,
    logger: kernel.logger,
    documentStore: kernel.documentStore,
    version: '0.0.0',
    network: kernel.app.network,
  })
  try {
    return await kernel.app.attachHttp(http.adapter).then(
      () => null,
      (error: unknown) => error,
    )
  } finally {
    await http.stop().catch(() => undefined)
  }
}

describe('AC-2: agents.acp is a flag, off by default, with a delegating payments adapter when on', () => {
  const kernels: Kernel[] = []

  afterEach(async () => {
    for (const k of kernels.splice(0)) await k.close()
  })

  // Kills: ACP served whatever the flag says; a dashboard that lists acp when off or forgets it when on.
  it('AC-2: off by default every ACP path answers exactly what an unknown API path answers and the dashboard lists only ucp; on with a key, the feed answers 200 and the dashboard lists ucp and acp with search and lookup false and checkout agentic', async () => {
    const off = await serveWithAgents(await createKernel({ dialect: 'sqlite' }))
    const on = await serveWithAgents(
      await createKernel({ dialect: 'sqlite', configure: (c) => withAcp(c) }),
    )
    try {
      for (const [method, path] of ROUTES) {
        const acp = await asAgent(off.baseUrl, method, `${ACP_PATH}${path}`)
        expect(acp, `${method} ${path} with ACP off`).toEqual(
          await asAgent(off.baseUrl, method, `/api/acp-${randomUUID()}${path}`),
        )
        expect(acp.status).toBe(404)
      }
      const feedOn = await acpClient(on.baseUrl).feed()

      expect(await surfaces(off)).toEqual([UCP_ENTRY])
      expect(feedOn.status).toBe(200)
      const listed = await surfaces(on)
      expect(listed).toHaveLength(2)
      expect(listed).toEqual(expect.arrayContaining([UCP_ENTRY, ACP_ENTRY]))
    } finally {
      await off.stop()
      await on.stop()
    }
  })

  // Kills: a provider that cannot take a token accepted, so every complete would fail at the first agent's payment.
  it('AC-2: enabled with a payments adapter whose capabilities lack delegated, attachHttp rejects with config.acp_payments_unsupported naming the provider', async () => {
    const stub = createNativeStubPaymentsAdapter({
      logger: createLogger({ pretty: false, level: 'error' }),
    })
    const k = await createKernel({
      dialect: 'sqlite',
      configure: (c) => {
        const on = withAcp(c)
        return { ...on, commerce: { ...on.commerce, payments: { provider: 'custom' } } }
      },
      appOptions: {
        adapters: {
          payments: {
            ...stub,
            providerName: 'acp-undelegated',
            capabilities: () => ['intent', 'capture', 'refund', 'webhook'],
          },
        },
      },
    })
    kernels.push(k)

    const error = await attach(k)

    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).code).toBe('config.acp_payments_unsupported')
    expect((error as ConfigError).message).toMatch(/acp-undelegated|custom/)
  })
})
