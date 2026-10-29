import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HealthReport, Logger } from '@nymbalhq/types'
import { RESEND_TEST_SECRET } from '../../../tests/support/resend'
import { fakeSmtpServer, type FakeSmtpServer } from '../../../tests/support/smtp-server'
import { closedPort } from '../../../tests/support/tcp-proxy'
import { createResendEmailAdapter, type ResendEmailAdapterConfig } from './index.js'

// The slot's health. Without the webhook secret such a store refuses every Resend post; without the API key (the SMTP
// password) Resend refuses every send: each is degraded, naming the field. The relay is an SMTP server in this
// process, or a port nobody listens on. No case gives `smtp.user`: Resend's is always `resend`, the default.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const SECRET_NAMED = /webhookSecret/
const PASS_NAMED = /smtp\.pass/

let smtp: FakeSmtpServer | undefined
let deadPort = 0

beforeAll(async () => {
  smtp = await fakeSmtpServer()
  deadPort = await closedPort()
})

afterAll(async () => {
  await smtp?.close()
})

function health(port: number, fields: { pass?: string; secret?: string }): Promise<HealthReport> {
  const config = {
    from: 'store@resend.test',
    smtp: {
      host: '127.0.0.1',
      port,
      secure: false,
      ...(fields.pass !== undefined && { pass: fields.pass }),
    },
    ...(fields.secret !== undefined && { webhookSecret: fields.secret }),
  }
  return createResendEmailAdapter({
    logger,
    config: config as ResendEmailAdapterConfig,
  }).healthCheck()
}

const FULL = { pass: 're_test_api_key', secret: RESEND_TEST_SECRET }

describe('AC-5: health names what the store cannot do', () => {
  it('AC-5: on a live relay, the full config is healthy, no webhookSecret is degraded naming it, and no smtp.pass is degraded naming it', async () => {
    const full = await health(smtp!.port, FULL)
    const before = smtp!.connections()
    const noSecret = await health(smtp!.port, { pass: FULL.pass })
    const noPass = await health(smtp!.port, { secret: FULL.secret })

    expect([full.status, noSecret.status, noPass.status]).toEqual([
      'healthy',
      'degraded',
      'degraded',
    ])
    expect(full.detail ?? '').not.toMatch(SECRET_NAMED)
    expect(full.detail ?? '').not.toMatch(PASS_NAMED)
    expect(noSecret.detail ?? '').toMatch(SECRET_NAMED)
    expect(noSecret.detail ?? '').not.toMatch(PASS_NAMED)
    expect(noPass.detail ?? '').toMatch(PASS_NAMED)
    expect(noPass.detail ?? '').not.toMatch(SECRET_NAMED)
    expect(
      smtp!.connections(),
      'the health check without a secret verified no SMTP relay',
    ).toBeGreaterThan(before)
  }, 30_000)

  it('AC-5: on an unreachable relay the SMTP status wins: the full config and the one without a webhookSecret are both down', async () => {
    const full = await health(deadPort, FULL)
    const noSecret = await health(deadPort, { pass: FULL.pass })
    const live = await health(smtp!.port, { pass: FULL.pass })

    expect([full.status, noSecret.status, live.status]).toEqual(['down', 'down', 'degraded'])
    expect(noSecret.detail ?? '').toMatch(SECRET_NAMED)
  }, 30_000)

  it('AC-5: a webhookSecret that decodes to no key is degraded naming webhookSecret, as no webhookSecret is', async () => {
    const reports = await Promise.all(
      ['whsec_', '!!!!', 'whsec_===='].map((secret) =>
        health(smtp!.port, { pass: FULL.pass, secret }),
      ),
    )
    const full = await health(smtp!.port, FULL)

    expect([...reports.map((r) => r.status), full.status]).toEqual([
      'degraded',
      'degraded',
      'degraded',
      'healthy',
    ])
    for (const r of reports) {
      expect(r.detail ?? '').toMatch(SECRET_NAMED)
      expect(r.detail ?? '').not.toMatch(PASS_NAMED)
    }
  }, 30_000)
})
