import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HealthReport, Logger } from '@nymbalhq/types'
import { MAILGUN_TEST_SIGNING_KEY } from '../../../../../tests/support/mailgun'
import { fakeSmtpServer, type FakeSmtpServer } from '../../../../../tests/support/smtp-server'
import { closedPort } from '../../../../../tests/support/tcp-proxy'
import { createMailgunEmailAdapter, type MailgunEmailAdapterConfig } from './index.js'

// The slot's health without a webhook signing key: such a store would answer every Mailgun post 400, so health says so
// (degraded, naming the key) while still checking the SMTP relay; an unreachable relay is down, and the detail then
// names both. The relay is an SMTP server in this process, or a port nobody listens on.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const KEY_NAMED = /webhook signing key/i
const SMTP_NAMED = /\bSMTP\b/i

let smtp: FakeSmtpServer | undefined
let deadPort = 0

beforeAll(async () => {
  smtp = await fakeSmtpServer()
  deadPort = await closedPort()
})

afterAll(async () => {
  await smtp?.close()
})

function health(port: number, key: string | undefined): Promise<HealthReport> {
  const config = {
    from: 'store@mailgun.test',
    smtp: {
      host: '127.0.0.1',
      port,
      user: 'postmaster@mg.mailgun.test',
      pass: 'smtp-pass',
      secure: false,
    },
    ...(key !== undefined && { webhookSigningKey: key }),
  }
  return createMailgunEmailAdapter({
    logger,
    config: config as MailgunEmailAdapterConfig,
  }).healthCheck()
}

describe('AC-5: health without a webhook signing key', () => {
  it('AC-5: on a live relay, no key makes the slot degraded naming the key, where the key makes it healthy, and the SMTP verify still connects', async () => {
    const withKey = await health(smtp!.port, MAILGUN_TEST_SIGNING_KEY)
    const before = smtp!.connections()
    const withoutKey = await health(smtp!.port, undefined)

    expect([withKey.status, withoutKey.status]).toEqual(['healthy', 'degraded'])
    expect(withoutKey.detail ?? '').toMatch(KEY_NAMED)
    expect(withKey.detail ?? '').not.toMatch(KEY_NAMED)
    expect(
      smtp!.connections(),
      'the health check without a key verified no SMTP login',
    ).toBeGreaterThan(before)
  }, 30_000)

  it('AC-5: on an unreachable relay, no key is down and the detail names both the key and SMTP, where with the key the detail names SMTP alone', async () => {
    const withKey = await health(deadPort, MAILGUN_TEST_SIGNING_KEY)
    const withoutKey = await health(deadPort, undefined)

    expect([withKey.status, withoutKey.status]).toEqual(['down', 'down'])
    expect(withoutKey.detail ?? '').toMatch(KEY_NAMED)
    expect(withoutKey.detail ?? '').toMatch(SMTP_NAMED)
    expect(withKey.detail ?? '').toMatch(SMTP_NAMED)
    expect(withKey.detail ?? '').not.toMatch(KEY_NAMED)
  }, 30_000)
})

// Without both halves of the SMTP login nodemailer builds a transport with no auth, whose verify() passes on any relay
// that answers; Mailgun then refuses every send, so health and send name the missing field instead.
describe('an incomplete SMTP login', () => {
  function adapter(login: { user?: string; pass?: string }) {
    return createMailgunEmailAdapter({
      logger,
      config: {
        from: 'store@mailgun.test',
        smtp: { host: '127.0.0.1', port: smtp!.port, secure: false, ...login },
        webhookSigningKey: MAILGUN_TEST_SIGNING_KEY,
      },
    })
  }

  it('on a live relay, a missing user or password makes the slot degraded naming that field, where the full login is healthy', async () => {
    const full = await adapter({
      user: 'postmaster@mg.mailgun.test',
      pass: 'smtp-pass',
    }).healthCheck()
    const noUser = await adapter({ pass: 'smtp-pass' }).healthCheck()
    const emptyPass = await adapter({ user: 'postmaster@mg.mailgun.test', pass: '' }).healthCheck()

    expect([full.status, noUser.status, emptyPass.status]).toEqual([
      'healthy',
      'degraded',
      'degraded',
    ])
    expect(full.detail ?? '').not.toMatch(/smtp\.(user|pass)/)
    expect(noUser.detail ?? '').toMatch(/smtp\.user/)
    expect(noUser.detail ?? '').not.toMatch(/smtp\.pass/)
    expect(emptyPass.detail ?? '').toMatch(/smtp\.pass/)
    expect(emptyPass.detail ?? '').not.toMatch(/smtp\.user/)
  }, 30_000)

  it('a send without the user is refused with an adapter error naming it, and reaches no relay', async () => {
    const sent = smtp!.messages.length
    const send = adapter({ pass: 'smtp-pass' }).sendTransactional({
      to: 'shopper@example.test',
      template: 'order-placed',
      vars: {},
    })

    await expect(send).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'adapter.email.misconfigured',
      message: expect.stringMatching(/smtp\.user/),
    })
    expect(smtp!.messages.length).toBe(sent)
  }, 30_000)
})
