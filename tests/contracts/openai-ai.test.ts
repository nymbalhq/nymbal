import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { adapterContext, runAiContract, type AiFailureMode } from '@nymbalhq/contract-tests'
import type { AiAdapter, Logger } from '@nymbalhq/types'
import { createAdapter, DEFAULT_BASE_URL } from '../../packages/adapters/ai/openai/src/index.js'
import {
  contentText,
  LOOKUP_PRICE,
  refusedUrl,
  settledCode,
  startAiStandIn,
  toolAware,
  type AiStandIn,
  type ToolAwareEvent,
} from '../support/ai-stand-in.js'

// The ai contract for `openai` against the OpenAI stand-in (tests/support/ai-stand-in.ts), as for `anthropic`. Beside
// it, the request as the wire shows it: a Bearer key to `<baseUrl>/chat/completions` with the baseUrl's path prefix
// kept, OpenAI's own URL when no baseUrl is set, the system prompt as the first `system` message, max_tokens, each
// finish reason mapped, and a block without `model` refused when the adapter is made; tools, their calls and results
// in OpenAI's fields, a stream request that is the same request with `stream: true`, and the token field by host.

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
  requires: ['tools', 'stream'],
  failing: async (mode: AiFailureMode, key: string, logger: Logger) => {
    if (mode === 'unreachable') {
      const adapter = await build({ apiKey: key, baseUrl: `${await refusedUrl()}/v1` }, logger)
      return {
        adapter,
        requests: () => 0,
        close: async () => undefined,
        sent: () => [],
        closed: () => 0,
      }
    }
    const failing = await startAiStandIn('openai', mode)
    const adapter = await build(
      {
        apiKey: key,
        baseUrl: `${failing.url}/v1`,
        ...((mode === 'hang' || mode === 'stream-stall') && { timeoutMs: 300 }),
      },
      logger,
    )
    return {
      adapter,
      requests: () => failing.requests.length,
      close: () => failing.close(),
      sent: () => failing.answers.at(-1)?.deltas ?? [],
      closed: () => failing.requests.filter((r) => r.closedEarly).length,
    }
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

  it('AC-2: each finish reason maps to end, max_tokens, tool_use or other, never passed through raw', async () => {
    const table = [
      ['stop', 'end'],
      ['length', 'max_tokens'],
      ['content_filter', 'other'],
      ['tool_calls', 'tool_use'],
    ] as const
    const mapped: string[] = []
    for (const [stop] of table) {
      wire.mode = `stop:${stop}`
      const result = await adapter.chat([{ role: 'user', content: 'Say hello.' }])
      mapped.push(result.stopReason)
    }
    expect(mapped).toEqual(table.map(([, expected]) => expected))
  })

  const ASK = 'What does SKU A-17 cost? Use the lookup_price tool.'
  const RESULT = 'A-17 costs 42.50 EUR.'
  const messagesOf = (body: Record<string, unknown>) =>
    body['messages'] as Array<Record<string, unknown>>
  const argumentsOf = (message: Record<string, unknown> | undefined): unknown[] =>
    ((message?.['tool_calls'] ?? []) as Array<{ function?: { arguments?: unknown } }>).map(
      (c) => c.function?.arguments,
    )

  it("AC-1: the tool goes out as tools[].function.parameters, its call comes back with the id the provider gave and its arguments parsed, and sending it back makes tool_calls with the arguments as a JSON string and a role 'tool' turn with that tool_call_id", async () => {
    const chat = toolAware(adapter)
    const first = await chat.chat([{ role: 'user', content: ASK }], { tools: [LOOKUP_PRICE] })
    const firstBody = lastBody()
    const given = wire.answers.at(-1)!.toolCalls
    const id = first.toolCalls?.[0]?.id

    expect(firstBody['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: LOOKUP_PRICE.name,
          description: LOOKUP_PRICE.description,
          parameters: LOOKUP_PRICE.inputSchema,
        },
      },
    ])
    expect(first.toolCalls).toEqual(given)

    const second = await chat.chat(
      [
        { role: 'user', content: ASK },
        { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
        { role: 'tool', toolCallId: id, content: RESULT },
      ],
      { tools: [LOOKUP_PRICE] },
    )
    const messages = messagesOf(lastBody())
    const sentArguments = argumentsOf(messages[1])

    expect(messages).toEqual([
      { role: 'user', content: ASK },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: given[0]!.id,
            type: 'function',
            function: { name: 'lookup_price', arguments: expect.any(String) as unknown },
          },
        ],
      },
      { role: 'tool', tool_call_id: given[0]!.id, content: RESULT },
    ])
    expect(sentArguments.map((a) => JSON.parse(String(a)) as unknown)).toEqual([given[0]!.args])
    expect(second.text).toBe(wire.answers.at(-1)!.text)
    expect(second.text).toContain('42.50')
  })

  it("AC-2: an assistant turn with text and two calls keeps its text as content, and each tool turn goes as its own role 'tool' message with its content as given and no error flag", async () => {
    const calls = [
      { id: 'call_first', name: 'lookup_price', args: { sku: 'A-17' } },
      { id: 'call_second', name: 'lookup_price', args: { sku: 'B-2' } },
    ]

    const result = await toolAware(adapter).chat(
      [
        { role: 'user', content: 'Compare SKU A-17 and SKU B-2.' },
        { role: 'assistant', content: 'Let me check both.', toolCalls: calls },
        { role: 'tool', toolCallId: 'call_first', content: RESULT },
        {
          role: 'tool',
          toolCallId: 'call_second',
          content: 'No product has SKU B-2.',
          isError: true,
        },
      ],
      { tools: [LOOKUP_PRICE] },
    )
    const messages = messagesOf(lastBody())

    expect(messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: 'Let me check both.',
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: expect.any(String) as unknown },
        })),
      },
      { role: 'tool', tool_call_id: 'call_first', content: RESULT },
      { role: 'tool', tool_call_id: 'call_second', content: 'No product has SKU B-2.' },
    ])
    expect(argumentsOf(messages[1]).map((a) => JSON.parse(String(a)) as unknown)).toEqual(
      calls.map((c) => c.args),
    )
    expect(result.text).toBe(wire.answers.at(-1)!.text)
  })

  it("AC-2: a reply of content null with tool_calls answers text '', stopReason tool_use and the provider's call; a text reply answers no calls; a reply with neither is unexpected_response", async () => {
    const chat = toolAware(adapter)
    const toolOnly = await chat.chat([{ role: 'user', content: ASK }], { tools: [LOOKUP_PRICE] })
    const sent = wire.answers.at(-1)!
    const plain = await chat.chat([{ role: 'user', content: 'Say hello.' }], {
      tools: [LOOKUP_PRICE],
    })
    wire.mode = 'no-text'
    const empty = await settledCode(
      chat.chat([{ role: 'user', content: ASK }], { tools: [LOOKUP_PRICE] }),
    )

    expect([sent.text, sent.toolCalls.length]).toEqual(['', 1])
    expect({
      text: toolOnly.text,
      stopReason: toolOnly.stopReason,
      toolCalls: toolOnly.toolCalls,
    }).toEqual({ text: '', stopReason: 'tool_use', toolCalls: sent.toolCalls })
    expect({ text: plain.text, toolCalls: plain.toolCalls }).toEqual({
      text: wire.answers[1]!.text,
      toolCalls: [],
    })
    expect(empty).toBe('adapter.unexpected_response')
  })

  it('AC-2: tool_calls whose arguments are not a JSON object (an array, a string, null, a cut JSON text) reject adapter.unexpected_response', async () => {
    const variants = ['array', 'string', 'null', 'not-json'] as const
    const codes: unknown[] = []
    for (const variant of variants) {
      wire.mode = `bad-tool-args:${variant}`
      codes.push(
        await settledCode(
          toolAware(adapter).chat([{ role: 'user', content: ASK }], { tools: [LOOKUP_PRICE] }),
        ),
      )
    }

    expect(codes).toEqual(variants.map(() => 'adapter.unexpected_response'))
    expect(wire.requests).toHaveLength(variants.length)
  })

  it("AC-5: chatStream() sends the request chat() sends for the same conversation, with stream: true added (no stream_options off OpenAI's host)", async () => {
    const conversation = [{ role: 'user', content: 'Say hello.' }]
    const opts = { system: 'Answer only in upper case.', maxTokens: 64, tools: [LOOKUP_PRICE] }
    const stream = toolAware(adapter).chatStream
    const events: ToolAwareEvent[] = []
    expect(typeof stream, 'the adapter has no chatStream()').toBe('function')

    for await (const event of stream!.call(adapter, conversation, opts)) events.push(event)
    const streamed = lastBody()
    await toolAware(adapter).chat(conversation, opts)
    const plain = lastBody()

    expect(streamed['stream']).toBe(true)
    expect(plain['stream'] ?? false).toBe(false)
    expect({ ...streamed, stream: undefined }).toEqual({ ...plain, stream: undefined })
    expect(events.at(-1)?.type).toBe('done')
  })
})

describe("AC-4: OpenAI's token field", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Answers every request as OpenAI would, recording each body; no request leaves the process. */
  function stubOpenAi(): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const raw = input instanceof Request ? await input.clone().text() : String(init?.body)
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-token-field',
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
    return bodies
  }

  /** The token fields of one chat() per maxTokens (unset: 1024) on an adapter built from `config`. */
  async function fieldsSent(config: Record<string, unknown>, lastSent: () => unknown) {
    const adapter = await build({ apiKey: KEY, ...config })
    const seen: Array<{ max_tokens: unknown; max_completion_tokens: unknown }> = []
    for (const maxTokens of [1, 300, undefined]) {
      await adapter.chat(
        [{ role: 'user', content: 'Reply with exactly the word PONG.' }],
        maxTokens === undefined ? {} : { maxTokens },
      )
      const body = lastSent() as Record<string, unknown>
      seen.push({
        max_tokens: body['max_tokens'],
        max_completion_tokens: body['max_completion_tokens'],
      })
    }
    return seen
  }

  const asCompletion = [1, 300, 1024].map((n) => ({
    max_tokens: undefined,
    max_completion_tokens: n,
  }))
  const asMaxTokens = [1, 300, 1024].map((n) => ({
    max_tokens: n,
    max_completion_tokens: undefined,
  }))

  it('AC-4: max_completion_tokens equal to maxTokens and no max_tokens with no baseUrl or a baseUrl on host api.openai.com; max_tokens and no max_completion_tokens on any other host (the stand-in on 127.0.0.1, a host that only starts with api.openai.com, a gateway path naming it)', async () => {
    const local = await fieldsSent(
      { baseUrl: `${standIn.url}/v1` },
      () => standIn.requests.at(-1)?.body,
    )
    const bodies = stubOpenAi()
    const hosts = [
      [undefined, asCompletion],
      ['https://api.openai.com/v1', asCompletion],
      ['https://api.openai.com/v1/', asCompletion],
      ['https://api.openai.com.gateway.example/v1', asMaxTokens],
      ['https://gateway.example/api.openai.com/v1', asMaxTokens],
    ] as const
    const seen = []
    for (const [baseUrl] of hosts) {
      seen.push(await fieldsSent(baseUrl === undefined ? {} : { baseUrl }, () => bodies.at(-1)))
    }

    expect(local).toEqual(asMaxTokens)
    expect(seen).toEqual(hosts.map(([, fields]) => fields))
  })

  it("AC-4: the block's tokenField overrides the host either way", async () => {
    const bodies = stubOpenAi()

    const onOpenAi = await fieldsSent({ tokenField: 'max_tokens' }, () => bodies.at(-1))
    const elsewhere = await fieldsSent(
      { baseUrl: 'https://gateway.example/v1', tokenField: 'max_completion_tokens' },
      () => bodies.at(-1),
    )

    expect([onOpenAi, elsewhere]).toEqual([asMaxTokens, asCompletion])
  })

  it("AC-4: tokenField 'max_length' fails createAdapter with a ConfigError naming commerce.ai.config.tokenField", async () => {
    const ctx = adapterContext('ai', { model: MODEL, apiKey: KEY, tokenField: 'max_length' })

    const made = (async () => createAdapter(ctx))()

    await expect(made).rejects.toMatchObject({
      name: 'ConfigError',
      message: expect.stringContaining('commerce.ai.config.tokenField') as unknown,
    })
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

describe('cached prompt tokens', () => {
  it('usage reports the prompt tokens OpenAI read from its cache as cacheReadTokens, inputTokens still every prompt token; without prompt_tokens_details there is no cacheReadTokens', async () => {
    const cached = await startAiStandIn('openai', 'script', (view) =>
      view.index === 0 ? { text: 'Noted.', cachedTokens: 3 } : { text: 'Noted.' },
    )
    try {
      const adapter = await build({ apiKey: KEY, baseUrl: `${cached.url}/v1` })
      const conversation = [
        { role: 'user', content: 'The code word is saffron512, noted?' },
      ] as const

      const reported = await adapter.chat(conversation)
      const plain = await adapter.chat(conversation)

      const [first, second] = cached.answers
      expect(reported.usage).toEqual({
        inputTokens: first!.inputWords,
        outputTokens: first!.outputWords,
        cacheReadTokens: 3,
      })
      expect(first!.inputWords).toBeGreaterThan(3)
      expect(plain.usage).toEqual({
        inputTokens: second!.inputWords,
        outputTokens: second!.outputWords,
      })
    } finally {
      await cached.close()
    }
  })

  it('chatStream() reports the same cacheReadTokens from the final usage chunk, and none without prompt_tokens_details', async () => {
    const cached = await startAiStandIn('openai', 'script', (view) =>
      view.index === 0 ? { text: 'Noted.', cachedTokens: 3 } : { text: 'Noted.' },
    )
    // Only OpenAI's own host is asked for a usage chunk, so the default base URL is kept and routed to the stand-in.
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      realFetch(String(input).replace(DEFAULT_BASE_URL, `${cached.url}/v1`), init),
    )
    try {
      const adapter = toolAware(await build({ apiKey: KEY }))
      expect(typeof adapter.chatStream, 'the adapter has no chatStream()').toBe('function')
      const conversation = [{ role: 'user', content: 'The code word is saffron512, noted?' }]
      const usageOfStream = async () => {
        const events: ToolAwareEvent[] = []
        for await (const event of adapter.chatStream!(conversation)) events.push(event)
        const last = events.at(-1)
        return last?.type === 'done' ? last.result.usage : undefined
      }

      const reported = await usageOfStream()
      const plain = await usageOfStream()

      const [first, second] = cached.answers
      expect(reported).toEqual({
        inputTokens: first!.inputWords,
        outputTokens: first!.outputWords,
        cacheReadTokens: 3,
      })
      expect(first!.inputWords).toBeGreaterThan(3)
      expect(plain).toEqual({
        inputTokens: second!.inputWords,
        outputTokens: second!.outputWords,
      })
    } finally {
      vi.unstubAllGlobals()
      await cached.close()
    }
  })
})

describe('AC-11: the adapter says where its requests go', () => {
  it("AC-11: property: endpoint is the baseUrl the block gives, OpenAI's DEFAULT_BASE_URL when it gives none or an empty one, and never holds the key", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.webUrl({ withQueryParameters: false, withFragments: false }),
          fc.constantFrom(undefined, ''),
        ),
        fc.stringMatching(/^[A-Za-z0-9_-]{24,48}$/),
        async (baseUrl, secret) => {
          const key = `sk-${secret}`
          const adapter = await build({ apiKey: key, ...(baseUrl !== undefined && { baseUrl }) })

          expect(adapter.endpoint).toBe(
            baseUrl === undefined || baseUrl === '' ? DEFAULT_BASE_URL : baseUrl,
          )
          expect(String(adapter.endpoint).includes(key)).toBe(false)
        },
      ),
      { numRuns: 50 },
    )
  })
})
