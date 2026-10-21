import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runEmailContract } from '@nymbalhq/contract-tests'
import { createLogger } from '@nymbalhq/platform'
import type { EmailAdapter } from '@nymbalhq/types'
import { createSmtpEmailAdapter } from '../../packages/adapter-smtp/src/index.js'
import { fakeSmtpServer, type FakeSmtpServer } from '../support/smtp-server'
import { closedPort, settleWithin } from '../support/tcp-proxy'

// P2-13 AC-5 (spec P2-13-contract-tests-public) on @nymbalhq/adapter-smtp, a bundled adapter with an external
// dependency: the published email suite runs against an SMTP server in this process (healthy when up), and, given
// `unreachable` (the adapter pointed at a port nobody listens on), its downtime cases. The case below holds the
// adapter itself to the bound: on a dead host healthCheck says `down`, not `degraded`, within 6 s, and a send rejects
// within 6 s. Kills: smtp-adapter.ts's healthCheck reporting a refused connection as `degraded` (a check that passes
// on a dead dependency), and a send that waits out nodemailer's two-minute connection timeout.

const DOWN_WITHIN_MS = 6000
const HUNG_AFTER_MS = 12_000
const logger = createLogger({ pretty: false, level: 'error' })

let smtp: FakeSmtpServer | undefined
let deadPort = 0

beforeAll(async () => {
  smtp = await fakeSmtpServer()
  deadPort = await closedPort()
})

afterAll(async () => {
  await smtp?.close()
})

function on(port: number): EmailAdapter {
  return createSmtpEmailAdapter({
    logger,
    config: { from: 'shop@p2-13.test', smtp: { host: '127.0.0.1', port, secure: false } },
  })
}

runEmailContract('smtp', () => on(smtp!.port), { unreachable: () => on(deadPort) })

describe('P2-13 AC-5: adapter-smtp on a dead host', () => {
  it('AC-5: on a port nobody listens on, healthCheck reports down within 6 s and sendTransactional rejects within 6 s, where the live server takes the same send', async () => {
    const dead = on(deadPort)
    const live = on(smtp!.port)
    const mail = {
      template: 'order-confirmation',
      to: 'buyer@p2-13.test',
      vars: { orderNumber: 'P2-13' },
    }

    const health = await settleWithin(dead.healthCheck(), HUNG_AFTER_MS)
    const send = await settleWithin(dead.sendTransactional(mail), HUNG_AFTER_MS)
    const delivered = smtp!.messages.length
    await live.sendTransactional(mail)

    expect([health.state, (health.value as { status?: string } | undefined)?.status]).toEqual([
      'resolved',
      'down',
    ])
    expect(health.ms).toBeLessThan(DOWN_WITHIN_MS)
    expect(send.state).toBe('rejected')
    expect(send.ms).toBeLessThan(DOWN_WITHIN_MS)
    expect(smtp!.messages.length).toBe(delivered + 1)
  }, 30_000)
})
