import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { createMailgunEmailAdapter } from '@nymbalhq/email-mailgun'
import type { EmailAdapter, Logger, TransactionalEmail } from '@nymbalhq/types'
import {
  changeOneCharacter,
  MAILGUN_TEST_SIGNING_KEY,
  mailgunRequest,
  permanentFailure,
  policyRejection,
  signedBody,
  signedPost,
  type MailgunSignature,
} from '../../../../tests/support/mailgun.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { customSlots, postDelivery } from '../support/inbound-webhooks.js'
import { createKernel, kernelConfig, type Kernel } from '../support/kernel.js'
import { unaudited } from '../support/write-audit.js'
import { eventRows } from '../support/outbox.js'
import { cleanupGraphDirs, runGraphChild } from '../support/primitive-graph.js'
import { openRaw, type RawReader } from '../support/raw.js'

// `email.provider: 'mailgun'` passes the config's validation and createApp builds the email slot from
// @nymbalhq/email-mailgun, with the config block's signing key; without the package, startup fails naming it and
// its install line, as it does for smtp. The missing-package case runs createApp from the built dist in a child
// process (fixtures/primitive-graph). Needs `pnpm build`.

afterAll(cleanupGraphDirs)

/** The kernel config with email on Mailgun, parsed: the schema must accept the provider and its block. */
function withMailgun(config: NymbalConfig): NymbalConfig {
  return nymbalConfigSchema.parse({
    ...config,
    commerce: {
      ...config.commerce,
      email: {
        provider: 'mailgun',
        config: {
          from: 'store@mailgun.test',
          // Never reached here: nothing in these cases sends mail.
          smtp: {
            host: '127.0.0.1',
            port: 1,
            user: 'postmaster@mg.mailgun.test',
            pass: 'smtp-pass',
          },
          webhookSigningKey: MAILGUN_TEST_SIGNING_KEY,
        },
      },
    },
  })
}

describe('AC-4: the mailgun provider loads', () => {
  let served: ServedKernel | undefined
  let raw: RawReader | undefined
  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  /** The `mailgun.bounced.v1` rows in the store's event log, read through a second connection. */
  const bounces = async (reader: RawReader) =>
    (await eventRows(reader, 'type = ?', ['mailgun.bounced.v1'])).map(
      (row) => (row.envelope.payload as { recipient?: unknown }).recipient,
    )

  it("AC-4: email { provider: 'mailgun' } validates, createApp's email adapter is mailgun's, and it verifies posts to /api/webhooks/mailgun with the config block's key", async () => {
    const kernel = await createKernel({ dialect: 'sqlite', configure: withMailgun })
    served = await serveKernel(kernel)
    raw = openRaw(kernel.dialect, kernel.target)

    expect(kernel.config.commerce.email.provider).toBe('mailgun')
    expect(kernel.app.adapters.email.providerName).toBe(kernel.config.commerce.email.provider)

    const real = signedBody(permanentFailure('bounced@mailgun.test'))
    const signature = real.signature as MailgunSignature
    const forged = {
      ...real,
      signature: { ...signature, signature: changeOneCharacter(signature.signature, 5) },
    }

    const before = await bounces(raw)
    const refused = await postDelivery(served.baseUrl, 'mailgun', mailgunRequest(forged))
    const afterForged = await bounces(raw)
    const accepted = await postDelivery(served.baseUrl, 'mailgun', mailgunRequest(real))
    const afterReal = await bounces(raw)

    expect([refused.status, accepted.status]).toEqual([400, 200])
    expect(accepted.data).toEqual({ received: true, events: 1 })
    expect(afterForged).toEqual(before)
    expect(afterReal.length).toBe(before.length + 1)
    expect(afterReal.at(-1)).toBe('bounced@mailgun.test')
  }, 60_000)

  it('AC-4: with @nymbalhq/email-mailgun not installed, createApp fails adapter.package_missing, naming the email slot and "npm install @nymbalhq/email-mailgun nodemailer"', async () => {
    const { outcome } = await runGraphChild(withMailgun(kernelConfig('sqlite')))

    expect(outcome.started, JSON.stringify(outcome.started)).toBeUndefined()
    expect(outcome.error?.code, outcome.error?.message).toBe('adapter.package_missing')
    expect(outcome.error?.message).toContain('npm install @nymbalhq/email-mailgun nodemailer')
    expect(outcome.error?.message).toMatch(/\bemail\b/)
  }, 90_000)
})

// A recipient's server refusing the store's sender (5.7.x) through the live path: the route, Mailgun's own
// receiveWebhook and the feedback handler. Mailgun's adapter is the email slot, its sends captured instead of relayed.
describe("a recipient's server refusing the sender does not suppress the address", () => {
  const quiet: Logger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => quiet,
  }
  const sent: TransactionalEmail[] = []
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader

  beforeAll(async () => {
    const mailgun = createMailgunEmailAdapter({
      logger: quiet,
      config: {
        from: 'store@mailgun.test',
        smtp: { host: '127.0.0.1', port: 1, user: 'postmaster@mg.mailgun.test', pass: 'smtp-pass' },
        webhookSigningKey: MAILGUN_TEST_SIGNING_KEY,
      },
    })
    const email: EmailAdapter = {
      ...mailgun,
      healthCheck: async () => ({ status: 'healthy' }),
      sendTransactional: async (message) => {
        sent.push(message)
        return { messageId: `mg-${sent.length}`, accepted: true }
      },
    }
    k = await createKernel({
      dialect: 'sqlite',
      configure: customSlots('email'),
      appOptions: { adapters: { email } },
    })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  /** Every event in the log delivered or dead. */
  async function settled(): Promise<void> {
    await vi.waitFor(
      async () => {
        const open = (await eventRows(raw)).filter((r) => r.deliveredAt == null && r.deadAt == null)
        expect(open.map((r) => r.type)).toEqual([])
      },
      { timeout: 10_000, interval: 20 },
    )
  }

  /** An out-of-stock variant and a confirmed back-in-stock subscription to it for each of `emails`. */
  async function subscribed(emails: string[]): Promise<string> {
    const tag = randomUUID().slice(0, 8)
    const product = await k.services.product.create({
      slug: `policy-${tag}`,
      name: `Policy Widget ${tag}`,
      description: '',
      status: 'active',
      variants: [
        {
          sku: `POLICY-${tag}`,
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
    for (const email of emails) {
      await unaudited(() =>
        k.store.transaction(async (tx) => {
          const pending = await k.repos.alertSubscription.upsertPending(tx, {
            id: randomUUID(),
            email,
            kind: 'back_in_stock',
            variantId,
            productId: product.id,
            confirmToken: randomUUID(),
            unsubscribeToken: randomUUID(),
            origin: 'http://shop.test',
            baselinePriceMinor: null,
            at,
          })
          return k.repos.alertSubscription.update(
            tx,
            pending.id,
            { status: 'active', updatedAt: at, confirmedAt: at },
            ['pending'],
          )
        }),
      )
    }
    return variantId
  }

  const alertsTo = (email: string): number =>
    sent.filter((m) => m.to === email && m.template === 'alert-back-in-stock').length

  it("AC-7: a signed Mailgun policy rejection (5.7.1) for a confirmed subscriber writes no suppression row and the next restock mails them their alert, where a dead mailbox's permanent failure in the same store suppresses its address and mails it nothing", async () => {
    const refused = `refused-${randomUUID()}@policy.test`
    const gone = `gone-${randomUUID()}@policy.test`
    const variantId = await subscribed([refused, gone])

    const answers = [
      await postDelivery(served.baseUrl, 'mailgun', signedPost(policyRejection(refused))),
      await postDelivery(served.baseUrl, 'mailgun', signedPost(permanentFailure(gone))),
    ]
    expect(answers.map((a) => [a.status, a.data])).toEqual([
      [200, { received: true, events: 1 }],
      [200, { received: true, events: 1 }],
    ])
    await settled()
    const before = { refused: alertsTo(refused), gone: alertsTo(gone) }

    await k.services.inventory.adjustStock(variantId, 1, 'manual', 'policy-test')
    await settled()

    expect({
      suppressed: [
        await raw.count('email_suppressions', 'email = ?', [refused]),
        await raw.count('email_suppressions', 'email = ?', [gone]),
      ],
      mailed: [alertsTo(refused) - before.refused, alertsTo(gone) - before.gone],
    }).toEqual({ suppressed: [0, 1], mailed: [1, 0] })
  }, 60_000)
})
