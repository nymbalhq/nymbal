import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Caller, ProposalView } from '@nymbalhq/types'
import type { ScriptTurn } from '../../../../tests/support/ai-stand-in.js'
import { assistantTools as offeredBy } from '../../src/assistant/loop.js'
import {
  ASSISTANT,
  ask,
  assistantStore,
  callsThen,
  framesOf,
  parsed,
  proposalsOf,
  runTurn,
  toolTurns,
  viewsOf,
  withAgents,
  type AssistantStore,
} from '../support/assistant.js'
import { seedVariant } from '../support/kernel.js'
import { listedNames, toolSurface } from '../support/mcp.js'

// The assistant's bulk-destructive policy on a served store on SQLite, the ai slot on a provider stand-in in `script`
// mode: the scripted model asks for the calls each case needs, and the proposals, the products, the frames and the
// requests the model received are read back.
// - AC-4: "Delete every product." on a store of 24 leaves three pending deletions and 21 refusals that invite no
//   retry; under agents.autoApprove [product.delete] three products go and nine stay.
// - AC-5: the store's MCP tool surface keeps no such cap: five deletions there are five pending rows.
// - AC-6: the settings list is not offered to the assistant, and MCP still lists it.

/** A coaching word: text that invites the model or the merchant to try again. */
const COACHING = /\b(again|retry|later|rest|ask|another|new message)\b/i

const BULK_REFUSED = 'assistant.bulk_refused'

type Call = { name: string; args: Record<string, unknown> }

const del = (id: string): Call => ({ name: 'admin_products_delete', args: { id } })

/** A script answering request i with replies[i]'s calls, and every later request with `text`. */
const replies =
  (calls: Call[][], text = 'Done.'): NonNullable<AssistantStore['standIn']['script']> =>
  (view) => {
    const reply = calls[view.index]
    return reply === undefined ? { text } : { toolCalls: reply }
  }

/** `n` active products, each one variant, with every event they published delivered: their ids. */
async function products(store: AssistantStore, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push((await seedVariant(store.kernel, 5)).productId)
  await store.kernel.app.relay.drain()
  return ids
}

/** The proposals that exist now and did not in `known`, oldest first. */
async function freshSince(store: AssistantStore, known: ProposalView[]): Promise<ProposalView[]> {
  const ids = new Set(known.map((p) => p.id))
  return (await proposalsOf(store.admin)).filter((p) => !ids.has(p.id)).reverse()
}

/** GET /api/admin/products/:id's status for each id, in order. */
async function productStatuses(store: AssistantStore, ids: string[]): Promise<number[]> {
  const out: number[] = []
  for (const id of ids)
    out.push((await store.admin.send('GET', `/api/admin/products/${id}`)).status)
  return out
}

/** A tool turn as the outcome the model read: `proposed`, or the code it was refused or failed with. */
const outcomeOf = (turn: ScriptTurn): string =>
  parsed(turn)['status'] === 'proposed' ? 'proposed' : String(parsed(turn)['code'])

/** The answers the loop wrote itself: an error result whose code is the assistant's. */
const loopRefusals = (turns: ScriptTurn[]): ScriptTurn[] =>
  turns.filter((t) => t.isError === true && String(parsed(t)['code']).startsWith('assistant.'))

const adminCaller = (store: AssistantStore): Caller => ({
  auth: { userId: store.admin.userId, roles: ['admin'] },
  agent: { name: ASSISTANT },
})

const row = (p: ProposalView) => [p.command, p.status, p.proposer.agent.name]

let main: AssistantStore
let approving: AssistantStore

beforeAll(async () => {
  main = await assistantStore()
  approving = await assistantStore({ configure: withAgents({ autoApprove: ['product.delete'] }) })
}, 60_000)

afterAll(async () => {
  await main?.close()
  await approving?.close()
})

describe('AC-4: "Delete every product." makes at most three deletions', () => {
  it('AC-4: on a store of 24 products, a list then 24 admin_products_delete over replies of 10, 10 and 4 leave exactly three pending product.delete rows by nymbal-assistant, three proposal frames that done names, 21 assistant.bulk_refused answers and tool frames, every product still there, and no loop-written refusal that invites a retry', async () => {
    const ids = await products(main, 24)
    const known = await proposalsOf(main.admin)
    main.standIn.reset()
    main.standIn.script = replies([
      [{ name: 'admin_products_list', args: {} }],
      ids.slice(0, 10).map(del),
      ids.slice(10, 20).map(del),
      ids.slice(20).map(del),
    ])

    const frames = await runTurn(main, ask('Delete every product.'))

    const fresh = await freshSince(main, known)
    expect(fresh.map(row)).toEqual(
      ids.slice(0, 3).map(() => ['product.delete', 'pending', ASSISTANT]),
    )
    expect(fresh.map((p) => String(p.args['id'])).sort()).toEqual(ids.slice(0, 3).sort())
    const views = viewsOf(main.standIn)
    const deletions = [2, 3, 4].flatMap((i) => toolTurns(views[i]!))
    expect(deletions.map(outcomeOf)).toEqual([
      ...ids.slice(0, 3).map(() => 'proposed'),
      ...ids.slice(3).map(() => BULK_REFUSED),
    ])
    const cards = framesOf(frames, 'proposal').map((f) => f.data['id'] as string)
    expect([...cards].sort()).toEqual(fresh.map((p) => p.id).sort())
    expect(framesOf(frames, 'done').map((f) => f.data['proposals'])).toEqual([cards])
    expect(
      framesOf(frames, 'tool').filter(
        (f) => f.data['ok'] === false && f.data['code'] === BULK_REFUSED,
      ).length,
    ).toBe(ids.length - fresh.length)
    expect(await productStatuses(main, ids)).toEqual(ids.map(() => 200))
    const refusals = loopRefusals(views.flatMap((v) => toolTurns(v)))
    expect(refusals.length).toBe(ids.length - fresh.length)
    expect(refusals.filter((t) => COACHING.test(t.content)).map((t) => t.content)).toEqual([])
  }, 120_000)

  it('AC-4: under agents.autoApprove [product.delete], 12 deletions in the first reply apply three: three applied product.delete rows by nymbal-assistant and no pending one, three products gone and nine still there', async () => {
    const ids = await products(approving, 12)
    const known = await proposalsOf(approving.admin)
    approving.standIn.reset()
    approving.standIn.script = callsThen(ids.map(del), 'Deleted three.')

    await runTurn(approving, ask('Delete every product.'))

    const fresh = await freshSince(approving, known)
    expect(fresh.map(row)).toEqual(
      ids.slice(0, 3).map(() => ['product.delete', 'applied', ASSISTANT]),
    )
    expect(await productStatuses(approving, ids)).toEqual([
      ...ids.slice(0, 3).map(() => 404),
      ...ids.slice(3).map(() => 200),
    ])
  }, 120_000)
})

describe('AC-5: the store’s MCP tool surface keeps no per-turn cap', () => {
  it('AC-5: five admin_products_delete calls through the MCP tool surface, by an agent other than nymbal-assistant, leave five pending rows and none is answered assistant.bulk_refused, while the same five asked of the assistant in one reply leave three', async () => {
    const ids = await products(main, 5)
    const surface = toolSurface(main.kernel.app)
    const beforeMcp = await proposalsOf(main.admin)
    const answers = []
    for (const id of ids)
      answers.push(await surface.call('admin_products_delete', { id }, main.caller))
    const viaMcp = await freshSince(main, beforeMcp)

    const beforeTurn = await proposalsOf(main.admin)
    main.standIn.reset()
    main.standIn.script = callsThen(ids.map(del))
    await runTurn(main, ask('Delete these five products.'))
    const viaAssistant = await freshSince(main, beforeTurn)

    expect(
      answers.map((a) => [
        a.isError === true,
        a.structuredContent?.['status'],
        a.structuredContent?.['code'],
      ]),
    ).toEqual(ids.map(() => [false, 'proposed', undefined]))
    expect(viaMcp.map(row)).toEqual(
      ids.map(() => ['product.delete', 'pending', main.caller.agent.name]),
    )
    expect([viaMcp.length, viaAssistant.length]).toEqual([ids.length, 3])
  }, 60_000)
})

describe('AC-6: the settings list is kept from the assistant, not from MCP', () => {
  it('AC-6: the assistant is offered no admin_settings_* tool while the MCP listing still holds admin_settings_list, and a scripted admin_settings_list call is answered is_error tool.unknown with a tool frame of that code', async () => {
    const offered = offeredBy(main.kernel.app.assistantTools!.list(adminCaller(main))).map(
      (t) => t.name,
    )
    const listed = await listedNames(toolSurface(main.kernel.app), main.caller)
    main.standIn.reset()
    main.standIn.script = callsThen([{ name: 'admin_settings_list', args: {} }])

    const frames = await runTurn(main, ask('Which payments provider is set?'))

    const views = viewsOf(main.standIn)
    const settings = (names: string[]) => names.filter((n) => n.startsWith('admin_settings_'))
    expect(settings(offered)).toEqual([])
    expect(settings(views[0]!.tools)).toEqual([])
    expect(settings(listed)).toEqual(['admin_settings_list'])
    expect(toolTurns(views[1]!).map((t) => [t.isError, parsed(t)['code']])).toEqual([
      [true, 'tool.unknown'],
    ])
    expect(
      framesOf(frames, 'tool').map((f) => [f.data['name'], f.data['ok'], f.data['code']]),
    ).toEqual([['admin_settings_list', false, 'tool.unknown']])
  }, 60_000)
})
