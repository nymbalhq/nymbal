import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AiAdapter, ChatResult, ProposalView } from '@nymbalhq/types'
import type * as LoopModule from '../../src/assistant/loop.js'
import { routeSchemas } from '../../src/routes/schemas.js'
import {
  ASSISTANT,
  TURNS,
  adminTools,
  ask,
  assistantStore,
  assistantTicketKey,
  callsThen,
  framesOf,
  issueTurn,
  openTurn,
  parsed,
  proposalsOf,
  readStream,
  runTurn,
  signTicket,
  storeState,
  streamPath,
  ticketPayload,
  toolTurns,
  viewsOf,
  withAgents,
  type AssistantStore,
  type Frame,
} from '../support/assistant.js'
import { auditRows } from '../support/audit.js'
import { customerSession } from '../support/audit-http.js'
import { checkoutOf, seedVariant, type Seeded } from '../support/kernel.js'
import { toolSurface } from '../support/mcp.js'
import { storedMoney, storedRefunds } from '../support/money.js'
import { captureLogs, leaks, secretArb, stringsIn } from '../support/settings.js'
import { shopper } from '../support/shopper.js'

// The merchant's assistant through its routes, on SQLite, with the ai slot on a provider stand-in in `script` mode
// (tests/support/ai-stand-in.ts): the scripted model asks for the calls each case needs, and the store, the proposals,
// the frames and the requests the model received are read back. Anthropic's wire throughout (AC-11 reads its
// `is_error`).
// - AC-9: property, every command the assistant calls is a pending proposal the frames show and the store keeps,
//   and nothing in the store changes.
// - AC-10: `agents.autoApprove` applies a listed command at once; under the defaults, and under `agents.mcp.writes:
//   'apply'`, a refund stays pending.
// - AC-11: eight model requests at most, a turn timeout, refusals as error results, a result cut to 16 000 characters,
//   ten calls per reply and a turn-wide budget of 64 000 characters of results.
// - AC-12: the tools offered are the admin's and the public reads that hold no handle.
// - AC-13: the turn POST and the ticketed stream refuse what they must, before any model call.
// - AC-14: a closed stream stops the turn.
// - AC-15: property, no key and no conversation in the logs.

type Loop = typeof LoopModule

/** The loop module, loaded where a test runs the loop itself (the route tests reach it through the routes). */
const loop = (): Promise<Loop> => import('../../src/assistant/loop.js')

const LONG_DESCRIPTION_CHARS = 20_000
const RESULT_CHARS = 16_000
/** Room for the note a cut result carries. */
const NOTE_CHARS = 400

interface Fixture {
  store: AssistantStore
  product: Seeded & { slug: string }
  /** A captured order: what a refund may be asked for. */
  order: { orderId: string; totalMinor: number }
}

/** A seeded product and a captured order, with every event they published delivered. */
async function fixture(store: AssistantStore): Promise<Fixture> {
  const seeded = await seedVariant(store.kernel, 100, { priceMinor: 1500 })
  const product = await store.kernel.store.read((tx) =>
    store.kernel.repos.product.findById(tx, seeded.productId),
  )
  const paid = await seedVariant(store.kernel, 10, { priceMinor: 2500 })
  const order = await checkoutOf(store.kernel, paid, 1, `assistant-${randomUUID()}@assistant.test`)
  await store.kernel.app.relay.drain()
  return {
    store,
    product: { ...seeded, slug: product!.slug },
    order: { orderId: order.orderId, totalMinor: order.totalMinor },
  }
}

/** A product whose detail read is longer than a tool result may be. */
async function longProduct(store: AssistantStore, description: string): Promise<string> {
  const tag = randomUUID()
  await store.kernel.services.product.create({
    slug: `long-${tag}`,
    name: `Long Read ${tag.slice(0, 8)}`,
    description,
    status: 'active',
    variants: [
      {
        sku: `LONG-${tag}`,
        name: 'Default',
        priceMinor: 900,
        stock: 3,
        lowStockThreshold: 0,
        options: [],
      },
    ],
  })
  await store.kernel.app.relay.drain()
  return `long-${tag}`
}

/** The assistant's loop on the store's own adapter and tool surface, as the stream route runs it. */
function loopDeps(
  store: AssistantStore,
  limits?: { turnMs?: number },
): Parameters<Loop['runAssistantTurn']>[0] {
  const app = store.kernel.app
  return {
    ai: app.adapters.ai!,
    tools: toolSurface(app) as NonNullable<typeof app.mcp>,
    proposals: app.services.proposals,
    logger: store.kernel.logger,
    ...(limits !== undefined && { limits }),
  } as Parameters<Loop['runAssistantTurn']>[0]
}

const adminTurn = (store: AssistantStore, content: string) => ({
  caller: {
    auth: { userId: store.admin.userId, roles: ['admin' as const] },
    agent: { name: ASSISTANT },
  },
  messages: [{ role: 'user' as const, content }],
})

/** The ids of the proposals that exist now and did not in `before`. */
const freshIds = (before: ProposalView[], after: ProposalView[]): string[] => {
  const known = new Set(before.map((p) => p.id))
  return after.filter((p) => !known.has(p.id)).map((p) => p.id)
}

let main: Fixture

beforeAll(async () => {
  main = await fixture(await assistantStore())
}, 60_000)

afterAll(async () => {
  await main?.store.close()
})

describe('AC-9: a write the assistant asks for is a proposal', () => {
  it('AC-9: property: for any 1-5 admin command calls with valid arguments, one turn leaves exactly one pending row per call by agent nymbal-assistant for the admin with the tool and arguments as called, one proposal frame per row equal to GET /api/admin/proposals/:id, the store unchanged, and the next model request carrying each status proposed result', async () => {
    const { store, product, order } = main
    const tools = adminTools(store)
    const write = fc.oneof(
      fc.integer({ min: 0, max: 100_000 }).map((priceMinor) => ({
        name: 'admin_products_update',
        args: { id: product.productId, variants: [{ id: product.variantId, priceMinor }] },
      })),
      fc
        .string({ minLength: 1, maxLength: 40 })
        .map((name) => ({ name: 'admin_products_update', args: { id: product.productId, name } })),
      fc
        .constantFrom(
          'admin_products_unpublish',
          'admin_products_publish',
          'admin_products_archive',
          'admin_products_duplicate',
          'admin_products_delete',
        )
        .map((name) => ({ name, args: { id: product.productId } })),
      fc
        .record({ tag: fc.uuid(), priceMinor: fc.nat(50_000), stock: fc.nat(100) })
        .map(({ tag, priceMinor, stock }) => ({
          name: 'admin_products_create',
          args: {
            slug: `ac9-${tag}`,
            name: `Proposed ${tag.slice(0, 8)}`,
            status: 'draft',
            variants: [{ sku: `AC9-${tag}`, name: 'Default', priceMinor, stock, options: [] }],
          },
        })),
      fc.integer({ min: -50, max: 50 }).map((delta) => ({
        name: 'admin_inventory_adjust',
        args: { variantId: product.variantId, delta, reason: 'manual' },
      })),
      fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }).map((reason) => ({
        name: 'admin_orders_cancel',
        args: { id: order.orderId, ...(reason !== undefined && { reason }) },
      })),
      fc.integer({ min: 1, max: order.totalMinor }).map((amountMinor) => ({
        name: 'admin_orders_refund',
        args: { id: order.orderId, amountMinor },
      })),
      fc.string({ minLength: 1, maxLength: 60 }).map((body) => ({
        name: 'admin_orders_addNote',
        args: { id: order.orderId, body },
      })),
    )

    await fc.assert(
      fc.asyncProperty(fc.array(write, { minLength: 1, maxLength: 5 }), async (calls) => {
        for (const call of calls) expect(tools.get(call.name)?.kind, call.name).toBe('command')
        const before = await storeState(store.raw)
        const known = await proposalsOf(store.admin)
        store.standIn.reset()
        store.standIn.script = callsThen(calls, 'I have proposed those changes.')

        const frames = await runTurn(store, ask('Make these changes to the store.'))

        const cards = framesOf(frames, 'proposal').map((f) => f.data as unknown as ProposalView)
        const fresh = freshIds(known, await proposalsOf(store.admin))
        expect(fresh.length).toBe(calls.length)
        expect([...cards.map((c) => c.id)].sort()).toEqual([...fresh].sort())
        expect(cards.map((c) => ({ tool: c.tool, args: c.args }))).toEqual(
          calls.map((c) => ({ tool: c.name, args: c.args })),
        )
        for (const [i, card] of cards.entries()) {
          expect(card.status).toBe('pending')
          expect(card.command).toBe(tools.get(calls[i]!.name)!.route.command)
          expect(card.proposer.userId).toBe(store.admin.userId)
          expect(card.proposer.agent.name).toBe(ASSISTANT)
          const read = await store.admin.send<ProposalView>(
            'GET',
            `/api/admin/proposals/${card.id}`,
          )
          // A pending update, adjust, cancel or refund is also read with its preview; the rest is the frame.
          const { preview: _preview, ...view } = read.body.data as ProposalView & {
            preview?: unknown
          }
          expect(view).toEqual(card)
        }
        expect(framesOf(frames, 'done').map((f) => f.data['proposals'])).toEqual([
          cards.map((c) => c.id),
        ])
        expect(await storeState(store.raw)).toEqual(before)
        const views = viewsOf(store.standIn)
        expect(views.length).toBe(2)
        expect(toolTurns(views[1]!).map((t) => [parsed(t)['status'], parsed(t)['id']])).toEqual(
          cards.map((c) => ['proposed', c.id]),
        )
      }),
      { numRuns: 25 },
    )
  }, 180_000)
})

describe('AC-10: the assistant follows agents.autoApprove and nothing else', () => {
  it('AC-10: with agents.autoApprove [product.update] a scripted admin_products_update applies at once: one applied row decided by agents.autoApprove, one product.update audit entry by the admin under its correlation id, the price changed, a tool frame with applied true and no proposal frame', async () => {
    const store = await assistantStore({
      configure: withAgents({ autoApprove: ['product.update'] }),
    })
    try {
      const { product } = await fixture(store)
      const priceBefore = (await storeVariant(store, product.variantId)).priceMinor
      const priceMinor = priceBefore + 700
      const known = await proposalsOf(store.admin)
      store.standIn.script = callsThen([
        {
          name: 'admin_products_update',
          args: { id: product.productId, variants: [{ id: product.variantId, priceMinor }] },
        },
      ])

      const frames = await runTurn(store, ask('Raise the widget by seven pounds.'))

      const after = await proposalsOf(store.admin)
      const fresh = after.filter((p) => freshIds(known, after).includes(p.id))
      expect(fresh.map((p) => [p.status, p.decision?.by])).toEqual([
        ['applied', { kind: 'policy', rule: 'agents.autoApprove' }],
      ])
      const entries = await auditRows(store.raw, 'command = ? AND correlation_id = ?', [
        'product.update',
        fresh[0]!.correlationId,
      ])
      expect(entries.map((e) => [e.actorId, e.outcome])).toEqual([[store.admin.userId, 'applied']])
      expect((await storeVariant(store, product.variantId)).priceMinor).toBe(priceMinor)
      expect(framesOf(frames, 'proposal')).toEqual([])
      expect(
        framesOf(frames, 'tool').map((f) => [f.data['name'], f.data['ok'], f.data['applied']]),
      ).toEqual([['admin_products_update', true, true]])
    } finally {
      await store.close()
    }
  }, 60_000)

  it('AC-10: under the defaults a scripted admin_orders_refund stays pending: a proposal frame, no applied step, and the order’s captured and refunded money and refund rows unchanged', async () => {
    const { store, order } = main
    const moneyBefore = await storedMoney(store.raw, order.orderId)
    const refundsBefore = await storedRefunds(store.raw, order.orderId)
    store.standIn.reset()
    store.standIn.script = callsThen([
      { name: 'admin_orders_refund', args: { id: order.orderId, amountMinor: order.totalMinor } },
    ])

    const frames = await runTurn(store, ask('Refund that order in full.'))

    expect(framesOf(frames, 'proposal').map((f) => [f.data['tool'], f.data['status']])).toEqual([
      ['admin_orders_refund', 'pending'],
    ])
    expect(framesOf(frames, 'tool').filter((f) => f.data['applied'] === true)).toEqual([])
    expect(await storedMoney(store.raw, order.orderId)).toEqual(moneyBefore)
    expect(await storedRefunds(store.raw, order.orderId)).toEqual(refundsBefore)
  }, 60_000)

  it('AC-10: under agents.mcp.writes apply the assistant’s update and refund both stay pending: the panel is not an MCP client, so the price and the money do not move', async () => {
    const store = await assistantStore({
      configure: (config) => ({
        ...config,
        agents: { ...config.agents, mcp: { ...config.agents.mcp, writes: 'apply' } },
      }),
    })
    try {
      const { product, order } = await fixture(store)
      const priceBefore = (await storeVariant(store, product.variantId)).priceMinor
      const moneyBefore = await storedMoney(store.raw, order.orderId)
      store.standIn.script = callsThen([
        {
          name: 'admin_products_update',
          args: {
            id: product.productId,
            variants: [{ id: product.variantId, priceMinor: priceBefore + 1 }],
          },
        },
        { name: 'admin_orders_refund', args: { id: order.orderId, amountMinor: order.totalMinor } },
      ])

      const frames = await runTurn(store, ask('Raise the widget by a penny and refund that order.'))

      expect(framesOf(frames, 'proposal').map((f) => [f.data['tool'], f.data['status']])).toEqual([
        ['admin_products_update', 'pending'],
        ['admin_orders_refund', 'pending'],
      ])
      expect((await storeVariant(store, product.variantId)).priceMinor).toBe(priceBefore)
      expect(await storedMoney(store.raw, order.orderId)).toEqual(moneyBefore)
    } finally {
      await store.close()
    }
  }, 60_000)
})

async function storeVariant(store: AssistantStore, variantId: string) {
  const row = await store.raw.one<{ price_minor: number; stock: number }>(
    'SELECT price_minor, stock FROM variants WHERE id = ?',
    [variantId],
  )
  return { priceMinor: Number(row.price_minor), stock: Number(row.stock) }
}

describe('AC-11: a turn is bounded, and a refusal is a result the model reads', () => {
  it('AC-11: a script that always calls a read tool makes exactly 8 model requests and ends with one error frame assistant.step_limit; the 8th request’s calls are not run', async () => {
    const { store } = main
    store.standIn.reset()
    store.standIn.script = () => ({ toolCalls: [{ name: 'admin_dashboard', args: {} }] })

    const frames = await runTurn(store, ask('Keep checking the dashboard.'))

    expect(store.standIn.requests.length).toBe(8)
    expect(framesOf(frames, 'tool').length).toBe(store.standIn.requests.length - 1)
    expect(framesOf(frames, 'error').map((f) => f.data['code'])).toEqual(['assistant.step_limit'])
    expect(frames.at(-1)?.event).toBe('error')
    expect(framesOf(frames, 'done')).toEqual([])
  }, 60_000)

  it('AC-11: a provider that never answers ends the turn with error assistant.timeout within 2 s at limits.turnMs 500, and the model request in flight is closed', async () => {
    const { store } = main
    store.standIn.reset()
    store.standIn.script = () => ({ fail: 'hang' })
    const frames: Frame[] = []
    const { runAssistantTurn } = await loop()
    const started = performance.now()

    await runAssistantTurn(
      loopDeps(store, { turnMs: 500 }),
      adminTurn(store, 'Anything new?'),
      (frame: unknown) => void frames.push(frame as unknown as Frame),
    )

    expect(performance.now() - started).toBeLessThan(2_000)
    expect(framesOf(frames, 'error').map((f) => f.data['code'])).toEqual(['assistant.timeout'])
    await vi.waitFor(
      () => expect(store.standIn.requests.map((r) => r.closedEarly)).toEqual([true]),
      {
        timeout: 1_000,
      },
    )
  }, 30_000)

  it('AC-11: an unknown tool, arguments the route’s schema refuses and a route that answers 404 each go back to the model as an is_error tool turn carrying the code the tool surface gives, each tool frame reads ok false with that code, and the turn goes on to done', async () => {
    const { store } = main
    const calls = [
      { name: 'admin_products_frobnicate', args: { id: 'x' } },
      { name: 'admin_products_update', args: { id: 'x', variants: 'all of them' } },
      { name: 'admin_products_get', args: { id: `no-such-product-${randomUUID()}` } },
    ]
    const direct = await Promise.all(
      calls.map((c) => toolSurface(store.kernel.app).call(c.name, c.args, store.caller)),
    )
    const codes = direct.map((r) => String(r.structuredContent?.['code']))
    expect(direct.map((r) => r.isError)).toEqual([true, true, true])
    store.standIn.reset()
    store.standIn.script = callsThen(calls, 'None of that worked.')

    const frames = await runTurn(store, ask('Try these.'))

    const results = toolTurns(viewsOf(store.standIn)[1]!)
    expect(results.map((t) => t.isError)).toEqual([true, true, true])
    expect(results.map((t, i) => t.content.includes(codes[i]!))).toEqual([true, true, true])
    expect(
      framesOf(frames, 'tool').map((f) => [f.data['name'], f.data['ok'], f.data['code']]),
    ).toEqual(calls.map((c, i) => [c.name, false, codes[i]]))
    expect(framesOf(frames, 'done').map((f) => f.data['text'])).toEqual(['None of that worked.'])
  }, 60_000)

  it('AC-11: a tool result longer than 16 000 characters reaches the model as its first characters, at most 16 000 of them, and a note saying how much was cut', async () => {
    const { store } = main
    const slug = await longProduct(store, 'x'.repeat(LONG_DESCRIPTION_CHARS))
    const full = (
      await toolSurface(store.kernel.app).call('admin_products_get', { id: slug }, store.caller)
    ).content[0]!.text
    expect(full.length).toBeGreaterThan(RESULT_CHARS)
    store.standIn.reset()
    store.standIn.script = callsThen([{ name: 'admin_products_get', args: { id: slug } }])

    await runTurn(store, ask('Read me that long product.'))

    const [sent] = toolTurns(viewsOf(store.standIn)[1]!)
    let kept = 0
    while (kept < sent!.content.length && sent!.content[kept] === full[kept]) kept += 1
    const note = sent!.content.slice(kept)
    const counts = [full.length - kept, full.length].flatMap((n) => [
      String(n),
      n.toLocaleString('en-GB'),
    ])
    expect(kept).toBeLessThanOrEqual(RESULT_CHARS)
    expect(kept).toBeGreaterThan(RESULT_CHARS - NOTE_CHARS)
    expect(sent!.content.length).toBeLessThan(full.length)
    expect(note.length).toBeLessThanOrEqual(NOTE_CHARS)
    expect(
      counts.some((n) => note.includes(n)),
      `the note: ${note}`,
    ).toBe(true)
  }, 60_000)

  it('AC-11: twelve calls in one reply run the first ten (ten pending rows) and answer the other two as is_error assistant.too_many_calls in the model’s next request', async () => {
    const { store, product } = main
    const calls = Array.from({ length: 12 }, (_, i) => ({
      name: 'admin_products_update',
      args: { id: product.productId, name: `Twelve ${i + 1}` },
    }))
    const known = await proposalsOf(store.admin)
    store.standIn.reset()
    store.standIn.script = callsThen(calls)

    const frames = await runTurn(store, ask('Try twelve names.'))

    const results = toolTurns(viewsOf(store.standIn)[1]!)
    const refused = results.filter(
      (t) => t.isError === true && t.content.includes('assistant.too_many_calls'),
    )
    const proposed = results.filter((t) => parsed(t)['status'] === 'proposed')
    expect(results.length).toBe(calls.length)
    expect(proposed.length).toBe(10)
    expect(refused).toEqual(results.slice(10))
    expect(freshIds(known, await proposalsOf(store.admin)).length).toBe(proposed.length)
    expect(framesOf(frames, 'proposal').length).toBe(proposed.length)
    expect(
      framesOf(frames, 'tool').filter((f) => f.data['code'] === 'assistant.too_many_calls').length,
    ).toBe(refused.length)
  }, 60_000)

  it('AC-11: past 64 000 characters of tool results in one turn every later result is answered is_error assistant.budget_exhausted, and the turn goes on to done', async () => {
    const { store } = main
    const slug = await longProduct(store, 'y'.repeat(LONG_DESCRIPTION_CHARS))
    store.standIn.reset()
    store.standIn.script = callsThen(
      Array.from({ length: 6 }, () => ({ name: 'admin_products_get', args: { id: slug } })),
    )

    const frames = await runTurn(store, ask('Read it six times.'))

    const results = toolTurns(viewsOf(store.standIn)[1]!)
    const exhausted = (t: { isError?: boolean; content: string }) =>
      t.isError === true && t.content.includes('assistant.budget_exhausted')
    const first = results.findIndex(exhausted)
    const sent = results.slice(0, first)
    expect(results.length).toBe(6)
    expect(first).toBeGreaterThanOrEqual(3)
    expect(first).toBeLessThanOrEqual(4)
    expect(results.slice(first).every(exhausted)).toBe(true)
    expect(sent.every((t) => t.isError !== true)).toBe(true)
    expect(sent.reduce((n, t) => n + t.content.length, 0)).toBeLessThanOrEqual(
      64_000 + RESULT_CHARS + NOTE_CHARS,
    )
    expect(framesOf(frames, 'done').length).toBe(1)
  }, 60_000)
})

describe('AC-12: the tools the model is offered', () => {
  it('AC-12: the offered tools are exactly the admin’s admin-scope tools and the public reads that take no handle: admin_products_update and admin_proposals_list among them, no approve, reject, settings put or delete, enhance, assistant route, cart, checkout, alert or order-link tool', async () => {
    const { store } = main
    const listed = [...adminTools(store).values()]
    const handles = (t: (typeof listed)[number]) =>
      Object.keys(routeSchemas[`${t.route.method} ${t.route.path}`]?.handles ?? {}).length > 0
    const expected = listed
      .filter(
        (t) => t.scope === 'admin' || (t.scope === 'public' && t.kind === 'read' && !handles(t)),
      )
      .map((t) => t.name)
      .sort()
    store.standIn.reset()
    store.standIn.script = () => ({ text: 'I can help with that.' })

    await runTurn(store, ask('What can you do?'))

    const offered = viewsOf(store.standIn)[0]!.tools
    expect([...offered].sort()).toEqual(expected)
    expect(offered).toEqual(
      expect.arrayContaining(['admin_products_update', 'admin_proposals_list']),
    )
    expect(
      [
        'admin_proposals_approve',
        'admin_proposals_reject',
        'admin_settings_put',
        'admin_settings_delete',
        'admin_products_enhance',
        'admin_assistant_turn',
        'admin_assistant_stream',
        'checkout_begin',
        'cart_get',
        'alerts_subscribe',
        'orders_requestLink',
      ].filter((name) => offered.includes(name)),
    ).toEqual([])
  }, 60_000)
})

/** A chat-only ai adapter, as a third party ships one: it lists no `tools`. */
function chatOnlyAdapter(): AiAdapter {
  const result: Omit<ChatResult, 'toolCalls'> = {
    text: 'Noted.',
    stopReason: 'end',
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'acme-rules-1',
  }
  return {
    kind: 'ai',
    providerName: 'acme',
    capabilities: () => ['complete', 'chat'],
    producesEvents: [],
    consumesEvents: [],
    async initialize() {},
    async healthCheck() {
      return { status: 'healthy' }
    },
    async embed() {
      throw new Error('embed is not supported')
    },
    async complete() {
      return result.text
    },
    async chat() {
      return result as ChatResult
    },
  } as unknown as AiAdapter
}

describe('AC-13: the turn routes', () => {
  const body = ask('How many orders are waiting for payment?')

  it('AC-13: POST /api/admin/assistant/turns answers 401 with no token, 403 to a customer, 400 validation.failed for no messages, a last turn not the user’s, 41 messages and 8 001 characters, and 200 with a ticket good for 60 s to the admin; no request reaches the model', async () => {
    const { store } = main
    store.standIn.reset()
    const customer = await customerSession(store.baseUrl)
    const turn = (role: 'user' | 'assistant', content: string) => ({ role, content })
    const many = Array.from({ length: 41 }, (_, i) =>
      turn(i % 2 === 0 ? 'user' : 'assistant', `turn ${i}`),
    )

    const anonymous = await shopper(store.baseUrl).call('POST', TURNS, body)
    const shopperAnswer = await customer.send('POST', TURNS, body)
    const invalid = await Promise.all(
      [
        { messages: [] },
        { messages: [turn('user', 'Hello'), turn('assistant', 'Hi.')] },
        { messages: many },
        { messages: [turn('user', 'x'.repeat(8_001))] },
      ].map((b) => openTurn(store.admin, b)),
    )
    const issued = await openTurn(store.admin, body)

    expect([anonymous.status, shopperAnswer.status]).toEqual([401, 403])
    expect(invalid.map((a) => [a.status, a.body.error?.code])).toEqual(
      Array.from({ length: 4 }, () => [400, 'validation.failed']),
    )
    expect(issued.status).toBe(200)
    expect(issued.body.data?.expiresIn).toBe(60)
    expect(ticketPayload(issued.body.data!.ticket)['turnId']).toBe(issued.body.data!.turnId)
    expect(store.standIn.requests.length).toBe(0)
  }, 60_000)

  it('AC-13: with ai none, and with an ai adapter whose capabilities lack tools, the turn POST answers 503 assistant.unavailable (the second naming tools)', async () => {
    const none = await assistantStore({ ai: { provider: 'none' } })
    const custom = await assistantStore({
      ai: { provider: 'custom' },
      appOptions: { adapters: { ai: chatOnlyAdapter() } },
    })
    try {
      const answers = [await openTurn(none.admin, body), await openTurn(custom.admin, body)]
      expect(answers.map((a) => [a.status, a.body.error?.code])).toEqual([
        [503, 'assistant.unavailable'],
        [503, 'assistant.unavailable'],
      ])
      expect(answers[1]!.body.error?.message).toMatch(/\btools\b/)
    } finally {
      await none.close()
      await custom.close()
    }
  }, 60_000)

  it('AC-13: the stream answers one error frame and closes, calling no model, for a missing ticket, a forged one, another turn’s, an events-stream ticket, one whose roles lack admin, a replayed one, one older than 60 s and a turn older than 120 s; /api/admin/events refuses an assistant ticket as ticket.invalid', async () => {
    const { store } = main
    const issue = () => issueTurn(store.admin, body)
    const refusal = async (path: string) => {
      const before = store.standIn.requests.length
      const read = await readStream(store.baseUrl, path)
      return {
        frames: read.frames.map((f) => [f.event, f.data['code']]),
        ended: read.ended,
        modelCalls: store.standIn.requests.length - before,
      }
    }
    const later = async (ms: number, path: string) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.now() + ms)
        return await refusal(path)
      } finally {
        vi.useRealTimers()
      }
    }
    store.standIn.reset()
    store.standIn.script = () => ({ text: 'Noted.' })

    const a = await issue()
    const b = await issue()
    const forged = await issue()
    const unprivileged = await issue()
    const replayed = await issue()
    const stale = await issue()
    const gone = await issue()
    const events = await store.admin.send<{ ticket: string }>('POST', '/api/admin/events/ticket')
    const key = assistantTicketKey(store.jwtSecret)

    const cases: Array<[string, Awaited<ReturnType<typeof refusal>>, string[]]> = [
      ['missing', await refusal(streamPath(a.turnId)), ['ticket.missing']],
      [
        'signed with the JWT secret itself',
        await refusal(
          streamPath(forged.turnId, signTicket(ticketPayload(forged.ticket), store.jwtSecret)),
        ),
        ['ticket.invalid'],
      ],
      ['another turn’s', await refusal(streamPath(b.turnId, a.ticket)), ['ticket.invalid']],
      [
        'an events ticket',
        await refusal(streamPath(b.turnId, events.body.data!.ticket)),
        ['ticket.invalid'],
      ],
      [
        'roles without admin',
        await refusal(
          streamPath(
            unprivileged.turnId,
            signTicket({ ...ticketPayload(unprivileged.ticket), roles: ['customer'] }, key),
          ),
        ),
        ['ticket.forbidden'],
      ],
      [
        'older than 60 s',
        await later(61_000, streamPath(stale.turnId, stale.ticket)),
        ['ticket.expired'],
      ],
      [
        'a turn older than 120 s',
        await later(121_000, streamPath(gone.turnId, gone.ticket)),
        ['ticket.expired', 'assistant.turn_missing'],
      ],
    ]
    const opened = await readStream(store.baseUrl, streamPath(replayed.turnId, replayed.ticket))
    cases.push([
      'replayed',
      await refusal(streamPath(replayed.turnId, replayed.ticket)),
      ['ticket.replayed'],
    ])
    const crossed = await readStream(
      store.baseUrl,
      `/api/admin/events?ticket=${encodeURIComponent(b.ticket)}`,
      () => true,
    )

    for (const [label, outcome, codes] of cases) {
      expect(outcome.frames.length, label).toBe(1)
      expect(outcome.frames[0]![0], label).toBe('error')
      expect(codes, `${label}: ${String(outcome.frames[0]![1])}`).toContain(outcome.frames[0]![1])
      expect(outcome.ended, label).toBe(true)
      expect(outcome.modelCalls, label).toBe(0)
    }
    expect(framesOf(opened.frames, 'done').length).toBe(1)
    expect(crossed.frames.map((f) => [f.event, f.data['code']])).toEqual([
      ['error', 'ticket.invalid'],
    ])
  }, 60_000)
})

describe('AC-14: closing the stream stops the turn', () => {
  /** A first answer streamed a word at a time, then a write: what a turn the merchant left would go on to propose. */
  const slowThenWrite = (fx: Fixture) => () => ({
    text: 'Let me look through every product in the store before I change anything for you.',
    toolCalls: [
      { name: 'admin_products_update', args: { id: fx.product.productId, name: 'Left behind' } },
    ],
    delayMs: 200,
  })

  it('AC-14: the client closing the stream after the first text frame closes the model request in flight; no further model request and no proposal follow', async () => {
    const { store } = main
    const known = await proposalsOf(store.admin)
    store.standIn.reset()
    store.standIn.script = slowThenWrite(main)
    const issued = await issueTurn(store.admin, ask('Rename the widget.'))

    const read = await readStream(
      store.baseUrl,
      streamPath(issued.turnId, issued.ticket),
      (frame) => frame.event === 'text',
    )

    expect(read.ended).toBe(false)
    await vi.waitFor(
      () => expect(store.standIn.requests.map((r) => r.closedEarly)).toEqual([true]),
      {
        timeout: 5_000,
      },
    )
    expect(store.standIn.requests.length).toBe(1)
    expect(freshIds(known, await proposalsOf(store.admin))).toEqual([])
  }, 30_000)

  it('AC-14: an aborted signal stops the loop: once runAssistantTurn settles after an abort at the first text frame, the model saw one request, closed early, no tool ran and no proposal was made', async () => {
    const { store } = main
    const known = await proposalsOf(store.admin)
    store.standIn.reset()
    store.standIn.script = slowThenWrite(main)
    const abort = new AbortController()
    const frames: Frame[] = []

    const { runAssistantTurn } = await loop()
    await runAssistantTurn(
      loopDeps(store),
      adminTurn(store, 'Rename the widget.'),
      (frame: unknown) => {
        frames.push(frame as unknown as Frame)
        if ((frame as unknown as Frame).event === 'text') abort.abort()
      },
      abort.signal,
    ).catch(() => undefined)

    await vi.waitFor(
      () => expect(store.standIn.requests.map((r) => r.closedEarly)).toEqual([true]),
      {
        timeout: 2_000,
      },
    )
    expect(store.standIn.requests.length).toBe(1)
    expect([...framesOf(frames, 'tool'), ...framesOf(frames, 'proposal')]).toEqual([])
    expect(freshIds(known, await proposalsOf(store.admin))).toEqual([])
  }, 30_000)
})

describe('AC-15: no key and no conversation in the logs', () => {
  it('AC-15: property: over a random configured key and a random question, a turn with a read and a write that ends on a provider error logs no record (any level, every argument inspected) carrying the key, the question, the model’s text, a tool’s arguments or a tool’s result, and no frame carries the key or the error frame the question', async () => {
    const word = fc.stringMatching(/^[A-Za-z]{3,9}$/)
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        fc.array(word, { minLength: 2, maxLength: 6 }),
        fc.uuid(),
        async (key, words, tag) => {
          const question = `${words.join(' ')} ${tag}?`
          const answer = `Answer-${tag.slice(0, 8)}-said`
          const argument = `Argument-${tag.slice(9, 18)}-sent`
          const result = `Result-${tag.slice(19)}-read`
          const logs = captureLogs()
          const store = await assistantStore({ key, logger: logs.logger })
          try {
            const { product } = await fixture(store)
            const slug = await longProduct(store, result)
            const mark = { calls: logs.calls.length, written: logs.written().length }
            store.standIn.script = (view) =>
              view.index === 0
                ? {
                    text: `Checking ${answer}`,
                    toolCalls: [
                      { name: 'admin_products_get', args: { id: slug } },
                      {
                        name: 'admin_products_update',
                        args: { id: product.productId, name: argument },
                      },
                    ],
                  }
                : { fail: 'status:500' }

            const frames = await runTurn(store, ask(question))

            const views = viewsOf(store.standIn)
            expect(views.length).toBe(2)
            expect(toolTurns(views[1]!).some((t) => t.content.includes(result))).toBe(true)
            expect(framesOf(frames, 'tool').length + framesOf(frames, 'proposal').length).toBe(2)
            const records = [
              ...logs.calls
                .slice(mark.calls)
                .flatMap((c) => [
                  inspect(c.obj, { depth: 12 }),
                  c.msg ?? '',
                  inspect(c.bindings, { depth: 12 }),
                ]),
              ...stringsIn(logs.written().slice(mark.written)),
            ]
            const errorFrames = framesOf(frames, 'error')
            expect(leaks(records, key)).toEqual([])
            expect(
              [question, answer, argument, result].filter((text) =>
                records.some((r) => r.includes(text)),
              ),
            ).toEqual([])
            expect(leaks([JSON.stringify(frames)], key)).toEqual([])
            expect(errorFrames.length).toBe(1)
            expect(JSON.stringify(errorFrames)).not.toContain(question)
          } finally {
            await store.close()
          }
        },
      ),
      { numRuns: 4 },
    )
  }, 180_000)
})
