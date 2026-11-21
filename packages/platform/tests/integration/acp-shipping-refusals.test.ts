import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { validateAcp } from '../../../../tests/fixtures/acp/validate.js'
import {
  ACP_ADDRESS,
  acpClient,
  buyerEmail,
  CHECKOUT_SESSION,
  createBody,
  fulfillmentDetails,
  ordersOfCart,
  recordingPayments,
  seedPool,
  sptPayment,
  type AcpAnswer,
  type AcpClient,
  type AcpSession,
  type PoolVariant,
  type RecordingPayments,
  withAcp,
} from '../support/acp.js'
import { serveWithAgents, type AgentStore } from '../support/agents.js'
import { createKernel } from '../support/kernel.js'
import { scriptedEngine, type ScriptedEngine } from '../support/promotions.js'
import { both, TABLE, withShipping } from '../support/shipping.js'
import { scriptedTax, withTax, type ScriptedTax } from '../support/tax.js'

// ACP sessions on a store with a shipping table whose tax and promotions engines are the test's own, served as
// `nymbal dev` serves them (SQLite): an engine outage is a session the agent can retry, not a broken store, and an
// address the store does not ship to is the buyer's to correct. No ACP route answers 500 for a checkout refusal.

let store: AgentStore
let agent: AcpClient
let payments: RecordingPayments
let tax: ScriptedTax
let engine: ScriptedEngine
let pool: PoolVariant[]

beforeAll(async () => {
  payments = recordingPayments()
  tax = scriptedTax({ percent: 10 })
  // Automatic promotions, so the engine is asked about a session's cart, which carries no code.
  engine = scriptedEngine({ capabilities: ['codes', 'automatic'] })
  const kernel = await createKernel({
    dialect: 'sqlite',
    configure: both(
      withAcp,
      withTax({ provider: 'custom' }),
      withShipping(TABLE),
      (config: NymbalConfig) =>
        ({
          ...config,
          commerce: {
            ...config.commerce,
            payments: { provider: 'custom' },
            promotions: { provider: 'custom', onUnavailable: 'refuse' },
          },
        }) as NymbalConfig,
    ),
    appOptions: {
      adapters: { payments: payments.adapter, tax: tax.adapter, promotions: engine.adapter },
    },
  })
  store = await serveWithAgents(kernel)
  agent = acpClient(store.baseUrl)
  pool = await seedPool(store, [{ priceMinor: 1_800, stock: 10_000 }])
}, 60_000)

afterAll(async () => {
  tax?.recover()
  engine?.recover()
  await store?.stop()
})

const AU_ADDRESS = {
  ...ACP_ADDRESS,
  line_two: '',
  city: 'Sydney',
  state: 'NSW',
  country: 'AU',
  postal_code: '2000',
}

type Message = Record<string, unknown>

const messagesOf = (res: AcpAnswer<AcpSession>): Message[] =>
  (res.body.messages ?? []) as unknown as Message[]

async function readySession(): Promise<AcpSession> {
  const res = await agent.create(
    createBody([{ variantId: pool[0]!.variantId, quantity: 1 }], { email: buyerEmail('down') }),
  )
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  expect(res.body.status).toBe('ready_for_payment')
  return res.body
}

/** Each answer is a 200 not_ready_for_payment session with one high, recoverable info message. */
function expectRetryable(res: AcpAnswer<AcpSession>, what: string): void {
  expect(
    { status: res.status, session: res.body.status },
    `${what}: ${JSON.stringify(res.body)}`,
  ).toEqual({ status: 200, session: 'not_ready_for_payment' })
  expect(validateAcp(CHECKOUT_SESSION, res.body), what).toEqual([])
  const info = messagesOf(res).filter((m) => m['type'] === 'info')
  expect(
    info.map((m) => ({ severity: m['severity'], resolution: m['resolution'] })),
    what,
  ).toEqual([{ severity: 'high', resolution: 'recoverable' }])
  expect(String(info[0]?.['content'] ?? '').length, what).toBeGreaterThan(0)
}

describe('AC-22: ACP refusals are sessions, never a 500', () => {
  for (const outage of ['tax', 'promotions'] as const) {
    // Kills: an engine outage answered 500 (the agent told the store is broken) or quoted as a zero tax.
    it(`AC-22: with the ${outage} engine down, GET, update and complete answer 200 not_ready_for_payment with a recoverable info message, and complete writes nothing`, async () => {
      const session = await readySession()
      const intentsBefore = payments.intents.length
      if (outage === 'tax') tax.fail('throws')
      else engine.fail()
      try {
        const read = await agent.get(session.id)
        const updated = await agent.update(session.id, {
          fulfillment_details: fulfillmentDetails(),
        })
        const completed = await agent.complete(session.id, sptPayment('spt_down'))

        expectRetryable(read, 'GET')
        expectRetryable(updated, 'update')
        expectRetryable(completed, 'complete')
        expect(ordersOfCart(store.kernel.target, session.id)).toEqual([])
        expect(payments.intents.length).toBe(intentsBefore)
      } finally {
        tax.recover()
        engine.recover()
      }
      const recovered = await agent.get(session.id)
      expect(recovered.body.status).toBe('ready_for_payment')
    })
  }

  // Kills: an address the store cannot ship to read as ready (and refused only at payment), or answered 500.
  it('AC-22: an address no option ships to answers not_ready_for_payment with a region_restricted error at $.fulfillment_details.address, on create and on update', async () => {
    const created = await agent.create({
      ...createBody([{ variantId: pool[0]!.variantId, quantity: 1 }], {
        email: buyerEmail('nowhere'),
      }),
      fulfillment_details: { ...fulfillmentDetails(), address: AU_ADDRESS },
    })
    const ready = await readySession()
    const moved = await agent.update(ready.id, {
      fulfillment_details: { ...fulfillmentDetails(), address: AU_ADDRESS },
    })

    for (const [what, res] of [
      ['create', created],
      ['update', moved],
    ] as const) {
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBeLessThan(300)
      expect(res.body.status, what).toBe('not_ready_for_payment')
      expect(validateAcp(CHECKOUT_SESSION, res.body), what).toEqual([])
      const errors = messagesOf(res)
        .filter((m) => m['type'] === 'error')
        .map((m) => ({ code: m['code'], param: m['param'] }))
      expect(errors, what).toContainEqual({
        code: 'region_restricted',
        param: '$.fulfillment_details.address',
      })
    }
  })
})
