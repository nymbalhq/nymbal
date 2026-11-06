import { afterAll, beforeAll } from 'vitest'
import { runEmailContract } from '@nymbalhq/contract-tests'
import { createLogger } from '@nymbalhq/platform'
import type { EmailAdapter } from '@nymbalhq/types'
import { createResendEmailAdapter } from '../../packages/adapters/email/resend/src/index.js'
import { fakeSmtpServer, type FakeSmtpServer } from '../support/smtp-server'
import { closedPort } from '../support/tcp-proxy'

// The email suite on @nymbalhq/email-resend, which sends through Resend's SMTP relay: here an SMTP server in this
// process stands in for the relay (healthy when up), and a port nobody listens on for the relay down.

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
  return createResendEmailAdapter({
    logger,
    config: {
      from: 'shop@contracts.test',
      smtp: { host: '127.0.0.1', port, pass: 're_contracts_key', secure: false },
      webhookSecret: 'whsec_Y29udHJhY3RzLXNlY3JldA==',
    },
  })
}

runEmailContract('resend', () => on(smtp!.port), { unreachable: () => on(deadPort) })
