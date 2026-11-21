import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdapterError, Logger } from '@nymbalhq/types'
import { createOpenAiAdapter } from '../../packages/adapters/ai/openai/src/openai-adapter.js'
import { MESSAGE_CAP } from '../../packages/adapters/ai/openai/src/chat.js'

// What a merchant reads when OpenAI refuses a request: the provider's own error type and message from its JSON body
// (the real shapes below), capped, with no key in it, and a spent quota told apart from a rate limit.

const KEY = 'sk-proj-TestKey_0123456789abcdefghij'
const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger

const body = (message: string, type: string, code: string | null) =>
  JSON.stringify({ error: { message, type, param: null, code } })

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
  const adapter = createOpenAiAdapter({ apiKey, model: 'gpt-4o-mini', logger })
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

describe('an OpenAI error body', () => {
  // Kills: the body left unread, so a spent quota reads "openai answered 429" as a rate limit that waiting would cure.
  it('a 429 insufficient_quota is adapter.quota_exceeded with the provider message after the status, and a plain 429 stays adapter.rate_limited', async () => {
    const quota = 'You exceeded your current quota, please check your plan and billing details.'
    const limit = 'Rate limit reached for gpt-4o-mini on requests per min (RPM): Limit 3, Used 3.'
    answering(429, body(quota, 'insufficient_quota', 'insufficient_quota'))
    const spent = await failure()
    answering(429, body(limit, 'requests', 'rate_limit_exceeded'))
    const limited = await failure()
    expect([spent.code, spent.message]).toEqual([
      'adapter.quota_exceeded',
      `openai answered 429: ${quota}`,
    ])
    expect([limited.code, limited.message]).toEqual([
      'adapter.rate_limited',
      `openai answered 429: ${limit}`,
    ])
    expect(spent.context).toEqual({ provider: 'openai', status: 429 })
  })

  // Kills: the message passed on as the provider wrote it, the configured key (raw, base64 with or without its
  // padding, base64url) or another sk- key in it; or the message dropped whole, losing what the merchant needs.
  // The example: the configured key taken out of a longer key it begins, leaving that key's tail ("[redacted]__aaaa").
  // The glued key: an sk- key straight after the key's base64url form, with no word boundary before it.
  it('property: a message echoing the configured key in any form, or any sk- key, keeps its words and loses the keys', async () => {
    const keyArb = fc.stringMatching(/^[A-Za-z0-9_-]{16,48}$/)
    await fc.assert(
      fc.asyncProperty(keyArb, keyArb, async (raw, other) => {
        const key = `sk-proj-${raw}`
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
            `Incorrect API key provided: ${forms[0]} (${forms[1]}, ${forms[2]}, ${forms[3]}); not sk-${other} either; nor ${forms[3]}sk-${other}`,
            'invalid_request_error',
            'invalid_api_key',
          ),
        )
        const error = await failure(key)
        expect(error.code).toBe('adapter.auth_failed')
        expect(error.message).toBe(
          'openai answered 401: Incorrect API key provided: [redacted] ([redacted], [redacted], [redacted]); not [redacted] either; nor [redacted]',
        )
        expect(forms.filter((form) => JSON.stringify(error).includes(form))).toEqual([])
      }),
      { numRuns: 40, examples: [['__lookupSetter__', 'proj-__lookupSetter____aaaa']] },
    )
  })

  // Kills: key-shaped tokens taken out before the conversation's texts, so a text holding an sk- key no longer
  // matches whole and the rest of what the shopper wrote reaches the merchant's error.
  it('a message echoing a conversation text that holds an sk- key loses the whole text', async () => {
    const said = 'Please check sk-proj-old_0123456789abcdef for the order to 12 Elm Street.'
    answering(400, body(`Invalid content: ${said} was refused`, 'invalid_request_error', null))
    const error = await failure(KEY, said)
    expect(error.message).toBe('openai answered 400: Invalid content: [redacted] was refused')
  })

  // Kills: an uncapped message, so a provider's page-long text fills the merchant's error line.
  it(`a long message is cut to ${MESSAGE_CAP} characters, ending in an ellipsis`, async () => {
    const said = `Invalid request. ${'This sentence repeats. '.repeat(300)}`
    answering(400, body(said, 'invalid_request_error', null))
    const error = await failure()
    const prefix = 'openai answered 400: '
    expect(error.message.slice(0, prefix.length)).toBe(prefix)
    const kept = error.message.slice(prefix.length)
    expect(kept.length).toBe(MESSAGE_CAP)
    expect(kept).toBe(`${said.slice(0, MESSAGE_CAP - 1)}…`)
  })

  // Kills: the read of a non-2xx body swallowing why it ended, so a caller's abort, or a timeout that was due, reads
  // as the status ("openai answered 529").
  it('a caller abort or the timeout while a 529 body is still arriving is adapter.cancelled or adapter.timeout', async () => {
    stalling(529)
    const adapter = createOpenAiAdapter({
      apiKey: KEY,
      model: 'gpt-4o-mini',
      timeoutMs: 400,
      logger,
    })
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
      ['adapter.cancelled', 'openai request cancelled by the caller'],
      ['adapter.timeout', 'openai gave no answer within 400 ms'],
    ])
  })
})
