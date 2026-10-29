import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import {
  bounced,
  changeOneCharacter,
  RESEND_TEST_SECRET,
  signedPost,
} from '../../../../tests/support/resend.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { postDelivery } from '../support/inbound-webhooks.js'
import { createKernel, kernelConfig } from '../support/kernel.js'
import { eventRows } from '../support/outbox.js'
import { cleanupGraphDirs, runGraphChild } from '../support/primitive-graph.js'
import { openRaw, type RawReader } from '../support/raw.js'

// `email.provider: 'resend'` passes the config's validation and createApp builds the email slot from
// @nymbalhq/email-resend, with the config block's webhook secret; a signed permanent bounce posted to
// /api/webhooks/resend ends as the address's suppression row. Without the package, startup fails naming it and its
// install line. The missing-package case runs createApp from the built dist in a child process
// (fixtures/primitive-graph). Needs `pnpm build`.

afterAll(cleanupGraphDirs)

/** The kernel config with email on Resend, parsed: the schema must accept the provider and its block. */
function withResend(config: NymbalConfig): NymbalConfig {
  return nymbalConfigSchema.parse({
    ...config,
    commerce: {
      ...config.commerce,
      email: {
        provider: 'resend',
        config: {
          from: 'store@resend.test',
          // Never reached here: nothing in these cases sends mail.
          smtp: { host: '127.0.0.1', port: 1, pass: 're_test_api_key' },
          webhookSecret: RESEND_TEST_SECRET,
        },
      },
    },
  })
}

const SUPPRESSIONS = 'email_suppressions'

describe('AC-4: the resend provider loads and its webhook suppresses', () => {
  let served: ServedKernel | undefined
  let raw: RawReader | undefined
  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  it("AC-4: email { provider: 'resend' } validates, createApp's email adapter is resend's, and a signed permanent bounce to /api/webhooks/resend writes the address's hard_bounce suppression row, where a forged one writes none", async () => {
    const kernel = await createKernel({ dialect: 'sqlite', configure: withResend })
    served = await serveKernel(kernel)
    raw = openRaw(kernel.dialect, kernel.target)

    expect(kernel.config.commerce.email.provider).toBe('resend')
    expect(kernel.app.adapters.email.providerName).toBe(kernel.config.commerce.email.provider)

    const real = `bounced-${randomUUID()}@resend.test`
    const forgedTo = `forged-${randomUUID()}@resend.test`
    const genuine = signedPost(bounced([real], 'Permanent'))
    const forgedPost = signedPost(bounced([forgedTo], 'Permanent'))
    const forged = {
      ...forgedPost,
      headers: {
        ...forgedPost.headers,
        'svix-signature': changeOneCharacter(forgedPost.headers['svix-signature']!, 5),
      },
    }
    const rowsFor = (email: string) => raw!.count(SUPPRESSIONS, 'email = ?', [email])
    const before = [await rowsFor(real), await rowsFor(forgedTo)]

    const refused = await postDelivery(served.baseUrl, 'resend', forged)
    const accepted = await postDelivery(served.baseUrl, 'resend', genuine)

    expect([refused.status, accepted.status], JSON.stringify(accepted.body)).toEqual([400, 200])
    expect(accepted.data).toEqual({ received: true, events: 1 })
    await vi.waitFor(async () => expect(await rowsFor(real)).toBe(before[0]! + 1), {
      timeout: 10_000,
      interval: 20,
    })
    const row = await raw.one<{ reason: string }>(
      `SELECT reason FROM ${SUPPRESSIONS} WHERE email = ?`,
      [real],
    )
    const bounces = (await eventRows(raw, 'type = ?', ['resend.bounced.v1'])).map(
      (r) => (r.envelope.payload as { recipient?: unknown }).recipient,
    )

    expect(row.reason).toBe('hard_bounce')
    expect(await rowsFor(forgedTo)).toBe(before[1])
    expect(bounces).toEqual([real])
  }, 60_000)

  it('AC-4: with @nymbalhq/email-resend not installed, createApp fails adapter.package_missing, naming the email slot and "npm install @nymbalhq/email-resend nodemailer"', async () => {
    const { outcome } = await runGraphChild(withResend(kernelConfig('sqlite')), {
      hide: ['@nymbalhq/email-resend'],
    })

    expect(outcome.started, JSON.stringify(outcome.started)).toBeUndefined()
    expect(outcome.error?.code, outcome.error?.message).toBe('adapter.package_missing')
    expect(outcome.error?.message).toContain('npm install @nymbalhq/email-resend nodemailer')
    expect(outcome.error?.message).toMatch(/\bemail\b/)
  }, 90_000)
})
