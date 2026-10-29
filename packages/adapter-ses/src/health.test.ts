import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HealthReport, Logger } from '@nymbalhq/types'
import { SES_TEST_REGION, SES_TEST_TOPIC } from '../../../tests/support/ses'
import { fakeSmtpServer, type FakeSmtpServer } from '../../../tests/support/smtp-server'
import { closedPort } from '../../../tests/support/tcp-proxy'
import { createSesEmailAdapter, type SesEmailAdapterConfig } from './index.js'

// The slot's health. Without the SMTP credentials SES refuses every send; without topicArn the store refuses every SNS
// post: each is degraded, naming the field. The relay is an SMTP server in this process, or a port nobody listens on.

const logger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
}

const USER_NAMED = /smtp\.user/
const PASS_NAMED = /smtp\.pass/
const TOPIC_NAMED = /topicArn/

let smtp: FakeSmtpServer | undefined
let deadPort = 0

beforeAll(async () => {
  smtp = await fakeSmtpServer()
  deadPort = await closedPort()
})

afterAll(async () => {
  await smtp?.close()
})

interface Fields {
  user?: string
  pass?: string
  topicArn?: string
}

function health(port: number, fields: Fields): Promise<HealthReport> {
  const config = {
    from: 'store@ses.test',
    region: SES_TEST_REGION,
    smtp: {
      host: '127.0.0.1',
      port,
      secure: false,
      ...(fields.user !== undefined && { user: fields.user }),
      ...(fields.pass !== undefined && { pass: fields.pass }),
    },
    ...(fields.topicArn !== undefined && { topicArn: fields.topicArn }),
  }
  return createSesEmailAdapter({
    logger,
    config: config as SesEmailAdapterConfig,
  }).healthCheck()
}

const FULL: Fields = {
  user: 'AKIASESTESTUSER',
  pass: 'ses-smtp-password',
  topicArn: SES_TEST_TOPIC,
}
const without = (name: keyof Fields): Fields => {
  const { [name]: _dropped, ...rest } = FULL
  return rest
}

/** Which of the three fields `report`'s detail names. */
const named = (report: HealthReport): string[] =>
  [
    ['smtp.user', USER_NAMED],
    ['smtp.pass', PASS_NAMED],
    ['topicArn', TOPIC_NAMED],
  ]
    .filter(([, pattern]) => (pattern as RegExp).test(report.detail ?? ''))
    .map(([name]) => name as string)

describe('AC-6: health names what the store cannot do', () => {
  it('AC-6: on a live relay the full config is healthy, and each missing credential or topicArn is degraded naming exactly what is missing', async () => {
    const full = await health(smtp!.port, FULL)
    const credentials = await Promise.all(
      [without('user'), without('pass'), { topicArn: SES_TEST_TOPIC }].map((fields) =>
        health(smtp!.port, fields),
      ),
    )
    const before = smtp!.connections()
    const topics = [
      await health(smtp!.port, without('topicArn')),
      await health(smtp!.port, { ...FULL, topicArn: '' }),
    ]
    const reports = [...credentials, ...topics]

    expect([full.status, ...reports.map((r) => r.status)]).toEqual([
      'healthy',
      'degraded',
      'degraded',
      'degraded',
      'degraded',
      'degraded',
    ])
    expect([full, ...reports].map(named)).toEqual([
      [],
      ['smtp.user'],
      ['smtp.pass'],
      ['smtp.user', 'smtp.pass'],
      ['topicArn'],
      ['topicArn'],
    ])
    expect(
      smtp!.connections() - before,
      'a health check without topicArn verified no SMTP relay',
    ).toBeGreaterThanOrEqual(topics.length)
  }, 30_000)

  it('AC-6: on an unreachable relay the SMTP status wins: the full config and the one without topicArn are both down, and the latter still names topicArn', async () => {
    const full = await health(deadPort, FULL)
    const noTopic = await health(deadPort, without('topicArn'))
    const live = await health(smtp!.port, without('topicArn'))

    expect([full.status, noTopic.status, live.status]).toEqual(['down', 'down', 'degraded'])
    expect([named(full), named(noTopic)]).toEqual([[], ['topicArn']])
  }, 30_000)
})
