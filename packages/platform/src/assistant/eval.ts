import type {
  AiAdapter,
  AssistantFrame,
  Caller,
  ChatUsage,
  ProposalView,
  ToolSurface,
} from '@nymbalhq/types'
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

/** One call the model made, as the store's tools received it. */
export interface GoldenCall {
  name: string
  /** `command` for any write (a session write too); `unknown` for a name the store's tools lack. */
  kind: 'read' | 'command' | 'unknown'
  /** The arguments the tools received, placeholders revealed; null for a call that never reached them. */
  args: Record<string, unknown> | null
  /** `ok`, `proposed`, `applied`, or the error code. */
  outcome: string
}

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
  /** Every call, in order, with its kind, arguments and outcome. */
  trace: GoldenCall[]
}

/** The tokens of every request a run made, as the provider reported them; the cache counts are 0 where it gave none. */
export type GoldenUsage = Required<ChatUsage>

export interface GoldenReport {
  passed: number
  total: number
  results: GoldenResult[]
  /** The models the provider said answered, in the order first met. */
  models: string[]
  usage: GoldenUsage
}

/** Several runs of the golden set, each question judged by majority. */
export interface GoldenTally {
  runs: number
  /** The questions that are `ok`. */
  passed: number
  total: number
  /** In the first report's order: how many runs passed each, and whether more than half did. */
  questions: Array<{ id: string; passed: number; ok: boolean }>
}

/** The provider's error codes that every later request would meet as well: a key, a balance or a request it refuses. */
const PERMANENT_ADAPTER_ERRORS = new Set([
  'adapter.auth_failed',
  'adapter.invalid_request',
  'adapter.quota_exceeded',
])

/** The AI provider refused a question's turn in a way no later question would escape: the run stops there. */
export class GoldenAdapterError extends Error {
  readonly question: string
  readonly code: string
  constructor(question: string, code: string, message: string) {
    super(`the ai provider failed on ${question}: ${code}: ${message}`)
    this.name = 'GoldenAdapterError'
    this.question = question
    this.code = code
  }
}

export function tallyGolden(reports: readonly GoldenReport[]): GoldenTally {
  const ids = reports[0]?.results.map((r) => r.id) ?? []
  const questions = ids.map((id) => {
    const passed = reports.filter((report) =>
      report.results.some((r) => r.id === id && r.ok),
    ).length
    return { id, passed, ok: passed * 2 > reports.length }
  })
  return {
    runs: reports.length,
    passed: questions.filter((q) => q.ok).length,
    total: questions.length,
    questions,
  }
}

/** `ai` with each model the provider reports answering added to `models`, and each answer's tokens to `usage`. */
function reporting(ai: AiAdapter, models: Set<string>, usage: GoldenUsage): AiAdapter {
  const stream = ai.chatStream?.bind(ai)
  const note = (result: { model: string; usage: ChatUsage }) => {
    models.add(result.model)
    usage.inputTokens += result.usage.inputTokens
    usage.outputTokens += result.usage.outputTokens
    usage.cacheReadTokens += result.usage.cacheReadTokens ?? 0
    usage.cacheWriteTokens += result.usage.cacheWriteTokens ?? 0
  }
  const reporting: Partial<AiAdapter> = {
    async chat(messages, opts) {
      const result = await ai.chat(messages, opts)
      note(result)
      return result
    },
    ...(stream !== undefined && {
      async *chatStream(messages, opts) {
        for await (const event of stream(messages, opts)) {
          if (event.type === 'done') note(event.result)
          yield event
        }
      },
    }),
  }
  return Object.assign(Object.create(ai) as AiAdapter, reporting)
}

export interface RunGoldenOptions {
  /** Question ids to run; all of them when omitted. */
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

/** The loop's own read of the page the panel is open on; it never reaches the store's tools. */
const PAGE_TOOL_NAME = 'assistant_page'

/** The surface the turn calls, noting the arguments of each call against the frame that call will emit. */
function recording(tools: ToolSurface, frames: readonly AssistantFrame[]) {
  const received = new Map<number, Record<string, unknown>>()
  const surface: ToolSurface = {
    list: (caller) => tools.list(caller),
    call: (name, args, caller, options) => {
      // The loop emits nothing between a call to the tools and that call's own frame.
      received.set(frames.length, { ...(args as Record<string, unknown>) })
      return tools.call(name, args, caller, options)
    },
  }
  return { surface, received }
}

function traceOf(
  frames: readonly AssistantFrame[],
  received: ReadonlyMap<number, Record<string, unknown>>,
  kinds: ReadonlyMap<string, GoldenCall['kind']>,
): GoldenCall[] {
  return frames.flatMap((f, i): GoldenCall[] => {
    if (f.event !== 'tool' && f.event !== 'proposal') return []
    const name = f.event === 'tool' ? f.data.name : f.data.tool
    const outcome =
      f.event === 'proposal'
        ? 'proposed'
        : f.data.applied === true
          ? 'applied'
          : f.data.ok
            ? 'ok'
            : (f.data.code ?? 'error')
    return [
      {
        name,
        kind: kinds.get(name) ?? (name === PAGE_TOOL_NAME ? 'read' : 'unknown'),
        args: received.get(i) ?? null,
        outcome,
      },
    ]
  })
}

async function judge(
  question: GoldenQuestion,
  store: GoldenStoreView,
  frames: AssistantFrame[],
  trace: GoldenCall[],
  made: ProposalView[],
  facts: GoldenFact[],
  audited: boolean,
): Promise<string[]> {
  const reasons: string[] = []
  const calls = trace.map((c) => c.name)
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
  const writes = trace.filter((c) => c.kind !== 'read').map((c) => c.name)
  if (question.kind === 'none' && writes.length > 0) {
    reasons.push(`called ${writes.join(', ')} on a question that needs no write`)
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
  const provider = app.adapters.ai
  const tools = app.assistantTools
  if (provider === null) throw new Error('the golden set needs an ai provider')
  if (!provider.capabilities().includes('tools')) {
    throw new Error(
      `the ai provider ${provider.providerName} cannot call tools: its capabilities lack tools`,
    )
  }
  const models = new Set<string>()
  const usage: GoldenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  const ai = reporting(provider, models, usage)
  if (tools === undefined) throw new Error('the golden set runs through attachHttp’s tools')
  const { config, logger } = app.platform
  const auth = await goldenAdmin(app)
  const caller: Caller = { auth, agent: { name: ASSISTANT_AGENT } }
  const kinds = new Map(
    tools
      .list(caller)
      .map((t): [string, GoldenCall['kind']] => [t.name, t.kind === 'read' ? 'read' : 'command']),
  )
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
    const { surface, received } = recording(tools, frames)
    await runAssistantTurn(
      {
        ai,
        tools: surface,
        proposals: app.services.proposals,
        logger,
        store: {
          name: config.store.name,
          currency: config.store.currency,
          timezone: config.store.timezone,
        },
        customerData: config.agents.assistant.customerData,
        mask: config.agents.assistant.mask,
      },
      {
        caller,
        messages: [{ role: 'user', content: ask }],
        ...(question.page !== undefined && { page: question.page }),
      },
      (frame) => void frames.push(frame),
    )
    const failed = frames.find((f) => f.event === 'error')
    if (failed?.event === 'error' && PERMANENT_ADAPTER_ERRORS.has(failed.data.code)) {
      throw new GoldenAdapterError(question.id, failed.data.code, failed.data.message)
    }
    const page = await app.services.proposals.list({ status: 'all', limit: 200 })
    const made = page.items.filter((p) => !known.has(p.id)).reverse()
    const trace = traceOf(frames, received, kinds)
    const reasons = await judge(
      question,
      store,
      frames,
      trace,
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
      calls: trace.map((c) => c.name),
      proposals: made.map((p) => p.id),
      answer: done?.event === 'done' ? done.data.text : '',
      trace,
    }
    results.push(result)
    opts.onResult?.(result)
  }
  return {
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    results,
    models: [...models],
    usage,
  }
}
