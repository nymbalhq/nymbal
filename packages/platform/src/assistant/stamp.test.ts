import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CUSTOMER_FIELDS } from '@nymbalhq/config'
import type {
  AiAdapter,
  Caller,
  ChatOptions,
  ChatStreamEvent,
  Logger,
  ToolDefinition,
  ToolSurface,
} from '@nymbalhq/types'
import { createKernel, type Kernel } from '../../tests/support/kernel.js'
import {
  assistantTools,
  BULK_CHANGE_RULE,
  MASKED_DATA_RULE,
  PERSONAL_DATA_RULE,
  runAssistantTurn,
  STORE_DATA_RULE,
} from './loop.js'
import { assistantEvalHash, assistantEvalInput, canonicalJson, EVAL_STAMP_STORE } from './stamp.js'

// The eval stamp: a hash of the system prompt (masked and not) and of the tools the assistant is offered. A release is
// held until the committed record of the last real eval run carries the hash of what the assistant is sent then.

const ADMIN: Caller = {
  auth: { userId: 'admin-1', roles: ['admin'] },
  agent: { name: 'nymbal-assistant' },
}

const silent: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
}

let kernel: Kernel
let surface: ToolSurface

beforeAll(async () => {
  kernel = await createKernel({ dialect: 'sqlite' })
  const nothing = {
    registerRoute() {},
    registerStreamRoute() {},
    registerMiddleware() {},
    setDefaultHeaders() {},
    async start() {},
    async stop() {},
  }
  await kernel.app.attachHttp(nothing, { adminRoot: null })
  surface = kernel.app.assistantTools!
}, 30_000)

afterAll(async () => {
  await kernel?.close()
})

/** A model that answers at once, keeping what each request was sent. */
function recordingModel(): { ai: AiAdapter; sent: ChatOptions[] } {
  const sent: ChatOptions[] = []
  const usage = { inputTokens: 1, outputTokens: 1 }
  const ai = {
    kind: 'ai',
    providerName: 'recording',
    capabilities: () => ['chat', 'tools', 'stream'],
    async chat() {
      throw new Error('the loop streams')
    },
    async *chatStream(_messages: unknown, opts: ChatOptions): AsyncIterable<ChatStreamEvent> {
      sent.push(opts)
      yield { type: 'text', delta: 'ok' }
      yield {
        type: 'done',
        result: { text: 'ok', stopReason: 'end', usage, model: 'm', toolCalls: [] },
      }
    },
  } as unknown as AiAdapter
  return { ai, sent }
}

/** What the loop sends the model on an order's page, with `mask` as the turn's mask. */
async function sentBy(mask: readonly (typeof DEFAULT_CUSTOMER_FIELDS)[number][]) {
  const { ai, sent } = recordingModel()
  await runAssistantTurn(
    {
      ai,
      tools: surface,
      proposals: { get: async () => null },
      logger: silent,
      store: { ...EVAL_STAMP_STORE },
      mask,
    },
    { caller: ADMIN, messages: [{ role: 'user', content: 'Hello' }], page: '/orders/1001' },
    () => undefined,
  )
  expect(sent.length).toBe(1)
  const tools = [...(sent[0]!.tools ?? [])].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  return { system: sent[0]!.system, tools }
}

/** `value` with every object's keys in reverse order. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, v]) => [key, reversedKeys(v)]),
  )
}

const listing = (tools: ToolDefinition[]): Pick<ToolSurface, 'list'> => ({ list: () => tools })

describe('the eval stamp', () => {
  it('what is hashed is what the loop sends: the masked prompt under the default mask, the plain one with masking off, and the tools it offers', async () => {
    const input = assistantEvalInput(surface)
    const masked = await sentBy(DEFAULT_CUSTOMER_FIELDS)
    const plain = await sentBy([])

    expect(input.prompts).toEqual({ masked: masked.system, plain: plain.system })
    expect(input.tools).toEqual(masked.tools)
    expect(input.tools).toEqual(plain.tools)
    for (const rule of [STORE_DATA_RULE, PERSONAL_DATA_RULE, BULK_CHANGE_RULE]) {
      expect([input.prompts.masked.includes(rule), input.prompts.plain.includes(rule)]).toEqual([
        true,
        true,
      ])
    }
    expect(input.prompts.masked.replace(`\n${MASKED_DATA_RULE}`, '')).toBe(input.prompts.plain)
  })

  it("the hash moves with either prompt, an offered tool's description or input schema, and not with a tool the assistant is not offered or with the order tools and keys are listed in", () => {
    const listed = surface.list(ADMIN)
    const offered = new Set(assistantTools(listed).map((t) => t.name))
    const target = listed.find(
      (t) => offered.has(t.name) && t.inputSchema.properties !== undefined,
    )!
    const hidden = listed.find((t) => !offered.has(t.name))!
    expect([offered.has(target.name), offered.has(hidden.name)]).toEqual([true, false])
    const swap = (name: string, tool: ToolDefinition) =>
      listed.map((t) => (t.name === name ? tool : t))
    const base = assistantEvalHash(listing(listed))

    const described = swap(target.name, { ...target, description: `${target.description} ` })
    const schema = swap(target.name, {
      ...target,
      inputSchema: {
        ...target.inputSchema,
        properties: { ...target.inputSchema.properties, extra: { type: 'string' } },
      },
    })
    const unoffered = swap(hidden.name, { ...hidden, description: 'Changed.' })
    const reordered = [...listed].reverse().map((t) => reversedKeys(t) as ToolDefinition)

    // What is hashed is the whole input, both prompts included: its canonical JSON reads back as it was.
    const input = assistantEvalInput(surface)
    expect(JSON.parse(canonicalJson(input))).toStrictEqual(input)

    expect(base).toBe(assistantEvalHash(surface))
    expect(assistantEvalHash(listing(described))).not.toBe(base)
    expect(assistantEvalHash(listing(schema))).not.toBe(base)
    expect(assistantEvalHash(listing(unoffered))).toBe(base)
    expect(assistantEvalHash(listing(reordered))).toBe(base)
  })
})
