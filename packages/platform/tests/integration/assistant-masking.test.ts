import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { AiScript, ScriptView } from '../../../../tests/support/ai-stand-in.js'
import {
  ask,
  assistantStore,
  framesOf,
  openTurn,
  parsed,
  proposalsOf,
  runTurn,
  toolTurns,
  viewsOf,
  withAgents,
  type AssistantStore,
  type Frame,
} from '../support/assistant.js'
import { cartWith } from '../support/kernel.js'
import { shopper as shopperClient } from '../support/shopper.js'
import { captureLogs, stringsIn } from '../support/settings.js'

// The assistant's masking through its routes on SQLite, the ai slot on a provider stand-in in `script` mode, the
// config at its default (`agents.assistant.mask` left out) unless a case sets it.
// - AC-7: the answer shows the email the model only saw as a token; no request carries a seeded detail; mask [] sends
//   them as they are.
// - AC-8: property, a write's placeholder reaches its proposal as the value; no stored row, document, event or log
//   holds a token, and no log a seeded detail; each call line's masked counts its replacements; an unminted
//   placeholder writes nothing; a review holding [email-1] is never rewritten.
// - AC-15: an answer's revealed spans travel with the next question, so a follow-up masks what the panel showed; the
//   turn POST refuses a malformed span and keeps no turn for it.

const SHAPED = /\[(email|phone|address|postcode|name)-\d+\]/
const SHAPED_ALL = new RegExp(SHAPED.source, 'g')
const TURNS = 'assistant-turns'

interface Seed {
  customerId: string
  email: string
  phone: string
  addressLine1: string
  addressLine2: string
  postalCode: string
  orderNumber: string
  productId: string
  reviewId: string
}

/** The seeded details a masked turn must never send or log. */
const detailsOf = (seed: Seed): string[] => [
  seed.email,
  seed.phone,
  seed.addressLine1,
  seed.addressLine2,
  seed.postalCode,
]

/**
 * A customer with marker details (email, phone, two street lines, postcode) registered over HTTP, an order of theirs,
 * and a review of theirs whose body holds `[email-1]`.
 */
async function maskedCustomer(store: AssistantStore): Promise<Seed> {
  const hex = randomUUID().replaceAll('-', '')
  const email = `masked-${hex.slice(0, 12)}@customers.test`
  const phone = `07${String(parseInt(hex.slice(0, 8), 16))
    .padStart(10, '0')
    .slice(0, 9)}`
  const addressLine1 = `${hex.slice(8, 16)} Marker Lane`
  const addressLine2 = `Unit ${hex.slice(16, 22)}`
  const postalCode = `MK${hex.slice(22, 26).toUpperCase()} 1AA`
  const home = {
    firstName: 'Ada',
    lastName: `Masked${hex.slice(26, 32)}`,
    addressLine1,
    addressLine2,
    city: 'London',
    region: 'England',
    postalCode,
    country: 'GB',
    phone,
  }
  const shop = shopperClient(store.baseUrl)
  const registered = await shop.call<{ customer: { id: string }; accessToken: string }>(
    'POST',
    '/api/auth/register',
    { email, password: 'correct-horse-battery', firstName: 'Ada', lastName: home.lastName, phone },
  )
  if (registered.status !== 201) throw new Error(`register: ${JSON.stringify(registered.body)}`)
  const customerId = registered.body.data!.customer.id
  const bearer = { headers: { authorization: `Bearer ${registered.body.data!.accessToken}` } }
  const saved = await shop.call('POST', '/api/customers/me/addresses', home, bearer)
  if (saved.status >= 300) throw new Error(`address: ${JSON.stringify(saved.body)}`)
  const tag = randomUUID()
  const created = await store.kernel.services.product.create({
    slug: `masked-${tag}`,
    name: `Masked Lamp ${tag.slice(0, 8)}`,
    description: 'A lamp.',
    status: 'active',
    variants: [
      {
        sku: `MASK-${tag}`,
        name: 'Default',
        priceMinor: 1500,
        stock: 12,
        lowStockThreshold: 0,
        options: [],
      },
    ],
  })
  await store.kernel.app.relay.drain()
  const bought = {
    productId: created.id,
    variantId: created.variants[0]!.id,
    priceMinor: 1500,
    initialStock: 12,
  }
  const cartToken = await cartWith(store.kernel, bought, 1)
  const order = await store.kernel.services.checkout.beginCheckout({
    cartToken,
    customerId,
    email,
    billingAddress: home,
    shippingAddress: home,
  })
  const reviewed = await shop.call<{ review: { id: string } }>(
    'POST',
    '/api/reviews',
    {
      productId: bought.productId,
      rating: 4,
      title: 'A question',
      body: 'Email me at [email-1] about the lamp.',
    },
    bearer,
  )
  if (reviewed.status !== 200) throw new Error(`review: ${JSON.stringify(reviewed.body)}`)
  await store.kernel.app.relay.drain()
  return {
    customerId,
    email,
    phone,
    addressLine1,
    addressLine2,
    postalCode,
    orderNumber: order.orderNumber,
    productId: bought.productId,
    reviewId: reviewed.body.data!.review.id,
  }
}

/** The first string anywhere in `value` under `key`. */
function firstUnder(value: unknown, key: string): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUnder(item, key)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record[key] === 'string') return record[key]
  for (const child of Object.values(record)) {
    const found = firstUnder(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

const answerOf = (frames: Frame[]) => ({
  streamed: framesOf(frames, 'text')
    .map((f) => String(f.data['delta']))
    .join(''),
  done: String(framesOf(frames, 'done')[0]?.data['text']),
})

/** Reads the order, then answers with the email field as the model read it. */
const placedBy =
  (orderNumber: string): AiScript =>
  (view) =>
    view.turns.at(-1)?.role === 'tool'
      ? { text: `placed by ${String(parsed(toolTurns(view)[0]!)['email'])}` }
      : { toolCalls: [{ name: 'admin_orders_get', args: { orderNumber } }] }

let main: AssistantStore
beforeAll(async () => {
  main = await assistantStore()
}, 60_000)
afterAll(async () => {
  await main?.close()
})

describe('AC-7: the answer shows the email the provider only saw as a token', () => {
  it('AC-7: with the config default, a model that reads the order and answers with its email as read shows the seeded email in the text frames and the done text; its second request holds [email-1] and no request holds the email, phone, either street line or the postcode; under mask [] the second request holds the email', async () => {
    const seed = await maskedCustomer(main)
    main.standIn.reset()
    main.standIn.script = placedBy(seed.orderNumber)

    const answer = answerOf(await runTurn(main, ask(`Who placed order #${seed.orderNumber}?`)))
    const sent = main.standIn.requests.map((r) => JSON.stringify(r.body))

    expect(main.standIn.scriptErrors).toEqual([])
    expect(answer.streamed).toBe(answer.done)
    expect(answer.done).toBe(`placed by ${seed.email}`)
    expect(sent.length).toBe(2)
    expect(sent[1]).toContain('[email-1]')
    expect(detailsOf(seed).filter((value) => sent.some((body) => body.includes(value)))).toEqual([])

    const off = await assistantStore({
      configure: withAgents({ assistant: { customerData: true, mask: [] } } as Partial<
        NymbalConfig['agents']
      >),
    })
    try {
      const plain = await maskedCustomer(off)
      off.standIn.script = placedBy(plain.orderNumber)

      const shown = answerOf(await runTurn(off, ask(`Who placed order #${plain.orderNumber}?`)))

      expect(JSON.stringify(off.standIn.requests[1]?.body)).toContain(plain.email)
      expect(shown.done).toBe(`placed by ${plain.email}`)
    } finally {
      await off.close()
    }
  }, 120_000)
})

describe('AC-8: tokens live only in the turn', () => {
  const READS = ['order', 'customer', 'customerOrders', 'reviews'] as const
  type ReadKind = (typeof READS)[number]

  const readOf = (kind: ReadKind, seed: Seed) =>
    ({
      order: { name: 'admin_orders_get', args: { orderNumber: seed.orderNumber } },
      customer: { name: 'admin_customers_get', args: { id: seed.customerId } },
      customerOrders: { name: 'admin_customers_orders', args: { id: seed.customerId } },
      reviews: { name: 'admin_reviews_pending', args: {} },
    })[kind]

  /** What a turn leaves after `mark`: the proposals, audit entries and events it added, and the turn records. */
  async function leftSince(
    store: AssistantStore,
    mark: { seq: number; audit: Set<string>; proposals: Set<string> },
  ) {
    const proposals = await store.raw.rows<Record<string, unknown>>('SELECT * FROM proposals')
    const audit = await store.raw.rows<Record<string, unknown>>('SELECT * FROM audit_entries')
    const events = await store.raw.rows<Record<string, unknown>>(
      'SELECT * FROM events WHERE seq > ?',
      [mark.seq],
    )
    const turns = await store.kernel.documentStore.query<Record<string, unknown>>(TURNS, {
      partitionKey: { field: 'uid', value: '*' },
      limit: 500,
    })
    return {
      proposals: proposals.filter((row) => !mark.proposals.has(String(row['id']))),
      audit: audit.filter((row) => !mark.audit.has(String(row['id']))),
      events,
      turns: turns.items,
    }
  }

  async function markOf(store: AssistantStore) {
    const seq = await store.raw.one<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM events')
    const audit = await store.raw.rows<{ id: string }>('SELECT id FROM audit_entries')
    const proposals = await store.raw.rows<{ id: string }>('SELECT id FROM proposals')
    return {
      seq: Number(seq.seq ?? 0),
      audit: new Set(audit.map((a) => a.id)),
      proposals: new Set(proposals.map((p) => p.id)),
    }
  }

  it('AC-8: property: for any turn reading the order, the customer, their orders and the pending reviews, and writing Ask <the email as read>: the proposal’s description holds the seeded email; no new proposal row, audit entry or event, no assistant-turns record and no captured log line or binding holds token-shaped text, and no log line or binding a seeded detail; each call line’s masked counts the tokens its result reached the model with; a turn writing Ask [email-9] makes no proposal, product.update audit entry or event and leaves the product as it was; the review still holds [email-1]', async () => {
    const logs = captureLogs()
    const store = await assistantStore({ logger: logs.logger })
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom(...READS), { minLength: 0, maxLength: 3 }),
          fc.boolean(),
          async (reads, write) => {
            const seed = await maskedCustomer(store)
            const mark = await markOf(store)
            const logMark = { calls: logs.calls.length, written: logs.written().length }
            const calls = [readOf('order', seed), ...reads.map((kind) => readOf(kind, seed))]
            store.standIn.reset()
            store.standIn.script = (view: ScriptView) => {
              if (view.index === 0) return { toolCalls: calls }
              if (view.index === 1 && write) {
                const token = String(parsed(toolTurns(view)[0]!)['email'])
                return {
                  toolCalls: [
                    {
                      name: 'admin_products_update',
                      args: { id: seed.productId, description: `Ask ${token}` },
                    },
                  ],
                }
              }
              return { text: 'Done.' }
            }
            const known = new Set((await proposalsOf(store.admin)).map((p) => p.id))

            await runTurn(
              store,
              ask(`Who placed order #${seed.orderNumber}, and what do they say?`),
            )

            expect(store.standIn.scriptErrors).toEqual([])
            const made = (await proposalsOf(store.admin)).filter((p) => !known.has(p.id))
            expect(made.map((p) => p.args['description'])).toEqual(
              write ? [`Ask ${seed.email}`] : [],
            )

            const left = await leftSince(store, mark)
            const stored = [
              ...stringsIn(left.proposals),
              ...stringsIn(left.audit),
              ...stringsIn(left.events),
              ...stringsIn(left.turns),
            ]
            expect(stored.filter((s) => SHAPED.test(s))).toEqual([])

            const after = logs.calls.slice(logMark.calls)
            const records = [
              ...after.flatMap((c) => [
                inspect(c.obj, { depth: 12 }),
                c.msg ?? '',
                inspect(c.bindings, { depth: 12 }),
              ]),
              ...stringsIn(logs.written().slice(logMark.written)),
            ]
            expect(records.filter((r) => SHAPED.test(r))).toEqual([])
            expect(detailsOf(seed).filter((v) => records.some((r) => r.includes(v)))).toEqual([])

            // Each call's line, in call order, against the tool turn the model read it in.
            const views = viewsOf(store.standIn)
            const answered = views.slice(1).flatMap((view) => toolTurns(view))
            const lines = after
              .filter((c) => c.msg === 'assistant tool call')
              .map((c) => (c.obj as Record<string, unknown>)['masked'])
            expect(lines).toEqual(answered.map((t) => [...t.content.matchAll(SHAPED_ALL)].length))
          },
        ),
        { numRuns: 5 },
      )

      // An unminted placeholder in a write: nothing is proposed, audited, published or changed.
      const seed = await maskedCustomer(store)
      const before = await store.raw.rows('SELECT * FROM products WHERE id = ?', [seed.productId])
      const mark = await markOf(store)
      const known = new Set((await proposalsOf(store.admin)).map((p) => p.id))
      store.standIn.reset()
      store.standIn.script = (view: ScriptView) =>
        view.index === 0
          ? { toolCalls: [readOf('order', seed), readOf('reviews', seed)] }
          : view.index === 1
            ? {
                toolCalls: [
                  {
                    name: 'admin_products_update',
                    args: { id: seed.productId, description: 'Ask [email-9]' },
                  },
                ],
              }
            : { text: 'Done.' }

      const frames = await runTurn(store, ask('Ask them about the lamp.'))

      const left = await leftSince(store, mark)
      expect(left.proposals).toEqual([])
      expect((await proposalsOf(store.admin)).filter((p) => !known.has(p.id))).toEqual([])
      expect(left.audit.filter((a) => a['command'] === 'product.update')).toEqual([])
      expect(left.events.filter((e) => /proposal|product/.test(String(e['type'])))).toEqual([])
      expect(await store.raw.rows('SELECT * FROM products WHERE id = ?', [seed.productId])).toEqual(
        before,
      )
      expect(
        framesOf(frames, 'tool')
          .filter((f) => f.data['name'] === 'admin_products_update')
          .map((f) => [f.data['ok'], f.data['code']]),
      ).toEqual([[false, 'assistant.unknown_placeholder']])
      const review = await store.raw.one<{ body: string }>(
        'SELECT body FROM reviews WHERE id = ?',
        [seed.reviewId],
      )
      expect(review.body).toBe('Email me at [email-1] about the lamp.')
    } finally {
      await store.close()
    }
  }, 300_000)
})

describe('AC-15: a follow-up masks what an earlier answer revealed', () => {
  it('AC-15: turn one’s answer naming the street line and postcode carries revealed spans covering exactly them, by kind; turn two, POSTed with those spans and a follow-up, sends neither in any request, its first request holds [address-1] and [postcode-1], and its answer quoting them shows the real values', async () => {
    const seed = await maskedCustomer(main)
    main.standIn.reset()
    main.standIn.script = (view) => {
      if (view.turns.at(-1)?.role !== 'tool') {
        return { toolCalls: [{ name: 'admin_customers_get', args: { id: seed.customerId } }] }
      }
      const record = parsed(toolTurns(view)[0]!)
      return {
        text: `Ship to ${String(firstUnder(record, 'addressLine1'))}, ${String(firstUnder(record, 'postalCode'))}.`,
      }
    }
    const question = 'Where do we ship their orders?'

    const first = await runTurn(main, ask(question))

    const answer = answerOf(first)
    const spans: Array<{ start: number; end: number; kind: string }> = []
    let offset = 0
    for (const f of framesOf(first, 'text')) {
      for (const s of (f.data['revealed'] as typeof spans | undefined) ?? []) {
        spans.push({ start: offset + s.start, end: offset + s.end, kind: s.kind })
      }
      offset += String(f.data['delta']).length
    }
    expect(answer.done).toBe(`Ship to ${seed.addressLine1}, ${seed.postalCode}.`)
    expect(answer.streamed).toBe(answer.done)
    expect(spans).toEqual([
      {
        start: answer.done.indexOf(seed.addressLine1),
        end: answer.done.indexOf(seed.addressLine1) + seed.addressLine1.length,
        kind: 'address',
      },
      {
        start: answer.done.indexOf(seed.postalCode),
        end: answer.done.indexOf(seed.postalCode) + seed.postalCode.length,
        kind: 'postcode',
      },
    ])

    main.standIn.reset()
    main.standIn.script = (view) => {
      const earlier = view.turns.filter((t) => t.role === 'assistant').at(-1)?.content ?? ''
      return { text: `They live at ${earlier.replace(/^Ship to /, '')}` }
    }
    const second = await runTurn(main, {
      messages: [
        { role: 'user', content: question },
        { role: 'assistant', content: answer.done, revealed: spans },
        { role: 'user', content: 'And where exactly is that?' },
      ],
    } as Parameters<typeof runTurn>[1])

    const sent = main.standIn.requests.map((r) => JSON.stringify(r.body))
    expect(
      [seed.addressLine1, seed.postalCode].filter((v) => sent.some((b) => b.includes(v))),
    ).toEqual([])
    expect(['[address-1]', '[postcode-1]'].filter((t) => !sent[0]!.includes(t))).toEqual([])
    expect(answerOf(second).done).toBe(`They live at ${seed.addressLine1}, ${seed.postalCode}.`)
  }, 120_000)

  it('AC-15: the turn POST answers 400 validation.failed naming messages, keeps no turn and sends no model request for a span past the content, an empty or backwards span, a negative or fractional offset, overlapping or out-of-order spans, 201 spans, an unknown kind, and revealed on a user message; 200 spans in order are taken', async () => {
    const content = 'Ship to 12 Acacia Road, SW1A 1AA.'
    const street = { start: 8, end: 22, kind: 'address' }
    const postcode = { start: 24, end: 32, kind: 'postcode' }
    const body = (revealed: unknown[], text = content, onUser = false) => ({
      messages: [
        { role: 'user', content: 'Where to?', ...(onUser && { revealed }) },
        { role: 'assistant', content: text, ...(!onUser && { revealed }) },
        { role: 'user', content: 'And then?' },
      ],
    })
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ start: 2 * i, end: 2 * i + 1, kind: 'name' }))
    const refused = [
      body([{ ...street, end: content.length + 1 }]),
      body([{ ...street, end: street.start }]),
      body([{ ...street, start: street.end, end: street.start }]),
      body([{ ...street, start: -1 }]),
      body([{ ...street, start: 8.5 }]),
      body([street, { ...postcode, start: 20 }]),
      body([postcode, street]),
      body(many(201), 'x'.repeat(402)),
      body([{ ...street, kind: 'city' }]),
      body([{ start: 0, end: 5, kind: 'name' }], content, true),
    ]
    main.standIn.reset()
    const turnsBefore = (
      await main.kernel.documentStore.query(TURNS, { partitionKey: { field: 'uid', value: '*' } })
    ).items.length

    const answers = []
    for (const b of refused) answers.push(await openTurn(main.admin, b))
    const taken = await openTurn(main.admin, body(many(200), 'x'.repeat(400)))

    const named = answers.map((a) =>
      (
        (a.body.error as { context?: { issues?: Array<{ path: unknown[] }> } } | undefined)?.context
          ?.issues ?? []
      ).some((issue) => issue.path[1] === 'messages'),
    )
    expect(answers.map((a) => [a.status, a.body.error?.code])).toEqual(
      refused.map(() => [400, 'validation.failed']),
    )
    expect(named).toEqual(refused.map(() => true))
    expect(taken.status).toBe(200)
    const turnsAfter = (
      await main.kernel.documentStore.query(TURNS, { partitionKey: { field: 'uid', value: '*' } })
    ).items.length
    expect(turnsAfter).toBe(turnsBefore + 1)
    expect(main.standIn.requests.length).toBe(0)
  }, 60_000)
})
