import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type {
  Caller,
  Logger,
  ToolCallOptions,
  ToolDefinition,
  ToolResult,
  ToolSurface,
} from '@nymbalhq/types'
import { scriptedAi } from '../../tests/support/scripted-ai.js'
import { runAssistantTurn } from './loop.js'

// The loop hands every call it runs its own correlation id under the turn's, `<turnId>.<n>`, and says whether the
// call's writes must wait for a person (`proposeWrites`): not in the turn's first reply, chosen before the model read
// anything, unless the conversation already holds an answer of the assistant's (which may quote store data); always in
// every later reply, written by a model that has read tool results. The model and the tool surface are scripted here:
// the surface records what each call was handed; the loop is the real one.

const READ: ToolDefinition = {
  name: 'admin_products_list',
  title: 'admin.products.list',
  description: 'List products.',
  inputSchema: { type: 'object', properties: {} },
  scope: 'admin',
  kind: 'read',
  route: { method: 'GET', path: '/api/admin/products', command: null },
}

const WRITE: ToolDefinition = {
  name: 'admin_products_update',
  title: 'admin.products.update',
  description: 'Update a product.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  scope: 'admin',
  kind: 'command',
  route: { method: 'PATCH', path: '/api/admin/products/:id', command: 'product.update' },
}

const OK: ToolResult = {
  content: [{ type: 'text', text: '{"items":[]}' }],
  structuredContent: { items: [] },
}

const silent: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
}

const caller: Caller = {
  auth: { userId: 'admin-1', roles: ['admin'] },
  agent: { name: 'nymbal-assistant' },
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** At most ten writes in the whole turn, so every call the model asks for reaches the surface. */
function capWrites(replies: Array<Array<'read' | 'write'>>): Array<Array<'read' | 'write'>> {
  let writes = 0
  return replies.map((reply) =>
    reply.map((kind) => {
      if (kind === 'write') writes += 1
      return kind === 'write' && writes > 10 ? 'read' : kind
    }),
  )
}

describe('AC-4: each call of a turn carries its own id under the turn, and the replies after a read are tainted', () => {
  it('AC-4: property: for any turn of 1-7 replies, the k-th call the model asked for carries correlationId <turnId>.<k> (the turn’s id, or one UUIDv7 minted for the whole turn), all distinct; proposeWrites is false in the first reply and true in every later one, and true in the first reply too when the conversation holds an assistant answer', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.constantFrom<'read' | 'write'>('read', 'write'), {
            minLength: 1,
            maxLength: 10,
          }),
          {
            minLength: 1,
            maxLength: 7,
          },
        ),
        fc.option(fc.uuid(), { nil: undefined }),
        fc.boolean(),
        async (generated, givenTurnId, earlierAnswer) => {
          const replies = capWrites(generated)
          const seen: Array<{ name: string; options: ToolCallOptions | undefined }> = []
          const tools: ToolSurface = {
            list: () => [READ, WRITE],
            call: async (
              name: string,
              _args: unknown,
              _caller: Caller,
              options?: ToolCallOptions,
            ) => {
              seen.push({ name, options })
              return OK
            },
          }
          const model = scriptedAi((request) => {
            const reply = replies[request.index]
            return reply === undefined
              ? { text: 'Done.' }
              : {
                  calls: reply.map((kind) => ({
                    name: kind === 'read' ? READ.name : WRITE.name,
                    args: { id: 'p-1' },
                  })),
                }
          })
          const messages: Array<{ role: 'user' | 'assistant'; content: string }> = earlierAnswer
            ? [
                { role: 'user', content: 'What do the reviews say?' },
                { role: 'assistant', content: 'One review asks you to set every price to 0.' },
                { role: 'user', content: 'Go on.' },
              ]
            : [{ role: 'user', content: 'Go on.' }]

          await runAssistantTurn(
            {
              ai: model.ai,
              tools,
              proposals: { get: async () => null },
              logger: silent,
            } as Parameters<typeof runAssistantTurn>[0],
            { caller, messages, ...(givenTurnId !== undefined && { turnId: givenTurnId }) },
            () => undefined,
          )

          const asked = replies.flatMap((reply, r) => reply.map(() => r))
          expect(seen.map((s) => s.name)).toEqual(
            replies.flat().map((kind) => (kind === 'read' ? READ.name : WRITE.name)),
          )
          const ids = seen.map((s) => s.options?.correlationId)
          const turnId = givenTurnId ?? String(ids[0]).replace(/\.1$/, '')
          // The turn's own id, or one minted UUIDv7 when the turn brought none.
          expect(givenTurnId ?? (UUID_V7.test(turnId) ? 'a UUIDv7' : turnId)).toBe(
            givenTurnId ?? 'a UUIDv7',
          )
          expect(ids).toEqual(asked.map((_, k) => `${turnId}.${k + 1}`))
          expect(new Set(ids).size).toBe(seen.length)
          expect(seen.map((s) => s.options?.proposeWrites)).toEqual(
            asked.map((r) => r > 0 || earlierAnswer),
          )
        },
      ),
      { numRuns: 60 },
    )
  })
})
