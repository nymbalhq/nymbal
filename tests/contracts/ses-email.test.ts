import { afterAll, beforeAll } from 'vitest'
import { runEmailContract } from '@nymbalhq/contract-tests'
import { createLogger } from '@nymbalhq/platform'
import type { EmailAdapter } from '@nymbalhq/types'
import { createSesEmailAdapter } from '../../packages/adapters/email/ses/src/index.js'
import { fakeSmtpServer, type FakeSmtpServer } from '../support/smtp-server'
import { closedPort } from '../support/tcp-proxy'

// The email suite on @nymbalhq/email-ses, which sends through SES's SMTP endpoint: here an SMTP server in this
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
  return createSesEmailAdapter({
    logger,
    config: {
      from: 'shop@contracts.test',
      smtp: {
        host: '127.0.0.1',
        port,
        user: 'AKIACONTRACTS',
        pass: 'contracts-pass',
        secure: false,
      },
      region: 'eu-west-1',
      topicArn: 'arn:aws:sns:eu-west-1:123456789012:contracts',
    },
  })
}

runEmailContract('ses', () => on(smtp!.port), { unreachable: () => on(deadPort) })
