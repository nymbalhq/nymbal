import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { adapterContext, runAiContract, type AiFailureMode } from '@nymbalhq/contract-tests'
import type { AiAdapter, Logger } from '@nymbalhq/types'
import { createAdapter } from '../../packages/adapters/ai/openai/src/index.js'
import { contentText, refusedUrl, startAiStandIn, type AiStandIn } from '../support/ai-stand-in.js'

// The ai contract for `openai` against the OpenAI stand-in (tests/support/ai-stand-in.ts), as for `anthropic`. Beside
// it, the request as the wire shows it: a Bearer key to `<baseUrl>/chat/completions` with the baseUrl's path prefix
// kept, OpenAI's own URL when no baseUrl is set, the system prompt as the first `system` message, max_tokens, each
// finish reason mapped, and a block without `model` refused when the adapter is made.

const KEY = `sk-stand-in-${randomUUID()}`
const MODEL = 'gpt-stand-in'

let standIn: AiStandIn
beforeAll(async () => {
  standIn = await startAiStandIn('openai')
})
afterAll(async () => {
  await standIn.close()
})

async function build(config: Record<string, unknown>, logger?: Logger): Promise<AiAdapter> {
  const ctx = adapterContext('ai', { model: MODEL, ...config })
  const adapter = await createAdapter(logger === undefined ? ctx : { ...ctx, logger })
  await adapter.initialize(ctx.config)
  return adapter
}

runAiContract('openai (stand-in)', () => build({ apiKey: KEY, baseUrl: `${standIn.url}/v1` }), {
  requests: () => standIn.requests.length,
  failing: async (mode: AiFailureMode, key: string, logger: Logger) => {
    if (mode === 'unreachable') {
      const adapter = await build({ apiKey: key, baseUrl: `${await refusedUrl()}/v1` }, logger)
      return { adapter, requests: () => 0, close: async () => undefined }
    }
    const failing = await startAiStandIn('openai', mode)
    const adapter = await build(
      { apiKey: key, baseUrl: `${failing.url}/v1`, ...(mode === 'hang' && { timeoutMs: 300 }) },
      logger,
    )
    return { adapter, requests: () => failing.requests.length, close: () => failing.close() }
  },
})

describe('the OpenAI wire', () => {
  let wire: AiStandIn
  let adapter: AiAdapter
  beforeAll(async () => {
    wire = await startAiStandIn('openai')
    adapter = await build({ apiKey: KEY, baseUrl: `${wire.url}/v1` })
  })
  afterAll(async () => {
    await wire.close()
  })
  beforeEach(() => {
    wire.mode = 'model'
    wire.reset()
  })

  const lastBody = () => wire.requests.at(-1)?.body as Record<string, unknown>
  const turnsOf = (body: Record<string, unknown>) =>
    (body['messages'] as Array<{ role: string; content: unknown }>).map((m) => ({
      role: m.role,
      content: contentText(m.content),
    }))

  it('AC-1: a three-turn conversation is sent whole, in order, with roles user, assistant, user, and the answer recalls the code word', async () => {
    const conversation = [
      { role: 'user', content: 'The code word is juniper734.' },
      { role: 'assistant', content: 'Noted.' },
      { role: 'user', content: 'What is the code word? Reply with the word only.' },
    ] as const

    const result = await adapter.chat(conversation)

    expect(wire.requests).toHaveLength(1)
    expect(turnsOf(lastBody())).toEqual(conversation.map((t) => ({ ...t })))
    expect(result.text).toBe(wire.answers.at(-1)!.text)
    expect(result.text).toContain('juniper734')
  })

  it('AC-2: system becomes the first message with the system role, the user turn follows it, and the answer obeys it', async () => {
    const system = 'Answer only in upper case.'

    const result = await adapter.chat([{ role: 'user', content: 'Say hello.' }], { system })

    expect(turnsOf(lastBody())).toEqual([
      { role: 'system', content: system },
      { role: 'user', content: 'Say hello.' },
    ])
    expect(result.text).toBe(result.text.toUpperCase())
    expect(result.text).toBe(wire.answers.at(-1)!.text)
  })

  it('AC-3: maxTokens reaches max_tokens (1024 when unset), and usage, model and text are what the provider reported', async () => {
    const unset = await adapter.chat([
      { role: 'user', content: 'Reply with exactly the word PONG.' },
    ])
    const unsetBody = lastBody()
    const unsetAnswer = wire.answers.at(-1)!
    const one = await adapter.chat([{ role: 'user', content: 'Count from 1 to 100.' }], {
      maxTokens: 1,
    })
    const oneBody = lastBody()
    const oneAnswer = wire.answers.at(-1)!

    expect([unsetBody['max_tokens'], oneBody['max_tokens']]).toEqual([1024, 1])
    expect([unsetBody['model'], oneBody['model']]).toEqual([MODEL, MODEL])
    for (const [result, answer] of [
      [unset, unsetAnswer],
      [one, oneAnswer],
    ] as const) {
      expect(result.usage).toEqual({
        inputTokens: answer.inputWords,
        outputTokens: answer.outputWords,
      })
      expect(result.model).toBe(answer.model)
      expect(result.text).toBe(answer.text)
    }
    expect([unset.stopReason, one.stopReason]).toEqual(['end', 'max_tokens'])
    expect([unsetAnswer.stop, oneAnswer.stop]).toEqual(['stop', 'length'])
  })

  it('AC-3: each finish reason maps to end, max_tokens or other, never passed through raw', async () => {
    const table = [
      ['stop', 'end'],
      ['length', 'max_tokens'],
      ['content_filter', 'other'],
      ['tool_calls', 'other'],
    ] as const
    const mapped: string[] = []
    for (const [stop] of table) {
      wire.mode = `stop:${stop}`
      const result = await adapter.chat([{ role: 'user', content: 'Say hello.' }])
      mapped.push(result.stopReason)
    }
    expect(mapped).toEqual(table.map(([, expected]) => expected))
  })
})

describe('AC-9: the OpenAI request shape', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('AC-9: a Bearer key and a JSON body go to <baseUrl>/chat/completions with the path prefix kept and one trailing slash dropped', async () => {
    const wire = await startAiStandIn('openai')
    try {
      const prefixes = ['/v1', '/proxy/openai/v1/']
      for (const prefix of prefixes) {
        const adapter = await build({ apiKey: KEY, baseUrl: `${wire.url}${prefix}` })
        await adapter.chat([{ role: 'user', content: 'Reply with exactly the word PONG.' }])
      }

      expect(wire.requests.map((r) => [r.method, r.path])).toEqual([
        ['POST', '/v1/chat/completions'],
        ['POST', '/proxy/openai/v1/chat/completions'],
      ])
      expect(wire.requests.map((r) => r.headers['authorization'])).toEqual(
        prefixes.map(() => `Bearer ${KEY}`),
      )
      expect(wire.requests.map((r) => r.headers['x-api-key'])).toEqual(
        prefixes.map(() => undefined),
      )
      expect(
        wire.requests.map((r) => String(r.headers['content-type']).split(';')[0]!.trim()),
      ).toEqual(prefixes.map(() => 'application/json'))
    } finally {
      await wire.close()
    }
  })

  it("AC-9: with no baseUrl the request goes to OpenAI's https://api.openai.com/v1/chat/completions", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
      seen.push({ url, authorization: headers.get('authorization') })
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-default-url',
          object: 'chat.completion',
          created: 0,
          model: MODEL,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'PONG' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 6, completion_tokens: 1, total_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const adapter = await build({ apiKey: KEY })

    const result = await adapter.chat([
      { role: 'user', content: 'Reply with exactly the word PONG.' },
    ])

    expect(seen).toEqual([
      { url: 'https://api.openai.com/v1/chat/completions', authorization: `Bearer ${KEY}` },
    ])
    expect(result.text).toBe('PONG')
  })

  it('AC-9: a block without model fails createAdapter with a ConfigError naming commerce.ai.config.model', async () => {
    const ctx = adapterContext('ai', { apiKey: KEY, baseUrl: 'http://127.0.0.1:9/v1' })

    const made = (async () => createAdapter(ctx))()

    await expect(made).rejects.toMatchObject({
      name: 'ConfigError',
      message: expect.stringContaining('commerce.ai.config.model'),
    })
  })
})
