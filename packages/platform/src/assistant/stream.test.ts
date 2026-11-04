import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type {
  AiAdapter,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatStreamEvent,
} from '@nymbalhq/types'
import { streamOf } from './loop.js'

// AC-8: the assistant streams from any ai adapter. One that implements only `chat` (the shape of the third-party
// fixture, tests/fixtures/third-party-ai: no `chatStream`, and a result without `toolCalls`) is streamed as its whole
// text and its result; one with `chatStream` is streamed as its own events.

/** What `chat` answered, as a chat-only adapter of an older contract answers it: no `toolCalls`. */
type BareResult = Omit<ChatResult, 'toolCalls'>

interface Fake {
  ai: AiAdapter
  /** Each `chat` call's conversation and options, as the adapter received them. */
  chats: Array<{ messages: readonly ChatMessage[]; opts: ChatOptions | undefined }>
}

function adapter(
  chat: (messages: readonly ChatMessage[]) => BareResult,
  chatStream?: AiAdapter['chatStream'],
): Fake {
  const chats: Fake['chats'] = []
  const ai = {
    kind: 'ai',
    providerName: 'acme',
    capabilities: () => (chatStream === undefined ? ['complete', 'chat'] : ['chat', 'stream']),
    producesEvents: [],
    consumesEvents: [],
    async initialize() {},
    async healthCheck() {
      return { status: 'healthy' }
    },
    async embed() {
      throw new Error('embed is not supported')
    },
    async complete() {
      throw new Error('complete is not used here')
    },
    async chat(messages: readonly ChatMessage[], opts?: ChatOptions) {
      chats.push({ messages, opts })
      return chat(messages) as ChatResult
    },
    ...(chatStream !== undefined && { chatStream }),
  } as unknown as AiAdapter
  return { ai, chats }
}

async function collect(events: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

const bareResult = fc.record({
  text: fc.string({ minLength: 1, maxLength: 200 }),
  stopReason: fc.constantFrom('end' as const, 'max_tokens' as const),
  usage: fc.record({ inputTokens: fc.nat(10_000), outputTokens: fc.nat(10_000) }),
  model: fc.string({ minLength: 1, maxLength: 30 }),
})

const conversation = fc
  .array(fc.string({ minLength: 1, maxLength: 80 }), { minLength: 1, maxLength: 4 })
  .map((texts): ChatMessage[] => texts.map((content) => ({ role: 'user', content })))

describe('AC-8: streamOf streams any ai adapter', () => {
  it('AC-8: property: for an adapter with no chatStream, streamOf yields one text equal to chat()’s text and one done with chat()’s result (toolCalls [] where chat() gave none), for the conversation and options it was given', async () => {
    await fc.assert(
      fc.asyncProperty(bareResult, conversation, async (result, messages) => {
        const fake = adapter(() => result)
        const opts: ChatOptions = { system: 'You are the shop assistant.', maxTokens: 64 }

        const stream = streamOf(fake.ai)!
        const events = await collect(stream(messages, opts))

        expect(events).toEqual([
          { type: 'text', delta: result.text },
          { type: 'done', result: { ...result, toolCalls: [] } },
        ])
        expect(fake.chats).toEqual([{ messages, opts }])
      }),
      { numRuns: 50 },
    )
  })

  it('AC-8: property: for an adapter with chatStream, streamOf yields that adapter’s own events in order and never calls chat()', async () => {
    const event = fc.oneof(
      fc.record({ type: fc.constant('text' as const), delta: fc.string({ maxLength: 20 }) }),
      fc.record({
        type: fc.constant('tool_call' as const),
        call: fc.record({
          id: fc.string({ minLength: 1, maxLength: 12 }),
          name: fc.constantFrom('admin_products_get', 'admin_orders_list'),
          args: fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 })),
        }),
      }),
    )
    await fc.assert(
      fc.asyncProperty(
        fc.array(event, { maxLength: 8 }),
        bareResult,
        conversation,
        async (before, result, messages) => {
          const calls = before.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []))
          const own: ChatStreamEvent[] = [
            ...before,
            { type: 'done', result: { ...result, toolCalls: calls } },
          ]
          const fake = adapter(
            () => {
              throw new Error('chat() must not be called when chatStream exists')
            },
            async function* () {
              yield* own
            },
          )

          const stream = streamOf(fake.ai)!
          const events = await collect(stream(messages, {}))

          expect(events).toEqual(own)
          expect(fake.chats.length).toBe(0)
        },
      ),
      { numRuns: 50 },
    )
  })
})
