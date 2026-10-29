import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import {
  certificateAnswer,
  changeOneCharacter,
  notification,
  SES_TEST_CERT_URL,
  SES_TEST_REGION,
  SES_TEST_TOPIC,
  sesBounce,
  signSns,
  snsRequest,
  urlOf,
} from '../../../../tests/support/ses.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { postDelivery } from '../support/inbound-webhooks.js'
import { createKernel } from '../support/kernel.js'
import { eventRows } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'

// `email.provider: 'ses'` passes the config's validation and createApp builds the email slot from
// @nymbalhq/email-ses, on the config block's topic. A signed permanent bounce, posted to /api/webhooks/ses as SNS
// posts it (text/plain), ends as the address's suppression row. The adapter's default certificate fetch resolves
// `globalThis.fetch` when it runs, so `fetch` is stubbed after the kernel is built: the certificate URL answers the test
// certificate, and every other URL (the test's own posts to the kernel) goes to the real fetch. Needs `pnpm build`.

/** The kernel config with email on SES, parsed: the schema must accept the provider and its block. */
function withSes(config: NymbalConfig): NymbalConfig {
  return nymbalConfigSchema.parse({
    ...config,
    commerce: {
      ...config.commerce,
      email: {
        provider: 'ses',
        config: {
          from: 'store@ses.test',
          region: SES_TEST_REGION,
          // Never reached here: nothing in these cases sends mail.
          smtp: { host: '127.0.0.1', port: 1, user: 'AKIASESTESTUSER', pass: 'ses-smtp-password' },
          topicArn: SES_TEST_TOPIC,
        },
      },
    },
  })
}

const SUPPRESSIONS = 'email_suppressions'

describe('AC-5: the ses provider loads and its webhook suppresses', () => {
  let served: ServedKernel | undefined
  let raw: RawReader | undefined
  afterAll(async () => {
    vi.unstubAllGlobals()
    await raw?.close()
    await served?.stop()
  })

  it("AC-5: email { provider: 'ses' } validates, createApp's email adapter is ses's, and a signed text/plain permanent bounce to /api/webhooks/ses writes the address's hard_bounce suppression row, where a forged one writes none, with one certificate fetch", async () => {
    const kernel = await createKernel({ dialect: 'sqlite', configure: withSes })
    served = await serveKernel(kernel)
    raw = openRaw(kernel.dialect, kernel.target)

    expect(kernel.config.commerce.email.provider).toBe('ses')
    expect(kernel.app.adapters.email.providerName).toBe(kernel.config.commerce.email.provider)

    const realFetch = globalThis.fetch
    const certificateFetches: string[] = []
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input)
      if (url !== SES_TEST_CERT_URL) return realFetch(input, init)
      certificateFetches.push(url)
      return Promise.resolve(certificateAnswer())
    })

    const real = `bounced-${randomUUID()}@ses.test`
    const forgedTo = `forged-${randomUUID()}@ses.test`
    const genuine = snsRequest(signSns(notification(sesBounce([real], 'Permanent'))))
    const signedForged = signSns(notification(sesBounce([forgedTo], 'Permanent')))
    const forged = snsRequest({
      ...signedForged,
      Message: changeOneCharacter(signedForged.Message, signedForged.Message.indexOf('forged-')),
    })
    const rowsFor = (email: string) => raw!.count(SUPPRESSIONS, 'email = ?', [email])
    const before = [await rowsFor(real), await rowsFor(forgedTo)]

    const refused = await postDelivery(served.baseUrl, 'ses', forged)
    const accepted = await postDelivery(served.baseUrl, 'ses', genuine)

    expect(genuine.headers['content-type']).toMatch(/^text\/plain/)
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
    const bounces = (await eventRows(raw, 'type = ?', ['ses.bounced.v1'])).map(
      (r) => (r.envelope.payload as { recipient?: unknown }).recipient,
    )

    expect(row.reason).toBe('hard_bounce')
    expect(await rowsFor(forgedTo)).toBe(before[1])
    expect(bounces).toEqual([real])
    expect(certificateFetches).toEqual([SES_TEST_CERT_URL])
  }, 60_000)
})
