import { createServer, type Server, type Socket } from 'node:net'
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
// on a dead dependency), and a send that waits out nodemailer's two-minute connection timeout or its 30 s greeting
// timeout on a host that accepts and never answers.

const DOWN_WITHIN_MS = 6000
const HUNG_AFTER_MS = 12_000
const logger = createLogger({ pretty: false, level: 'error' })

let smtp: FakeSmtpServer | undefined
let deadPort = 0
// A host that takes the connection and never greets: what a refused port cannot show, a send that waits on a reply.
let silent: Server | undefined
const silentSockets = new Set<Socket>()
let silentAccepted = 0

beforeAll(async () => {
  smtp = await fakeSmtpServer()
  deadPort = await closedPort()
  silent = createServer((socket) => {
    silentAccepted += 1
    silentSockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => silentSockets.delete(socket))
  })
  await new Promise<void>((resolve) => silent!.listen(0, '127.0.0.1', () => resolve()))
})

afterAll(async () => {
  await smtp?.close()
  for (const socket of silentSockets) socket.destroy()
  await new Promise<void>((resolve) => (silent ? silent.close(() => resolve()) : resolve()))
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

  it('AC-5: on a host that accepts the connection and never greets, sendTransactional rejects within 6 s', async () => {
    const port = (silent!.address() as { port: number }).port
    const accepted = silentAccepted
    const send = await settleWithin(
      on(port).sendTransactional({
        template: 'order-confirmation',
        to: 'buyer@p2-13.test',
        vars: { orderNumber: 'P2-13' },
      }),
      HUNG_AFTER_MS,
    )

    // The send reached the host: it was refused nothing, it waited on a greeting that never came.
    expect(silentAccepted).toBeGreaterThan(accepted)
    expect(send.state).toBe('rejected')
    expect(send.ms).toBeLessThan(DOWN_WITHIN_MS)
  }, 30_000)
})
