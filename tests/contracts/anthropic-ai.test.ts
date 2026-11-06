import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adapterContext, runAiContract, type AiFailureMode } from '@nymbalhq/contract-tests'
import type { AiAdapter, Logger } from '@nymbalhq/types'
import { createAdapter } from '../../packages/adapters/ai/anthropic/src/index.js'
import { DEFAULT_BASE_URL } from '../../packages/adapters/ai/anthropic/src/anthropic-adapter.js'
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

// The ai contract for `anthropic` against the Anthropic stand-in (tests/support/ai-stand-in.ts): the eval set, refused
// input, complete() as chat(), and every provider failure with a key from the config block. Beside it, what only the
// recorded request shows: the turns and their roles in order, the system prompt in the top-level `system` field,
// max_tokens, each wire stop reason mapped, tools and their calls and results in Anthropic's blocks, and a stream
// request that is the same request with `stream: true`.

const KEY = `sk-ant-stand-in-${randomUUID()}`

let standIn: AiStandIn
beforeAll(async () => {
  standIn = await startAiStandIn('anthropic')
})
afterAll(async () => {
  await standIn.close()
})

async function build(config: Record<string, unknown>, logger?: Logger): Promise<AiAdapter> {
  const ctx = adapterContext('ai', config)
  const adapter = createAdapter(logger === undefined ? ctx : { ...ctx, logger })
  await adapter.initialize(config)
  return adapter
}

runAiContract('anthropic (stand-in)', () => build({ apiKey: KEY, baseUrl: standIn.url }), {
  requests: () => standIn.requests.length,
  requires: ['tools', 'stream'],
  failing: async (mode: AiFailureMode, key: string, logger: Logger) => {
    if (mode === 'unreachable') {
      const adapter = await build({ apiKey: key, baseUrl: await refusedUrl() }, logger)
      return {
        adapter,
        requests: () => 0,
        close: async () => undefined,
        sent: () => [],
        closed: () => 0,
      }
    }
    const failing = await startAiStandIn('anthropic', mode)
    const adapter = await build(
      {
        apiKey: key,
        baseUrl: failing.url,
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

describe('the Anthropic wire', () => {
  let wire: AiStandIn
  let adapter: AiAdapter
  beforeAll(async () => {
    wire = await startAiStandIn('anthropic')
    adapter = await build({ apiKey: KEY, baseUrl: wire.url })
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

  it('AC-1: a three-turn conversation reaches /v1/messages whole, in order, with roles user, assistant, user, and the answer recalls the code word', async () => {
    const conversation = [
      { role: 'user', content: 'The code word is saffron512.' },
      { role: 'assistant', content: 'Noted.' },
      { role: 'user', content: 'What is the code word? Reply with the word only.' },
    ] as const

    const result = await adapter.chat(conversation)

    expect(wire.requests.map((r) => [r.method, r.path])).toEqual([['POST', '/v1/messages']])
    expect(wire.requests[0]!.credential).toBe(KEY)
    expect(wire.requests[0]!.headers['anthropic-version']).toBe('2023-06-01')
    expect(turnsOf(lastBody())).toEqual(conversation.map((t) => ({ ...t })))
    expect(result.text).toBe(wire.answers.at(-1)!.text)
    expect(result.text).toContain('saffron512')
  })

  it('AC-2: system goes to the top-level system field, no turn carries the system role, and the answer obeys it', async () => {
    const system = 'Answer only in upper case.'

    const result = await adapter.chat([{ role: 'user', content: 'Say hello.' }], { system })

    const body = lastBody()
    expect(contentText(body['system'])).toBe(system)
    expect(turnsOf(body)).toEqual([{ role: 'user', content: 'Say hello.' }])
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
    expect(oneAnswer.stop).toBe('max_tokens')
    expect(unsetAnswer.stop).toBe('end_turn')
  })

  it('AC-2: each wire stop reason maps to end, max_tokens, tool_use or other, never passed through raw', async () => {
    const table = [
      ['end_turn', 'end'],
      ['stop_sequence', 'end'],
      ['max_tokens', 'max_tokens'],
      ['refusal', 'other'],
      ['pause_turn', 'other'],
      ['tool_use', 'tool_use'],
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
  type Block = Record<string, unknown>
  const messagesOf = (body: Record<string, unknown>) =>
    body['messages'] as Array<{ role: string; content: unknown }>
  const resultsOf = (content: unknown) =>
    (content as Block[]).map((b) => ({
      type: b['type'],
      tool_use_id: b['tool_use_id'],
      text: contentText(b['content']),
      is_error: b['is_error'] ?? false,
    }))

  it('AC-1: the tool goes out as tools[].input_schema, its call comes back with the id the provider gave, and sending it back makes a tool_use block with that id and a user turn of one tool_result with that tool_use_id', async () => {
    const chat = toolAware(adapter)
    const first = await chat.chat([{ role: 'user', content: ASK }], { tools: [LOOKUP_PRICE] })
    const firstBody = lastBody()
    const given = wire.answers.at(-1)!.toolCalls
    const id = first.toolCalls?.[0]?.id

    expect(firstBody['tools']).toEqual([
      {
        name: LOOKUP_PRICE.name,
        description: LOOKUP_PRICE.description,
        input_schema: LOOKUP_PRICE.inputSchema,
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

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]!.content).toEqual([
      { type: 'tool_use', id: given[0]!.id, name: 'lookup_price', input: { sku: 'A-17' } },
    ])
    expect(resultsOf(messages[2]!.content)).toEqual([
      { type: 'tool_result', tool_use_id: given[0]!.id, text: RESULT, is_error: false },
    ])
    expect(second.text).toBe(wire.answers.at(-1)!.text)
    expect(second.text).toContain('42.50')
  })

  it('AC-2: an assistant turn with text and two calls sends a text block before its tool_use blocks, and the two tool turns after it go as one user turn of tool_result blocks in order, is_error true only on the one marked isError', async () => {
    const calls = [
      { id: 'toolu_first', name: 'lookup_price', args: { sku: 'A-17' } },
      { id: 'toolu_second', name: 'lookup_price', args: { sku: 'B-2' } },
    ]

    const result = await toolAware(adapter).chat(
      [
        { role: 'user', content: 'Compare SKU A-17 and SKU B-2.' },
        { role: 'assistant', content: 'Let me check both.', toolCalls: calls },
        { role: 'tool', toolCallId: 'toolu_first', content: RESULT },
        {
          role: 'tool',
          toolCallId: 'toolu_second',
          content: 'No product has SKU B-2.',
          isError: true,
        },
      ],
      { tools: [LOOKUP_PRICE] },
    )
    const messages = messagesOf(lastBody())

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]!.content).toEqual([
      { type: 'text', text: 'Let me check both.' },
      ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })),
    ])
    expect(resultsOf(messages[2]!.content)).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_first', text: RESULT, is_error: false },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_second',
        text: 'No product has SKU B-2.',
        is_error: true,
      },
    ])
    expect(result.text).toBe(wire.answers.at(-1)!.text)
  })

  it("AC-2: a reply of one tool_use block answers text '', stopReason tool_use and the provider's call; a text reply answers no calls; a reply with neither is unexpected_response", async () => {
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

  it('AC-2: a tool_use whose input is not a JSON object (an array, a string, null, a cut JSON text) rejects adapter.unexpected_response', async () => {
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

  it('AC-5: chatStream() sends the request chat() sends for the same conversation, with stream: true added', async () => {
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
    expect(wire.requests.map((r) => r.headers['anthropic-version'])).toEqual(['2023-06-01', '2023-06-01'])
    expect({ ...streamed, stream: undefined }).toEqual({ ...plain, stream: undefined })
    expect(events.at(-1)?.type).toBe('done')
  })
})

describe('AC-11: the adapter says where its requests go', () => {
  it("AC-11: property: endpoint is the baseUrl the block gives, Anthropic's DEFAULT_BASE_URL when it gives none or an empty one, and never holds the key", async () => {
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

          expect(adapter.endpoint).toBe(baseUrl === undefined || baseUrl === '' ? DEFAULT_BASE_URL : baseUrl)
          expect(String(adapter.endpoint).includes(key)).toBe(false)
        },
      ),
      { numRuns: 50 },
    )
  })
})
