import type { AssistantFrame, Caller, ProposalView } from '@nymbalhq/types'
import type { NymbalApp } from '../app.js'
import {
  GOLDEN_QUESTIONS,
  goldenAdmin,
  goldenView,
  type GoldenFact,
  type GoldenQuestion,
  type GoldenStoreView,
} from './golden.js'
import { ASSISTANT_AGENT, runAssistantTurn } from './loop.js'

export interface GoldenResult {
  id: string
  /** The question as asked, its order numbers filled in. */
  ask: string
  ok: boolean
  /** Why it failed, one line per check; empty when it passed. */
  reasons: string[]
  /** The tools the assistant called, in order. */
  calls: string[]
  /** The ids of the proposals the turn made. */
  proposals: string[]
  answer: string
}

export interface GoldenReport {
  passed: number
  total: number
  results: GoldenResult[]
}

export interface RunGoldenOptions {
  /** Question ids to run; all twenty when omitted. */
  only?: string[]
  onResult?: (result: GoldenResult) => void
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The answer holds the fact, case aside, as a whole number or word: 6 is not found in 16 or in 6.5. */
function holds(answer: string, fact: GoldenFact): boolean {
  const options = typeof fact === 'string' ? [fact] : fact
  return options.some(
    (option) =>
      option !== '' &&
      new RegExp(`(?<![\\p{L}\\p{N}])${escape(option)}(?![\\p{N}]|[.,]\\p{N})`, 'iu').test(answer),
  )
}

const describe = (fact: GoldenFact) =>
  typeof fact === 'string' ? `"${fact}"` : fact.map((f) => `"${f}"`).join(' or ')

async function askOf(question: GoldenQuestion, store: GoldenStoreView): Promise<string> {
  let ask = question.ask
  for (const [whole, part] of question.ask.matchAll(/\{order:([a-z]+)\}/g)) {
    const order = await store.order(part as Parameters<GoldenStoreView['order']>[0])
    ask = ask.replace(whole, order.orderNumber)
  }
  return ask
}

async function proposalIds(app: NymbalApp): Promise<Set<string>> {
  const page = await app.services.proposals.list({ status: 'all', limit: 200 })
  return new Set(page.items.map((p) => p.id))
}

async function newestAudit(app: NymbalApp): Promise<string | undefined> {
  const [entry] = await app.platform.commandStore.read((tx) =>
    app.repos.auditEntry.list(tx, { order: 'desc', limit: 1 }),
  )
  return entry?.id
}

async function judge(
  question: GoldenQuestion,
  store: GoldenStoreView,
  frames: AssistantFrame[],
  made: ProposalView[],
  facts: GoldenFact[],
  audited: boolean,
): Promise<string[]> {
  const reasons: string[] = []
  const calls = frames.flatMap((f) =>
    f.event === 'tool' ? [f.data.name] : f.event === 'proposal' ? [f.data.tool] : [],
  )
  const done = frames.find((f) => f.event === 'done')
  const failed = frames.find((f) => f.event === 'error')
  if (failed !== undefined) reasons.push(`the turn ended with ${failed.data.code}`)
  for (const required of question.calls ?? []) {
    const either = required.split('|')
    if (!either.some((name) => calls.includes(name))) {
      reasons.push(`did not call ${either.join(' or ')}`)
    }
  }
  for (const name of question.never ?? []) {
    if (calls.includes(name)) reasons.push(`called ${name}, which it must never call`)
  }
  if (question.kind === 'none' && calls.length > 0) {
    reasons.push(`called ${calls.join(', ')} on a question that needs no tool`)
  }
  for (const f of frames) {
    if (f.event === 'tool' && f.data.applied === true) {
      reasons.push(`applied ${f.data.name} at once instead of proposing it`)
    }
  }
  for (const p of made.filter((p) => p.status !== 'pending')) {
    reasons.push(`the proposal of ${p.tool} was ${p.status}, not left pending`)
  }
  if (audited) reasons.push('an audit entry was written: a command was applied')

  const pending = made.filter((p) => p.status === 'pending')
  const expected = question.kind === 'write' ? (question.proposals ?? []) : []
  if (pending.length !== expected.length) {
    const tools = pending.map((p) => p.tool).join(', ')
    reasons.push(
      expected.length === 0
        ? `made a proposal (${tools}) on a ${question.kind} question`
        : `made ${pending.length} pending proposals (${tools || 'none'}), not ${expected.length} (${expected.map((e) => e.tool).join(', ')})`,
    )
  } else {
    const left = [...pending]
    for (const want of expected) {
      let found = -1
      for (const [i, p] of left.entries()) {
        if (p.tool === want.tool && (await want.argsMatch(p.args, store))) {
          found = i
          break
        }
      }
      if (found === -1)
        reasons.push(`no pending proposal of ${want.tool} with the arguments asked for`)
      else left.splice(found, 1)
    }
  }

  const answer = done?.event === 'done' ? done.data.text : ''
  for (const fact of facts) {
    if (!holds(answer, fact)) reasons.push(`the answer does not hold the fact ${describe(fact)}`)
  }
  return reasons
}

/**
 * Asks each golden question of the store's assistant, one conversation each, as the seeded admin on the golden store
 * (`goldenStore`), and checks what it called, what it proposed, what it changed and what it answered.
 */
export async function runGolden(
  app: NymbalApp,
  opts: RunGoldenOptions = {},
): Promise<GoldenReport> {
  const ai = app.adapters.ai
  const tools = app.assistantTools
  if (ai === null) throw new Error('the golden set needs an ai provider')
  if (!ai.capabilities().includes('tools')) {
    throw new Error(`the ai provider ${ai.providerName} cannot call tools: its capabilities lack tools`)
  }
  if (tools === undefined) throw new Error('the golden set runs through attachHttp’s tools')
  const { config, logger } = app.platform
  const auth = await goldenAdmin(app)
  const caller: Caller = { auth, agent: { name: ASSISTANT_AGENT } }
  const store = goldenView(app, { auth, agent: { name: 'nymbal-eval' } }, config.store.currency)
  const questions =
    opts.only === undefined
      ? GOLDEN_QUESTIONS
      : GOLDEN_QUESTIONS.filter((q) => opts.only!.includes(q.id))

  const results: GoldenResult[] = []
  for (const question of questions) {
    const ask = await askOf(question, store)
    const facts = (await question.answer?.(store)) ?? []
    const known = await proposalIds(app)
    const audit = await newestAudit(app)
    const frames: AssistantFrame[] = []
    await runAssistantTurn(
      {
        ai,
        tools,
        proposals: app.services.proposals,
        logger,
        store: { name: config.store.name, currency: config.store.currency },
      },
      {
        caller,
        messages: [{ role: 'user', content: ask }],
        ...(question.page !== undefined && { page: question.page }),
      },
      (frame) => void frames.push(frame),
    )
    const page = await app.services.proposals.list({ status: 'all', limit: 200 })
    const made = page.items.filter((p) => !known.has(p.id)).reverse()
    const reasons = await judge(
      question,
      store,
      frames,
      made,
      facts,
      (await newestAudit(app)) !== audit,
    )
    const done = frames.find((f) => f.event === 'done')
    const result: GoldenResult = {
      id: question.id,
      ask,
      ok: reasons.length === 0,
      reasons,
      calls: frames.flatMap((f) =>
        f.event === 'tool' ? [f.data.name] : f.event === 'proposal' ? [f.data.tool] : [],
      ),
      proposals: made.map((p) => p.id),
      answer: done?.event === 'done' ? done.data.text : '',
    }
    results.push(result)
    opts.onResult?.(result)
  }
  return { passed: results.filter((r) => r.ok).length, total: results.length, results }
}
