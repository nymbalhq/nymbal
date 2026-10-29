import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { customSlots, postDelivery } from '../support/inbound-webhooks.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { eventRows } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { createTestHooksAdapter, signedDelivery } from '../support/test-hooks.js'
import { createTestMailAdapter, type TestMailAdapter } from '../support/test-mail.js'

// Only the email slot's own adapter can stop a store's alert mail: a bounce event of the email adapter's name that
// comes from another slot, or that names an email adapter taking no webhooks, suppresses nobody. Read as outcomes: the
// next restock still alerts the address, and email_suppressions stays empty.

const SUPPRESSIONS = 'email_suppressions'

const bouncePayload = (recipient: string) => ({
  recipient,
  bounce: 'hard',
  messageId: null,
  occurredAt: new Date().toISOString(),
})

async function delivered(raw: RawReader): Promise<void> {
  await vi.waitFor(
    async () => {
      const open = (await eventRows(raw)).filter((r) => r.deliveredAt == null && r.deadAt == null)
      expect(open.map((r) => r.type)).toEqual([])
    },
    { timeout: 10_000, interval: 20 },
  )
}

/** A product out of stock and an active back-in-stock row for `email`, written through the repository. */
async function activeRow(k: Kernel, email: string) {
  const tag = randomUUID().slice(0, 8)
  const product = await k.services.product.create({
    slug: `slots-${tag}`,
    name: `Slots Widget ${tag}`,
    description: '',
    status: 'active',
    variants: [
      {
        sku: `SLOTS-${tag}`,
        name: 'Default',
        priceMinor: 900,
        stock: 0,
        lowStockThreshold: 0,
        options: [],
      },
    ],
  })
  const variantId = product.variants[0]!.id
  const at = new Date()
  const row = await k.store.transaction(async (tx) => {
    const pending = await k.repos.alertSubscription.upsertPending(tx, {
      id: randomUUID(),
      email,
      kind: 'back_in_stock',
      variantId,
      productId: product.id,
      confirmToken: randomUUID(),
      unsubscribeToken: randomUUID(),
      origin: 'http://shop-a.test',
      baselinePriceMinor: null,
      at,
    })
    return k.repos.alertSubscription.update(
      tx,
      pending.id,
      { status: 'active', updatedAt: at, confirmedAt: at },
      ['pending'],
    )
  })
  return { variantId, rowId: row!.id }
}

async function statusOf(raw: RawReader, rowId: string): Promise<string> {
  const row = await raw.one<{ status: string }>(
    'SELECT status FROM alert_subscriptions WHERE id = ?',
    [rowId],
  )
  return row.status
}

async function sentFor(raw: RawReader, rowId: string): Promise<number> {
  return (await eventRows(raw, 'type = ?', ['alert.sent.v1'])).filter(
    (e) => (e.envelope.payload as { subscriptionId?: string }).subscriptionId === rowId,
  ).length
}

describe('a bounce from another slot under the email adapter’s name', () => {
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader
  let mail: TestMailAdapter

  beforeAll(async () => {
    // The email adapter is named acme and takes no webhooks (its receiveWebhook is undefined, which the route counts
    // as hookless); the shipping adapter, also acme, takes them and declares acme.bounced.v1.
    mail = { ...createTestMailAdapter({ providerName: 'acme' }), receiveWebhook: undefined }
    k = await createKernel({
      dialect: 'sqlite',
      configure: customSlots('email', 'shipping'),
      appOptions: {
        adapters: {
          email: mail,
          shipping: createTestHooksAdapter({
            providerName: 'acme',
            producesEvents: ['acme.bounced.v1'],
          }),
        },
      },
    })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  it('AC-9: a signed acme.bounced.v1 hard bounce for A from the hooked shipping adapter acme is received, but A is not suppressed: A’s active back-in-stock row is mailed on the next restock and email_suppressions holds no row for A', async () => {
    const a = `a-${randomUUID()}@slots.test`
    const { variantId, rowId } = await activeRow(k, a)
    const id = `dlv_${randomUUID()}`

    const answer = await postDelivery(
      served.baseUrl,
      'acme',
      signedDelivery({ id, events: [{ type: 'acme.bounced.v1', payload: bouncePayload(a) }] }),
    )
    expect([answer.status, answer.data], JSON.stringify(answer.body)).toEqual([
      200,
      { received: true, events: 1 },
    ])
    await delivered(raw)
    const mailedBefore = mail.sent.filter(
      (m) => m.to === a && m.template === 'alert-back-in-stock',
    ).length

    await k.services.inventory.adjustStock(variantId, 1, 'manual', 'slots-test')
    await delivered(raw)

    const mailedAfter = mail.sent.filter(
      (m) => m.to === a && m.template === 'alert-back-in-stock',
    ).length
    expect(mailedAfter).toBe(mailedBefore + 1)
    expect([await statusOf(raw, rowId), await sentFor(raw, rowId)]).toEqual(['fired', 1])
    expect(await raw.count(SUPPRESSIONS, 'email = ?', [a])).toBe(0)
  })
})

describe('a bounce event under the native email adapter’s name', () => {
  let k: Kernel
  let raw: RawReader

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await k?.close()
  })

  it('AC-9: on a native email store, a native.bounced.v1 hard bounce for A published to the log suppresses nobody: after the restock A’s row is fired with its alert.sent.v1, and email_suppressions holds no row for A', async () => {
    const a = `a-${randomUUID()}@slots.test`
    const { variantId, rowId } = await activeRow(k, a)
    const sentBefore = await sentFor(raw, rowId)

    await k.publisher.publishUntyped([{ type: 'native.bounced.v1', payload: bouncePayload(a) }], {
      source: 'webhook:native',
    })
    await delivered(raw)
    await k.services.inventory.adjustStock(variantId, 1, 'manual', 'slots-test')
    await delivered(raw)

    expect([await statusOf(raw, rowId), await sentFor(raw, rowId)]).toEqual([
      'fired',
      sentBefore + 1,
    ])
    expect(await raw.count(SUPPRESSIONS, 'email = ?', [a])).toBe(0)
  })
})
