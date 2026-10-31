import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createAdapter } from '@nymbalhq/email-smtp'
import { createMailSink } from '@nymbalhq/proof-kit/mail'
import { createLogger } from '@nymbalhq/platform'
import type { EmailAdapter } from '@nymbalhq/types'

// AC-10: the `smtp` email adapter (@nymbalhq/email-smtp, loaded through its createAdapter as the kernel loads it),
// configured with the sink's emailConfig(), really delivers to Mailpit, and waitFor fails loudly (address and counts)
// instead of hanging or resolving short.
// The file refuses to load without NYMBAL_TEST_MAILPIT_URL, so a missing Mailpit fails the project.

const URL_VAR = 'NYMBAL_TEST_MAILPIT_URL'
const mailpitUrl = process.env[URL_VAR]
if (mailpitUrl === undefined || mailpitUrl.trim() === '') {
  throw new Error(
    `${URL_VAR} is not set: the proof-kit-services project needs Mailpit ` +
      `(pnpm gate:full starts one with docker compose; e.g. ${URL_VAR}=http://localhost:18025)`,
  )
}

const logger = createLogger({ pretty: false, level: 'error' })

function smtpAdapter(sink: ReturnType<typeof createMailSink>): EmailAdapter {
  return createAdapter({
    slot: 'email',
    config: sink.emailConfig(),
    logger,
    env: process.env,
  }) as EmailAdapter
}

describe('AC-10: the mail sink receives what the smtp email adapter sends', () => {
  it('AC-10: one sendTransactional to a unique address yields exactly one message for it, with the sent subject', async () => {
    const sink = createMailSink()
    const email = smtpAdapter(sink)
    const to = `ac10-${randomUUID()}@proof-kit.test`
    const orderNumber = `PK-${randomUUID()}`

    await email.sendTransactional({
      template: 'order-placed',
      to,
      vars: { orderNumber, customerName: 'Ada', totalFormatted: '12.50 GBP' },
    })
    const received = await sink.waitFor({ to }, { timeoutMs: 10_000 })

    expect(received).toHaveLength(1)
    expect(received[0]!.to).toContain(to)
    expect(received[0]!.subject).toContain(orderNumber)
    expect(await sink.messages({ to })).toHaveLength(received.length)
  }, 20_000)

  it('AC-10: waitFor({ to, count: 2 }) after one message times out with an error naming the address and the counts seen', async () => {
    const sink = createMailSink()
    const email = smtpAdapter(sink)
    const to = `ac10-short-${randomUUID()}@proof-kit.test`
    await email.sendTransactional({
      template: 'order-placed',
      to,
      vars: { orderNumber: 'PK-1', customerName: 'Ada', totalFormatted: '1 GBP' },
    })
    await sink.waitFor({ to }, { timeoutMs: 10_000 })

    const timeoutMs = 750
    const started = performance.now()
    const outcome = await sink.waitFor({ to, count: 2 }, { timeoutMs }).then(
      (messages) => ({ resolved: messages.length }),
      (error: unknown) => ({ error }),
    )
    const elapsed = performance.now() - started

    expect(outcome).toHaveProperty('error')
    const message = String((outcome as { error: unknown }).error)
    expect(message).toContain(to)
    const counts = message.replaceAll(to, '')
    expect(counts).toMatch(/\b1\b/)
    expect(counts).toMatch(/\b2\b/)
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50)
  }, 20_000)
})
