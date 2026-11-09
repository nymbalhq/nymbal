import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdapterError, Logger } from '@nymbalhq/types'
import { createAnthropicAiAdapter } from '../../packages/adapters/ai/anthropic/src/anthropic-adapter.js'
import { MESSAGE_CAP } from '../../packages/adapters/ai/anthropic/src/chat.js'

// What a merchant reads when Anthropic refuses a request: the provider's own error type and message from its JSON
// body (the real shapes below), capped, with no key in it, and billing and overload told apart from a bad request.

const KEY = 'sk-ant-api03-TestKey_0123456789abcdefghij'
const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger

const body = (type: string, message: string) =>
  JSON.stringify({ type: 'error', error: { type, message } })

function answering(status: number, text: string): void {
  vi.stubGlobal('fetch', async () => new Response(text, { status }))
}

// Headers arrive and the body never ends; like fetch, an abort of the request's signal errors the body's read.
function stalling(status: number): void {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const signal = init.signal!
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":'))
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
      },
    })
    return new Response(stream, { status })
  })
}

async function failure(apiKey = KEY, content = 'Say hello.'): Promise<AdapterError> {
  const adapter = createAnthropicAiAdapter({ apiKey, logger })
  try {
    await adapter.chat([{ role: 'user', content }])
  } catch (error) {
    return error as AdapterError
  }
  throw new Error('chat() resolved')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('an Anthropic error body', () => {
  // Kills: the body left unread, so a spent credit balance reads "anthropic answered 400" as a bad request.
  it('a 400 saying the credit balance is too low is adapter.quota_exceeded with the provider message after the status', async () => {
    const said =
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'
    answering(400, body('invalid_request_error', said))
    const error = await failure()
    expect(error.code).toBe('adapter.quota_exceeded')
    expect(error.message).toBe(`anthropic answered 400: ${said}`)
    expect(error.context).toEqual({ provider: 'anthropic', status: 400 })
  })

  // Kills: the error type ignored, so a 402 billing_error is a bad request and a 529 is the generic unavailable.
  it('billing_error is adapter.quota_exceeded, 529 overloaded_error is adapter.overloaded, and a plain 400 stays adapter.invalid_request', async () => {
    const cases = [
      [402, 'billing_error', 'Your account has a billing problem.', 'adapter.quota_exceeded'],
      [529, 'overloaded_error', 'Overloaded', 'adapter.overloaded'],
      [400, 'invalid_request_error', 'max_tokens: must be at most 8192', 'adapter.invalid_request'],
      [
        429,
        'rate_limit_error',
        'Number of request tokens has exceeded your per-minute rate limit',
        'adapter.rate_limited',
      ],
    ] as const
    const seen: string[][] = []
    for (const [status, type, said] of cases) {
      answering(status, body(type, said))
      const error = await failure()
      seen.push([error.code, error.message])
    }
    expect(seen).toEqual(
      cases.map(([status, , said, code]) => [code, `anthropic answered ${status}: ${said}`]),
    )
  })

  // Kills: the message passed on as the provider wrote it, the configured key (raw, base64 with or without its
  // padding, base64url) or another sk-ant- key in it; or the message dropped whole, losing what the merchant needs.
  // The example: the configured key taken out of a longer key it begins, leaving that key's tail ("[redacted]__aaaa").
  // The glued key: an sk-ant- key straight after the key's base64url form, with no word boundary before it.
  it('property: a message echoing the configured key in any form, or any sk- key, keeps its words and loses the keys', async () => {
    const keyArb = fc.stringMatching(/^[A-Za-z0-9_-]{16,48}$/)
    await fc.assert(
      fc.asyncProperty(keyArb, keyArb, async (raw, other) => {
        const key = `sk-ant-${raw}`
        const bytes = Buffer.from(key, 'utf8')
        const forms = [
          key,
          bytes.toString('base64'),
          bytes.toString('base64').replace(/=+$/, ''),
          bytes.toString('base64url'),
        ]
        answering(
          401,
          body(
            'authentication_error',
            `invalid x-api-key ${forms[0]} (${forms[1]}, ${forms[2]}, ${forms[3]}); not sk-ant-${other} either; nor ${forms[3]}sk-ant-${other}`,
          ),
        )
        const error = await failure(key)
        expect(error.code).toBe('adapter.auth_failed')
        expect(error.message).toBe(
          'anthropic answered 401: invalid x-api-key [redacted] ([redacted], [redacted], [redacted]); not [redacted] either; nor [redacted]',
        )
        expect(forms.filter((form) => JSON.stringify(error).includes(form))).toEqual([])
      }),
      { numRuns: 40, examples: [['__lookupSetter__', '__lookupSetter____aaaa']] },
    )
  })

  // Kills: key-shaped tokens taken out before the conversation's texts, so a text holding an sk- key no longer
  // matches whole and the rest of what the shopper wrote reaches the merchant's error.
  it('a message echoing a conversation text that holds an sk- key loses the whole text', async () => {
    const said = 'Please check sk-ant-old_0123456789abcdef for the order to 12 Elm Street.'
    answering(400, body('invalid_request_error', `messages.0.content: ${said} was refused`))
    const error = await failure(KEY, said)
    expect(error.message).toBe('anthropic answered 400: messages.0.content: [redacted] was refused')
  })

  // Kills: an uncapped message, so a provider's page-long text fills the merchant's error line.
  it(`a long message is cut to ${MESSAGE_CAP} characters, ending in an ellipsis`, async () => {
    const said = `Request refused. ${'This sentence repeats. '.repeat(300)}`
    answering(400, body('invalid_request_error', said))
    const error = await failure()
    const prefix = 'anthropic answered 400: '
    expect(error.message.slice(0, prefix.length)).toBe(prefix)
    const kept = error.message.slice(prefix.length)
    expect(kept.length).toBe(MESSAGE_CAP)
    expect(kept).toBe(`${said.slice(0, MESSAGE_CAP - 1)}…`)
  })

  // Kills: the read of a non-2xx body swallowing why it ended, so a caller's abort, or a timeout that was due, reads
  // as the status ("anthropic answered 529").
  it('a caller abort or the timeout while a 529 body is still arriving is adapter.cancelled or adapter.timeout', async () => {
    stalling(529)
    const adapter = createAnthropicAiAdapter({ apiKey: KEY, timeoutMs: 400, logger })
    const caller = new AbortController()
    setTimeout(() => caller.abort(), 50)
    const outcomes = await Promise.allSettled([
      adapter.chat([{ role: 'user', content: 'Say hello.' }], { signal: caller.signal }),
      adapter.chat([{ role: 'user', content: 'Say hello.' }]),
    ])
    expect(
      outcomes.map((o) =>
        o.status === 'rejected'
          ? [(o.reason as AdapterError).code, (o.reason as AdapterError).message]
          : o.status,
      ),
    ).toEqual([
      ['adapter.cancelled', 'anthropic request cancelled by the caller'],
      ['adapter.timeout', 'anthropic gave no answer within 400 ms'],
    ])
  })
})
