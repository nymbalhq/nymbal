import { afterAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import {
  changeOneCharacter,
  MAILGUN_TEST_SIGNING_KEY,
  mailgunRequest,
  permanentFailure,
  signedBody,
  type MailgunSignature,
} from '../../../../tests/support/mailgun.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { postDelivery } from '../support/inbound-webhooks.js'
import { createKernel, kernelConfig } from '../support/kernel.js'
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
    const { outcome } = await runGraphChild(withMailgun(kernelConfig('sqlite')), {
      hide: ['@nymbalhq/email-mailgun'],
    })

    expect(outcome.started, JSON.stringify(outcome.started)).toBeUndefined()
    expect(outcome.error?.code, outcome.error?.message).toBe('adapter.package_missing')
    expect(outcome.error?.message).toContain('npm install @nymbalhq/email-mailgun nodemailer')
    expect(outcome.error?.message).toMatch(/\bemail\b/)
  }, 90_000)
})
