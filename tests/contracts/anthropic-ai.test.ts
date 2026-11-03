import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adapterContext, runAiContract, type AiFailureMode } from '@nymbalhq/contract-tests'
import type { AiAdapter, Logger } from '@nymbalhq/types'
import { createAdapter } from '../../packages/adapters/ai/anthropic/src/index.js'
import { contentText, refusedUrl, startAiStandIn, type AiStandIn } from '../support/ai-stand-in.js'

// The ai contract for `anthropic` against the Anthropic stand-in (tests/support/ai-stand-in.ts): the eval set, refused
// input, complete() as chat(), and every provider failure with a key from the config block. Beside it, what only the
// recorded request shows: the turns and their roles in order, the system prompt in the top-level `system` field,
// max_tokens, and each wire stop reason mapped.

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
  failing: async (mode: AiFailureMode, key: string, logger: Logger) => {
    if (mode === 'unreachable') {
      const adapter = await build({ apiKey: key, baseUrl: await refusedUrl() }, logger)
      return { adapter, requests: () => 0, close: async () => undefined }
    }
    const failing = await startAiStandIn('anthropic', mode)
    const adapter = await build(
      { apiKey: key, baseUrl: failing.url, ...(mode === 'hang' && { timeoutMs: 300 }) },
      logger,
    )
    return { adapter, requests: () => failing.requests.length, close: () => failing.close() }
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

  it('AC-3: each wire stop reason maps to end, max_tokens or other, never passed through raw', async () => {
    const table = [
      ['end_turn', 'end'],
      ['stop_sequence', 'end'],
      ['max_tokens', 'max_tokens'],
      ['refusal', 'other'],
      ['pause_turn', 'other'],
      ['tool_use', 'other'],
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
