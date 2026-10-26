import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { EVT_ORDER_PAID } from '@nymbalhq/types'
import { fakeSmtpServer, type FakeSmtpServer } from '../../../../tests/support/smtp-server.js'
import { checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { eventRows, maxSeq } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'

// AC-7 on SQLite: the order-placed email through the real SMTP adapter, to a mail host that refuses the next recipient
// with 451. The paid checkout's order.paid.v1 stays in the log, and the relay's retry, once its wait is over (an
// injected clock), sends the one email. Nothing reads how the handler or the relay is built.

const RETRY_DELAY_MS = 60_000

let smtp: FakeSmtpServer
let k: Kernel
let raw: RawReader
const clock = { offset: 0 }

beforeAll(async () => {
  smtp = await fakeSmtpServer()
  k = await createKernel({
    dialect: 'sqlite',
    configure: (config) =>
      ({
        ...config,
        commerce: {
          ...config.commerce,
          email: {
            provider: 'smtp',
            config: {
              from: 'shop@retries.test',
              smtp: { host: '127.0.0.1', port: smtp.port, secure: false },
            },
          },
        },
      }) as NymbalConfig,
    appOptions: {
      relay: { retryDelayMs: RETRY_DELAY_MS, now: () => new Date(Date.now() + clock.offset) },
    },
  })
  raw = openRaw(k.dialect, k.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await k?.close()
  await smtp?.close()
})

describe('AC-7: the order-placed email after an SMTP refusal', () => {
  it('AC-7: with the mail host refusing the next recipient with 451, a paid checkout leaves no message and order.paid.v1 undelivered with attempts 1; the retry sends one message to the buyer naming the order and delivers the event; a further drain sends nothing', async () => {
    const seeded = await seedVariant(k, 5)
    const buyer = `buyer-${randomUUID()}@retries.test`
    const before = await maxSeq(raw)
    const sentBefore = smtp.messages.length
    smtp.refuseRecipients(1)

    const started = await checkoutOf(k, seeded, 1, buyer)
    await k.app.relay.drain()

    const paidRow = async () => {
      const rows = await eventRows(raw, 'seq > ? AND type = ?', [before, EVT_ORDER_PAID])
      expect(rows.length, 'order.paid.v1 rows for the checkout').toBe(1)
      return rows[0]!
    }
    const first = await paidRow()
    expect(smtp.refused(), 'the mail host refused the send').toBe(1)
    expect(smtp.messages.length, 'messages after the refusal').toBe(sentBefore)
    expect([first.attempts, first.deliveredAt ?? null]).toEqual([1, null])

    clock.offset += 24 * 60 * 60_000
    await k.app.relay.drain()

    const toBuyer = smtp.recipients
      .map((to, i) => ({ to, data: smtp.messages[i]! }))
      .slice(sentBefore)
      .filter((m) => m.to.includes(buyer))
    expect(toBuyer.length, 'messages to the buyer after the retry').toBe(1)
    expect(smtp.messages.length, 'messages after the retry').toBe(sentBefore + 1)
    expect(toBuyer[0]!.data).toContain(started.orderNumber)
    const retried = await paidRow()
    expect(retried.attempts).toBe(first.attempts)
    expect(retried.deliveredAt).not.toBeNull()

    const sentAfterRetry = smtp.messages.length
    clock.offset += 24 * 60 * 60_000
    await k.app.relay.drain()
    expect(smtp.messages.length, 'a further drain sent more mail').toBe(sentAfterRetry)
  })
})
