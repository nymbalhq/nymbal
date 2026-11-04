import { describe, expect, it } from 'vitest'
import type {
  AiAdapter,
  Caller,
  ChatStreamEvent,
  ChatToolCall,
  Logger,
  ToolDefinition,
  ToolResult,
  ToolSurface,
} from '@nymbalhq/types'
import { runAssistantTurn } from './loop.js'

// AC-9 (a write is a proposal), the case no store can produce for an admin: the tool surface answers a command as
// `proposed` with no proposal id (what it answers a caller no policy approves, `mcp/invoke.ts`). Nothing was kept, so
// the step is a failed one: a `tool` frame with `ok: false` and no `proposal` frame, and the turn goes on. The model and
// the tool surface are scripted here; the loop is the real one.

const CREATE: ToolDefinition = {
  name: 'admin_products_create',
  title: 'admin.products.create',
  description: 'Create a product with its variants.',
  inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
  scope: 'admin',
  kind: 'command',
  route: { method: 'POST', path: '/api/admin/products', command: 'product.create' },
}

const CALL: ChatToolCall = { id: 'call_1', name: CREATE.name, args: { slug: 'linen-apron' } }

const silent: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
}

/** A model that asks for CALL once, then answers the text it is given. */
function model(): { ai: AiAdapter; requests: number } {
  const state = { requests: 0 }
  const usage = { inputTokens: 1, outputTokens: 1 }
  const ai = {
    kind: 'ai',
    providerName: 'scripted',
    capabilities: () => ['chat', 'tools', 'stream'],
    producesEvents: [],
    consumesEvents: [],
    async initialize() {},
    async healthCheck() {
      return { status: 'healthy' }
    },
    async embed() {
      throw new Error('not used')
    },
    async complete() {
      throw new Error('not used')
    },
    async chat() {
      throw new Error('the loop streams')
    },
    async *chatStream(): AsyncIterable<ChatStreamEvent> {
      state.requests += 1
      if (state.requests === 1) {
        yield { type: 'tool_call', call: CALL }
        yield {
          type: 'done',
          result: { text: '', stopReason: 'tool_use', usage, model: 'm', toolCalls: [CALL] },
        }
        return
      }
      yield { type: 'text', delta: 'Nothing was kept.' }
      yield {
        type: 'done',
        result: { text: 'Nothing was kept.', stopReason: 'end', usage, model: 'm', toolCalls: [] },
      }
    },
  } as unknown as AiAdapter
  return {
    ai,
    get requests() {
      return state.requests
    },
  }
}

describe('AC-9: a write the tool surface did not keep is not a proposal', () => {
  it('AC-9: a command answered proposed with id null is one tool frame with ok false and the registry title, no proposal frame, proposals.get is never asked for it, and the turn ends done', async () => {
    const answered: ToolResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'proposed',
            id: null,
            tool: CREATE.name,
            command: 'product.create',
          }),
        },
      ],
      structuredContent: {
        status: 'proposed',
        id: null,
        tool: CREATE.name,
        command: 'product.create',
      },
    }
    const tools: ToolSurface = { list: () => [CREATE], call: async () => answered }
    const asked: unknown[] = []
    const proposals = {
      get: async (id: string) => {
        asked.push(id)
        return null
      },
    }
    const scripted = model()
    const caller: Caller = {
      auth: { userId: 'admin-1', roles: ['admin'] },
      agent: { name: 'nymbal-assistant' },
    }
    const frames: Array<{ event: string; data: Record<string, unknown> }> = []

    await runAssistantTurn(
      { ai: scripted.ai, tools, proposals, logger: silent } as Parameters<
        typeof runAssistantTurn
      >[0],
      {
        caller,
        messages: [{ role: 'user', content: 'Create a draft product called Linen Apron.' }],
      },
      (frame: unknown) =>
        void frames.push(frame as { event: string; data: Record<string, unknown> }),
    )

    const steps = frames.filter((f) => f.event === 'tool')
    expect(frames.filter((f) => f.event === 'proposal').map((f) => f.data)).toEqual([])
    expect(steps.length).toBe([CALL].length)
    expect(steps[0]?.data).toMatchObject({ name: CALL.name, title: CREATE.title, ok: false })
    expect(asked).toEqual([])
    expect(frames.at(-1)?.event).toBe('done')
    expect(scripted.requests).toBe(steps.length + 1)
  })
})
