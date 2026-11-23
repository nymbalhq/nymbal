import { randomUUID } from 'node:crypto'
import type { NymbalConfig } from '@nymbalhq/config'
import type {
  AiAdapter,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatStreamEvent,
  ChatToolCall,
  InsightSeverity,
  InsightView,
} from '@nymbalhq/types'
import { guidanceDeps, type GuidanceDeps } from '../../src/night-shift/guidance.js'
import { adminSession, type AdminSession } from './audit-http.js'
import { serveKernel, type ServedKernel } from './http.js'
import type { createKernel, Kernel } from './kernel.js'
import {
  DATA_DAY,
  NOW,
  RUN_DAY,
  addDays,
  applyFigures,
  noonOf,
  searchedOn,
  seedDeadEvent,
} from './night-shift.js'
import { openRaw, type RawReader } from './raw.js'
import { unaudited } from './write-audit.js'

// What the guidance tests share: a provider stand-in in-process that answers each request from a script and keeps
// every request as it was sent (a turn opens with a request holding the one user message, its prompt), guided
// insights seeded through the repository with the severity and age a test orders them by, the two guidance columns as
// a second connection reads them, and the brief as the admin route answers it.

export interface GuidanceRequest {
  index: number
  messages: ChatMessage[]
  tools: string[]
}

/** A reply, or a provider that fails the request: `throw` at once, `hang` until the turn aborts it. */
export type GuidanceReply =
  | { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> }
  | 'throw'
  | 'hang'

export interface GuidanceModel {
  ai: AiAdapter
  requests: GuidanceRequest[]
  /** The requests that opened a turn, each with its prompt: the one user message it carries. */
  turns(): Array<{ request: GuidanceRequest; prompt: string }>
}

export function guidanceModel(
  script: (request: GuidanceRequest) => GuidanceReply,
  capabilities: string[] = ['complete', 'chat', 'tools', 'stream'],
): GuidanceModel {
  const requests: GuidanceRequest[] = []
  let ids = 0
  const answer = async (
    messages: readonly ChatMessage[],
    opts?: ChatOptions,
  ): Promise<ChatResult> => {
    const request: GuidanceRequest = {
      index: requests.length,
      messages: messages.map((m) => ({ ...m })),
      tools: (opts?.tools ?? []).map((t) => t.name),
    }
    requests.push(request)
    const reply = script(request)
    if (reply === 'throw') throw new Error('the provider is down')
    if (reply === 'hang') {
      return new Promise<ChatResult>((_, reject) => {
        const signal = opts?.signal
        if (signal?.aborted === true) reject(new Error('aborted'))
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    const toolCalls: ChatToolCall[] = (reply.calls ?? []).map((c) => ({
      id: `call_${(ids += 1)}`,
      name: c.name,
      args: c.args,
    }))
    return {
      text: reply.text ?? '',
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end',
      usage: { inputTokens: 3, outputTokens: 2 },
      model: 'scripted',
      toolCalls,
    }
  }
  const ai = {
    kind: 'ai',
    providerName: 'scripted',
    capabilities: () => capabilities,
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
    chat: answer,
    async *chatStream(
      messages: readonly ChatMessage[],
      opts?: ChatOptions,
    ): AsyncIterable<ChatStreamEvent> {
      const result = await answer(messages, opts)
      if (result.text !== '') yield { type: 'text', delta: result.text }
      for (const call of result.toolCalls) yield { type: 'tool_call', call }
      yield { type: 'done', result }
    },
  } as unknown as AiAdapter
  return {
    ai,
    requests,
    turns: () =>
      requests.flatMap((request) => {
        const [first, ...rest] = request.messages
        return rest.length === 0 && first?.role === 'user'
          ? [{ request, prompt: first.content }]
          : []
      }),
  }
}

/** The `tool` messages a request carries: what the model has read so far this turn. */
export function toolMessages(request: GuidanceRequest): string[] {
  return request.messages.flatMap((m) => (m.role === 'tool' ? [m.content] : []))
}

/** Whether a request is the turn's first, before any tool was answered. */
export const opensTurn = (request: GuidanceRequest): boolean =>
  !request.messages.some((m) => m.role === 'tool')

/** The guidance deps over a kernel served over HTTP, reading the assistant's tools from it. */
export function depsFor(
  k: Pick<Kernel, 'store' | 'repos' | 'app' | 'config' | 'logger'>,
  ai: AiAdapter,
  over: { config?: NymbalConfig; maxInsightsPerNight?: number } = {},
): GuidanceDeps {
  return guidanceDeps({
    store: k.store,
    insights: k.repos.insight,
    ai,
    tools: () => k.app.assistantTools,
    config: over.config ?? k.config,
    logger: k.logger,
    ...(over.maxInsightsPerNight !== undefined && {
      maxInsightsPerNight: over.maxInsightsPerNight,
    }),
  })
}

export interface GuidedSeed {
  job: string
  subject: string
  runDay: string
  severity: InsightSeverity
  summary: string
  facts?: Record<string, string | number | null>
  /** When the night wrote it; its age orders insights of one severity. */
  createdAt: Date
  id?: string
}

/** One open insight as a night left it, through the repository; its id. */
export async function seedGuided(
  k: Pick<Kernel, 'store' | 'repos'>,
  seed: GuidedSeed,
): Promise<string> {
  const id = seed.id ?? randomUUID()
  await unaudited(() =>
    k.store.transaction(async (tx) => {
      await k.repos.insight.insert(tx, {
        id,
        job: seed.job,
        subject: seed.subject,
        runDay: seed.runDay,
        dataDay: addDays(seed.runDay, -1),
        status: 'open',
        severity: seed.severity,
        summary: seed.summary,
        facts: seed.facts ?? {},
        createdAt: seed.createdAt,
        dismissedAt: null,
      })
    }),
  )
  return id
}

export interface GuidanceColumns {
  guidance: string | null
  status: string | null
}

/** Each insight's `guidance` and `guidance_status` as a second connection reads them, by id. */
export async function guidanceColumns(raw: RawReader): Promise<Map<string, GuidanceColumns>> {
  const rows = await raw.rows<Record<string, unknown>>(
    'SELECT id, guidance, guidance_status FROM insights',
  )
  return new Map(
    rows.map((r) => [
      String(r['id']),
      {
        guidance: r['guidance'] == null ? null : String(r['guidance']),
        status: r['guidance_status'] == null ? null : String(r['guidance_status']),
      },
    ]),
  )
}

/** The open list as `GET /api/admin/insights` answers it, by id. */
export async function briefOf(admin: AdminSession): Promise<Map<string, InsightView>> {
  const res = await admin.send<{ items: InsightView[] }>('GET', '/api/admin/insights')
  if (res.status !== 200) {
    throw new Error(`GET /api/admin/insights: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return new Map(res.body.data!.items.map((item) => [item.id, item]))
}

/** The job a turn's prompt is about: the one seeded summary it quotes. */
export function summaryIn(prompt: string, summaries: readonly string[]): string | undefined {
  const quoted = summaries.filter((s) => prompt.includes(s))
  return quoted.length === 1 ? quoted[0] : undefined
}

// ---- an app on its own runner's tick --------------------------------------------------------------------------

/** The runner's interval in the app tests: a tick happens only when a test advances the faked interval this far. */
export const TICK_MS = 1_000

export type StartKernel = (opts: {
  configure: (config: NymbalConfig) => NymbalConfig
  appOptions: NonNullable<Parameters<typeof createKernel>[0]['appOptions']>
}) => Promise<Kernel>

export interface TickingApp {
  k: Kernel
  served: ServedKernel
  raw: RawReader
  admin: AdminSession
  close(): Promise<void>
}

/**
 * An app built by createApp with the night shift on at 03:00 and its clock at NOW, its ai slot `custom` on `ai` (or
 * `none`), served over HTTP so the assistant's tools exist. Its runner ticks on a faked interval: install
 * `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` before calling.
 */
export async function tickingApp(start: StartKernel, ai: AiAdapter | 'none'): Promise<TickingApp> {
  const k = await start({
    configure: (config) =>
      ({
        ...config,
        nightShift: { ...config.nightShift, enabled: true, at: '03:00' },
        commerce: { ...config.commerce, ai: { provider: ai === 'none' ? 'none' : 'custom' } },
      }) as NymbalConfig,
    appOptions: {
      nightShift: { intervalMs: TICK_MS, now: () => NOW },
      relay: { intervalMs: 3_600_000 },
      ...(ai !== 'none' && { adapters: { ai } }),
    },
  })
  const served = await serveKernel(k)
  const raw = openRaw(k.dialect, k.target)
  const admin = await adminSession(k, served.baseUrl)
  return {
    k,
    served,
    raw,
    admin,
    async close() {
      await raw.close()
      await served.stop()
    },
  }
}

export interface NightFixture {
  /** A quote-free part of each insight's sentence a prompt about it carries, by job. */
  markers: Record<string, string>
}

/** The longest part of a sentence between its quotes: what a prompt quoting it holds however it escapes them. */
export function markerOf(summary: string): string {
  return summary.split('"').reduce((a, b) => (b.length > a.length ? b : a), '')
}

export const NIGHT_SEEDS = {
  demand: { subject: 'orders', severity: 'warning', summary: 'Paid orders fell well below the usual week.' },
  'refund-rate': { subject: 'store', severity: 'critical', summary: 'Refunds rose far above the usual rate.' },
  'stock-runway': { subject: 'variant:lamp', severity: 'warning', summary: 'The brass lamp runs out within the week.' },
  'role.content': { subject: 'run', severity: 'info', summary: 'The content role drafted copy for the new totes.' },
} as const satisfies Record<string, { subject: string; severity: InsightSeverity; summary: string }>

/**
 * The night's inputs: a term searched three times yesterday with no hit and a dead event (so the night itself writes
 * a zero-result-term and an operator-health insight), and open insights of tonight's run day for demand, refund-rate,
 * stock-runway and the content role, as replicas of the night would have left them.
 */
export async function seedNight(k: Kernel): Promise<void> {
  await applyFigures(k, [searchedOn(DATA_DAY, 'wool socks', 3)])
  await seedDeadEvent(k)
  for (const [job, seed] of Object.entries(NIGHT_SEEDS)) {
    await seedGuided(k, { job, ...seed, runDay: RUN_DAY, createdAt: noonOf(DATA_DAY) })
  }
}
