import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUILT_IN_RATE_LIMITS } from '../../../http/src/rate-limit.js'
import { acpClient, acpStore, createBody, seedPool, sptPayment, withAcp } from '../support/acp.js'
import type { AgentStore } from '../support/agents.js'

// AC-12: every ACP path, however deep, sits under one rate rule, `/api/acp/**`: built in at 120 a minute, and
// replaced by the store's own rule for that pattern.

const RULE = { requests: 2, window: '1m', action: 'block' as const }

let store: AgentStore
let variantId: string

beforeAll(async () => {
  // The suites' high ACP rule, replaced by two a minute.
  store = await acpStore({ configure: (config) => withAcp(config, {}, RULE) })
  variantId = (await seedPool(store, [{ priceMinor: 990, stock: 20 }]))[0]!.variantId
}, 60_000)

afterAll(async () => {
  await store?.stop()
})

describe('AC-12: ACP requests are rate limited across every ACP path', () => {
  // Kills: a single-segment `/api/acp/*` rule that leaves the session, update, complete and cancel paths unlimited, or
  // ACP outside every rule.
  it('AC-12: with /api/acp/** at 2 a minute, a create and a get from one address pass and the third request, a complete three segments below the session path, answers 429', async () => {
    const agent = acpClient(store.baseUrl)

    const created = await agent.create(createBody([{ variantId, quantity: 1 }]))
    const read = await agent.get(created.body.id ?? 'cs-none')
    const third = await agent.complete(created.body.id ?? 'cs-none', sptPayment('spt_x'))
    const statuses = [created.status, read.status, third.status]

    expect([created.status, read.status]).toEqual([201, 200])
    // The first refusal comes only once the rule's count has passed.
    expect(statuses.indexOf(429)).toBeGreaterThanOrEqual(RULE.requests)
    expect(third.status).toBe(429)
  })

  it('AC-12: the built-in rule for /api/acp/** is 120 a minute, blocking, the same as the UCP endpoint’s', () => {
    expect(BUILT_IN_RATE_LIMITS['/api/acp/**']).toEqual({
      requests: 120,
      window: '1m',
      action: 'block',
    })
    expect(BUILT_IN_RATE_LIMITS['/api/acp/**']).toEqual(BUILT_IN_RATE_LIMITS['/api/ucp/mcp'])
  })
})
