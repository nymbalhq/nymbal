import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import { createHttpServer } from '../../../http/src/index.js'
import { scrub } from '../../src/settings/secret-set.js'
import {
  acpClient,
  acpStore,
  AGENT_UA,
  buyerEmail,
  createBody,
  seedPool,
  sptPayment,
  untilListed,
  withAcp,
  type AcpAnswer,
  type AcpClient,
  type AcpSession,
  type PoolVariant,
} from '../support/acp.js'
import { serveWithAgents, storedCartSource, type AgentStore } from '../support/agents.js'
import { activityEntries, adminSession, type AdminSession } from '../support/audit-http.js'
import { createKernel, type Kernel } from '../support/kernel.js'

// Each shopping assistant holds its own ACP key, by name. The key is what authenticates; its name labels the cart and
// order a session opens (`agent:<name>`) and is the actor of every audit entry a request under it writes
// (`acp:<name>`), whatever the User-Agent says. The list is the only source of a key.

interface NamedKey {
  name: string
  key: string
}

const MUSE: NamedKey = { name: 'muse', key: 'muse-acp-key-0123456789abcdefghijklmn' }
const DOTS: NamedKey = { name: 'dots', key: 'dots-acp-key-9876543210zyxwvutsrqponm' }
const ENV_KEY = 'NYMBAL_ACP_API_KEY'

/** `agents.acp` on as the rig turns it on, with exactly these keys (`undefined`: no `keys` at all). */
function keyed(keys: readonly NamedKey[] | undefined): (config: NymbalConfig) => NymbalConfig {
  return (config) => {
    const on = withAcp(config)
    const { keys: _rig, ...acp } = on.agents.acp as Record<string, unknown>
    return {
      ...on,
      agents: { ...on.agents, acp: { ...acp, ...(keys !== undefined && { keys: [...keys] }) } },
    } as NymbalConfig
  }
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

/** Runs `body` with NYMBAL_ACP_API_KEY set to `value`, then puts back what was there. */
async function withEnvKey<T>(value: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env[ENV_KEY]
  process.env[ENV_KEY] = value
  try {
    return await body()
  } finally {
    if (saved === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = saved
  }
}

/** A key of 32 characters or more this run alone uses, since the scrub set is process-wide. */
const uniqueKey = (tag: string) => `${tag}-${randomUUID()}-${randomBytes(8).toString('hex')}`

/** `key` with the character at `at` changed. */
function nearMiss(key: string, at: number): string {
  const c = key[at]!
  return key.slice(0, at) + (c === 'x' ? 'y' : 'x') + key.slice(at + 1)
}

const refusalOf = (answer: AcpAnswer<unknown>) => ({ status: answer.status, body: answer.body })

describe('AC-3: the store boots on agents.acp.keys and on nothing else', () => {
  const kernels: Kernel[] = []

  afterAll(async () => {
    for (const k of kernels.splice(0)) await k.close()
  })

  async function attachWith(keys: readonly NamedKey[] | undefined): Promise<unknown> {
    const k = await createKernel({ dialect: 'sqlite', configure: keyed(keys) })
    kernels.push(k)
    return attach(k)
  }

  // Kills: a store with ACP on and no key that starts open or keyless; the NYMBAL_ACP_API_KEY fallback surviving; a
  // refusal that still points at the removed variable.
  it('AC-3: ACP on with keys absent, keys [] or keys absent beside a 32-character NYMBAL_ACP_API_KEY makes attachHttp reject with ConfigError config.acp_key_missing naming agents.acp.keys', async () => {
    const absent = await attachWith(undefined)
    const empty = await attachWith([])
    const envOnly = await withEnvKey(uniqueKey('env').slice(0, 32), () => attachWith(undefined))

    const seen = [absent, empty, envOnly].map((error) => ({
      isConfigError: error instanceof ConfigError,
      code: (error as ConfigError | null)?.code,
      namesKeys: (error as Error | null)?.message.includes('agents.acp.keys') ?? false,
    }))

    expect(seen).toEqual(
      seen.map(() => ({ isConfigError: true, code: 'config.acp_key_missing', namesKeys: true })),
    )
  })

  // Kills: a store with named keys that refuses to start; an unnamed environment key served beside the named ones; a
  // named key that reaches a log line.
  it('AC-3: ACP on with two named keys starts and serves the feed to each, refuses the 32-character NYMBAL_ACP_API_KEY set beside them, and after attachHttp scrub() masks every named key it did not before', async () => {
    const keys = [
      { name: 'boot-a', key: uniqueKey('boot-a') },
      { name: 'boot-b', key: uniqueKey('boot-b') },
    ]
    const envKey = uniqueKey('env').slice(0, 32)
    const before = keys.map((k) => scrub(k.key))

    await withEnvKey(envKey, async () => {
      const store = await serveWithAgents(
        await createKernel({ dialect: 'sqlite', configure: keyed(keys) }),
      )
      try {
        const named = await Promise.all(
          keys.map(async (k) => (await acpClient(store.baseUrl, { key: k.key }).feed()).status),
        )
        const fromEnv = await acpClient(store.baseUrl, { key: envKey }).feed()

        expect(named).toEqual(keys.map(() => 200))
        expect(fromEnv.status).toBe(401)
        expect(before).toEqual(keys.map((k) => k.key))
        expect(keys.map((k) => scrub(k.key))).toEqual(keys.map(() => '***'))
      } finally {
        await store.stop()
      }
    })
  })
})

describe('keys muse and dots on one store', () => {
  let store: AgentStore
  let admin: AdminSession
  let pool: PoolVariant[]
  let muse: AcpClient
  let dots: AcpClient

  beforeAll(async () => {
    store = await acpStore({ configure: keyed([MUSE, DOTS]) })
    admin = await adminSession(store.kernel, store.baseUrl)
    pool = await seedPool(store, [
      { priceMinor: 1_250, stock: 1_000 },
      { priceMinor: 3_400, stock: 1_000 },
    ])
    muse = acpClient(store.baseUrl, { key: MUSE.key, userAgent: AGENT_UA })
    dots = acpClient(store.baseUrl, { key: DOTS.key, userAgent: AGENT_UA })
  }, 60_000)

  afterAll(async () => {
    await store?.stop()
  })

  const oneLine = (i = 0) => [{ variantId: pool[i]!.variantId, quantity: 1 }]

  describe('AC-5: the list is what authenticates', () => {
    // Kills: one key only served; a near miss or a stranger's bearer let in; a refusal that says how close it came.
    it('AC-5: each named bearer is answered 200 on the feed and 201 on a create; muse’s key with one character changed and a random bearer are each answered 401 unauthorized with one identical body', async () => {
      const served: number[][] = []
      for (const agent of [muse, dots]) {
        served.push([
          (await agent.feed()).status,
          (await agent.create(createBody(oneLine()))).status,
        ])
      }
      const refused: Array<ReturnType<typeof refusalOf>> = []
      for (const key of [
        nearMiss(MUSE.key, 0),
        nearMiss(MUSE.key, MUSE.key.length - 1),
        nearMiss(MUSE.key, 17),
        randomBytes(24).toString('hex'),
      ]) {
        const stranger = acpClient(store.baseUrl, { key })
        refused.push(refusalOf(await stranger.feed()))
        refused.push(refusalOf(await stranger.create(createBody(oneLine()))))
      }

      expect(served).toEqual([
        [200, 201],
        [200, 201],
      ])
      expect((refused[0]?.body as { code?: string }).code).toBe('unauthorized')
      expect(refused).toEqual(refused.map(() => refused[0]))
      expect(refused[0]?.status).toBe(401)
    })
  })

  describe('AC-6: audit entries name the sending key; the cart and order name the opening key', () => {
    async function entriesOf(actor: string): Promise<Array<Record<string, unknown>>> {
      return activityEntries(admin, { actor })
    }

    const idsOf = (entries: Array<Record<string, unknown>>) => entries.map((e) => String(e['id']))

    function added(
      before: Array<Record<string, unknown>>,
      after: Array<Record<string, unknown>>,
    ): Array<Record<string, unknown>> {
      const seen = new Set(idsOf(before))
      return after.filter((e) => !seen.has(String(e['id'])))
    }

    const acpCommands = (entries: Array<Record<string, unknown>>) =>
      entries
        .map((e) => String(e['command']))
        .filter((c) => c.startsWith('acp.'))
        .sort()

    async function orderSourceOverHttp(orderNumber: string): Promise<unknown> {
      const res = await admin.send<{ source?: string }>(
        'GET',
        `/api/admin/orders/${encodeURIComponent(orderNumber)}`,
      )
      if (res.status !== 200)
        throw new Error(`admin order: ${res.status} ${JSON.stringify(res.body)}`)
      return res.body.data?.source
    }

    async function ready(agent: AcpClient): Promise<AcpSession> {
      const created = await agent.create(createBody(oneLine(), { email: buyerEmail('keys') }))
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      return created.body
    }

    // Kills: a key's requests labelled from the User-Agent; an audit that cannot say which assistant sent a request;
    // the activity filter reading `acp:` as an actor kind and listing nothing.
    it('AC-6: a session created, updated and completed under muse’s key with a ChatGPT User-Agent leaves cart and order (service and admin API) at agent:muse, and ?actor=acp:muse lists its acp.create, acp.update and acp.complete entries, every one with actor system/acp:muse, as ?actor=system:acp:muse does', async () => {
      const before = await entriesOf('acp:muse')

      const session = await ready(muse)
      const updated = await muse.update(session.id, { buyer: { email: buyerEmail('keys-update') } })
      const done = await muse.complete(session.id, sptPayment('spt_x'))
      expect([updated.status, done.status], JSON.stringify(done.body)).toEqual([200, 200])
      const order = done.body.order!
      const placed = await store.kernel.services.order.getById(order.id)
      const after = await entriesOf('acp:muse')
      const asSystem = await entriesOf('system:acp:muse')
      const mine = added(before, after)

      expect({
        cart: await storedCartSource(store.kernel, session.id),
        order: placed.source,
        admin: await orderSourceOverHttp(order.order_number ?? ''),
      }).toEqual({ cart: 'agent:muse', order: 'agent:muse', admin: 'agent:muse' })
      expect(acpCommands(mine)).toEqual(['acp.complete', 'acp.create', 'acp.update'])
      expect(mine.map((e) => e['actor'])).toEqual(
        mine.map(() => ({ kind: 'system', id: 'acp:muse' })),
      )
      expect(idsOf(asSystem).sort()).toEqual(idsOf(after).sort())
    })

    // Kills: the completing key overwriting the opener's source; the complete's entry written under the opener.
    it('AC-6: a session muse opens and dots completes leaves the order at agent:muse, its acp.complete entry under acp:dots (listed by ?actor=acp:dots, not by ?actor=acp:muse) and its acp.create under acp:muse', async () => {
      const museBefore = await entriesOf('acp:muse')
      const dotsBefore = await entriesOf('acp:dots')

      const session = await ready(muse)
      const done = await dots.complete(session.id, sptPayment('spt_x'))
      expect(done.status, JSON.stringify(done.body)).toBe(200)
      const placed = await store.kernel.services.order.getById(done.body.order!.id)
      const museAdded = added(museBefore, await entriesOf('acp:muse'))
      const dotsAdded = added(dotsBefore, await entriesOf('acp:dots'))

      expect(placed.source).toBe('agent:muse')
      expect({ muse: acpCommands(museAdded), dots: acpCommands(dotsAdded) }).toEqual({
        muse: ['acp.create'],
        dots: ['acp.complete'],
      })
      expect(dotsAdded.map((e) => e['actor'])).toEqual(
        dotsAdded.map(() => ({ kind: 'system', id: 'acp:dots' })),
      )
    })
  })

  describe('AC-7: replays are per key', () => {
    // Kills: one assistant answered another's session (its buyer email and address) by reusing an Idempotency-Key,
    // or refused for a key another assistant used; a key's own replay lost.
    it('AC-7: the same Idempotency-Key and body from muse then dots open two sessions labelled by their own keys; the same Idempotency-Key with another body from dots after muse answers 201; a repeat from muse replays muse’s first session', async () => {
      const shared = `same-${randomUUID()}`
      const body = createBody(oneLine(0), { email: buyerEmail('replay') })
      const first = await muse.create(body, { 'idempotency-key': shared })
      const second = await dots.create(body, { 'idempotency-key': shared })
      const other = `other-${randomUUID()}`
      const museOther = await muse.create(body, { 'idempotency-key': other })
      const dotsOther = await dots.create(createBody(oneLine(1), { email: buyerEmail('replay') }), {
        'idempotency-key': other,
      })
      const repeat = await muse.create(body, { 'idempotency-key': shared })

      expect([first.status, second.status, museOther.status, dotsOther.status]).toEqual([
        201, 201, 201, 201,
      ])
      expect(second.body.id).not.toBe(first.body.id)
      expect(dotsOther.body.id).not.toBe(museOther.body.id)
      expect({
        first: await storedCartSource(store.kernel, first.body.id),
        second: await storedCartSource(store.kernel, second.body.id),
        dotsOther: await storedCartSource(store.kernel, dotsOther.body.id),
      }).toEqual({ first: 'agent:muse', second: 'agent:dots', dotsOther: 'agent:dots' })
      expect({ status: repeat.status, id: repeat.body.id }).toEqual({
        status: first.status,
        id: first.body.id,
      })
    })
  })
})

describe('AC-5: a key removed from the list is refused after a restart', () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  // Kills: a cached or stored key that outlives its removal; one removal that revokes every assistant.
  it('AC-5: a store restarted on the same database without dots refuses dots’ bearer on every ACP route, including its own session, with the body a random bearer gets, while muse still creates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-keys-'))
    dirs.push(dir)
    const sqlitePath = join(dir, 'store.sqlite')

    const before = await serveWithAgents(
      await createKernel({ dialect: 'sqlite', sqlitePath, configure: keyed([MUSE, DOTS]) }),
    )
    let slug: string
    let sessionId: string
    let variantId: string
    try {
      const [variant] = await seedPool(before, [{ priceMinor: 990, stock: 100 }])
      slug = variant!.slug
      variantId = variant!.variantId
      const opened = await acpClient(before.baseUrl, { key: DOTS.key }).create(
        createBody([{ variantId, quantity: 1 }]),
      )
      expect(opened.status, JSON.stringify(opened.body)).toBe(201)
      sessionId = opened.body.id
    } finally {
      await before.stop()
    }

    const after = await serveWithAgents(
      await createKernel({ dialect: 'sqlite', sqlitePath, configure: keyed([MUSE]) }),
    )
    try {
      await untilListed(after.baseUrl, [slug])
      const removed = acpClient(after.baseUrl, { key: DOTS.key })
      const stranger = acpClient(after.baseUrl, { key: randomBytes(24).toString('hex') })
      const lines = [{ variantId, quantity: 1 }]
      const answers = [
        await removed.feed(),
        await removed.create(createBody(lines)),
        await removed.get(sessionId),
        await removed.update(sessionId, { buyer: { email: buyerEmail('removed') } }),
        await removed.complete(sessionId, sptPayment('spt_x')),
        await removed.cancel(sessionId),
      ].map(refusalOf)
      const strangers = refusalOf(await stranger.feed())
      const museCreates = await acpClient(after.baseUrl, { key: MUSE.key }).create(
        createBody(lines),
      )

      expect(strangers.status).toBe(401)
      expect(answers).toEqual(answers.map(() => strangers))
      expect(museCreates.status, JSON.stringify(museCreates.body)).toBe(201)
    } finally {
      await after.stop()
    }
  }, 60_000)
})
