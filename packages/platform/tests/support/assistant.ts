import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { NymbalConfig } from '@nymbalhq/config'
import type { Caller, ProposalView, ToolDefinition } from '@nymbalhq/types'
import {
  scriptViewOf,
  startAiStandIn,
  type AiScript,
  type AiStandIn,
  type AiWire,
  type ScriptTurn,
  type ScriptView,
} from '../../../../tests/support/ai-stand-in.js'
import { adminSession, type AdminSession, type Answer } from './audit-http.js'
import { serveKernel, type ServedKernel } from './http.js'
import { createKernel, type Kernel } from './kernel.js'
import { toolSurface } from './mcp.js'
import { openRaw, type RawReader } from './raw.js'
import { setEnv } from './settings.js'

// The merchant's assistant over HTTP: a kernel served on SQLite whose ai slot is a provider stand-in
// (tests/support/ai-stand-in.ts) in `script` mode, an admin signed in over HTTP, a turn POSTed to
// `/api/admin/assistant/turns` and its stream read frame by frame from `/api/admin/assistant/turns/:id/stream`. Nothing
// here knows how the loop, the routes or the ticket are built, beyond the ticket's wire form (an assistant ticket is an
// events ticket, `<base64url payload>.<base64url hmac-sha256>`, signed with HMAC-SHA256(jwtSecret, 'assistant-ticket')).

export const ASSISTANT = 'nymbal-assistant'
export const TURNS = '/api/admin/assistant/turns'

/** One frame of a stream: its event name and its parsed data. */
export interface Frame {
  event: string
  data: Record<string, unknown>
}

export interface Read {
  frames: Frame[]
  /** The server ended the stream (false when the reader stopped first). */
  ended: boolean
}

export interface TurnBody {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  page?: string
}

export interface Issued {
  turnId: string
  ticket: string
  expiresIn: number
}

export type Configure = (config: NymbalConfig) => NymbalConfig

export interface AssistantStore {
  kernel: Kernel
  served: ServedKernel
  baseUrl: string
  /** The provider the ai slot calls; null for a store whose ai slot is not on the stand-in. */
  standIn: AiStandIn
  /** The key the ai block carries. */
  key: string
  jwtSecret: string
  raw: RawReader
  admin: AdminSession
  /** The admin as the tool surface takes it, for a call made beside the assistant. */
  caller: Caller
  close(): Promise<void>
}

export interface StoreOptions {
  wire?: AiWire
  key?: string
  /** The ai block in place of the stand-in's (e.g. `{ provider: 'none' }`, or `custom` with appOptions). */
  ai?: Record<string, unknown>
  configure?: Configure
  appOptions?: Parameters<typeof createKernel>[0]['appOptions']
  logger?: Kernel['logger']
}

/** A served kernel whose ai slot is a `wire` stand-in in script mode (answering "Noted." until a test sets a script). */
export async function assistantStore(opts: StoreOptions = {}): Promise<AssistantStore> {
  const wire = opts.wire ?? 'anthropic'
  const key = opts.key ?? `sk-assistant-${randomBytes(18).toString('base64url')}`
  const jwtSecret = randomBytes(32).toString('base64url')
  const restoreEnv = setEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined })
  const standIn = await startAiStandIn(wire, 'script', () => ({ text: 'Noted.' }))
  const ai = opts.ai ?? {
    provider: wire,
    config:
      wire === 'anthropic'
        ? { baseUrl: standIn.url, apiKey: key }
        : { baseUrl: `${standIn.url}/v1`, model: 'gpt-stand-in', apiKey: key },
  }
  try {
    const kernel = await createKernel({
      dialect: 'sqlite',
      configure: (base) => {
        const config = {
          ...base,
          security: { ...base.security, auth: { ...base.security.auth, jwtSecret } },
          commerce: { ...base.commerce, ai },
        } as NymbalConfig
        return opts.configure === undefined ? config : opts.configure(config)
      },
      ...(opts.appOptions !== undefined && { appOptions: opts.appOptions }),
      ...(opts.logger !== undefined && { logger: opts.logger }),
    })
    const served = await serveKernel(kernel)
    const raw = openRaw('sqlite', kernel.target)
    const admin = await adminSession(kernel, served.baseUrl)
    return {
      kernel,
      served,
      baseUrl: served.baseUrl,
      standIn,
      key,
      jwtSecret,
      raw,
      admin,
      caller: { auth: { userId: admin.userId, roles: ['admin'] }, agent: { name: 'acceptance' } },
      async close() {
        try {
          await raw.close()
          await served.stop()
        } finally {
          await standIn.close()
          restoreEnv()
        }
      },
    }
  } catch (error) {
    await standIn.close()
    restoreEnv()
    throw error
  }
}

export const withAgents =
  (agents: Partial<NymbalConfig['agents']>): Configure =>
  (config) => ({ ...config, agents: { ...config.agents, ...agents } })

/** One user question as a turn body. */
export const ask = (content: string, page?: string): TurnBody => ({
  messages: [{ role: 'user', content }],
  ...(page !== undefined && { page }),
})

/** POST /api/admin/assistant/turns as `admin`. */
export function openTurn(
  admin: Pick<AdminSession, 'send'>,
  body: unknown,
): Promise<Answer<Issued>> {
  return admin.send<Issued>('POST', TURNS, body)
}

export const streamPath = (turnId: string, ticket?: string): string =>
  `${TURNS}/${encodeURIComponent(turnId)}/stream${ticket === undefined ? '' : `?ticket=${encodeURIComponent(ticket)}`}`

/**
 * Reads the server-sent frames at `path` until the server ends the stream, `until` answers true for a frame (the
 * reader then closes the connection), or `timeoutMs` passes (a stream still open then is an error).
 */
export async function readStream(
  baseUrl: string,
  path: string,
  until?: (frame: Frame, frames: Frame[]) => boolean,
  timeoutMs = 20_000,
): Promise<Read> {
  const abort = new AbortController()
  const timer = setTimeout(
    () => abort.abort(new Error(`${path}: still open after ${timeoutMs} ms`)),
    timeoutMs,
  )
  const frames: Frame[] = []
  try {
    const res = await fetch(new URL(path, baseUrl), {
      headers: { accept: 'text/event-stream' },
      signal: abort.signal,
    })
    if (res.body === null) throw new Error(`${path}: ${res.status} with no body`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event = /^event: ?(.*)$/m.exec(raw)?.[1] ?? 'message'
        const text = raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.replace(/^data: ?/, ''))
          .join('\n')
        if (text === '' && !/^event:/m.test(raw)) continue
        const frame: Frame = { event, data: text === '' ? {} : (JSON.parse(text) as Frame['data']) }
        frames.push(frame)
        if (until?.(frame, frames) === true) {
          abort.abort()
          await reader.cancel().catch(() => undefined)
          return { frames, ended: false }
        }
      }
      const { value, done } = await reader.read()
      if (done) return { frames, ended: true }
      buffer += decoder.decode(value, { stream: true })
    }
  } finally {
    clearTimeout(timer)
  }
}

/** POST /api/admin/assistant/turns as `admin`, which must answer 200: the turn's id and ticket. */
export async function issueTurn(admin: Pick<AdminSession, 'send'>, body: unknown): Promise<Issued> {
  const issued = await openTurn(admin, body)
  if (issued.status !== 200) {
    throw new Error(`POST ${TURNS}: ${issued.status} ${JSON.stringify(issued.body)}`)
  }
  return issued.body.data!
}

/** A turn POSTed and its stream read to the end: the frames, in order. */
export async function runTurn(
  store: Pick<AssistantStore, 'baseUrl' | 'admin'>,
  body: TurnBody,
): Promise<Frame[]> {
  const { turnId, ticket } = await issueTurn(store.admin, body)
  const read = await readStream(store.baseUrl, streamPath(turnId, ticket))
  if (!read.ended) throw new Error('the stream did not end')
  return read.frames
}

export const framesOf = (frames: Frame[], event: string): Frame[] =>
  frames.filter((f) => f.event === event)

/** Every recorded request to the stand-in, as the script read it. */
export function viewsOf(standIn: AiStandIn): ScriptView[] {
  return standIn.requests.map((r, i) => scriptViewOf(standIn.wire, r.body, i))
}

/** The trailing tool turns of a request: the results of the calls the turn before it made. */
export function toolTurns(view: ScriptView): ScriptTurn[] {
  const out: ScriptTurn[] = []
  for (let i = view.turns.length - 1; i >= 0 && view.turns[i]!.role === 'tool'; i--) {
    out.unshift(view.turns[i]!)
  }
  return out
}

/** A tool turn's content parsed, or `{}` when it is not JSON (a cut result). */
export function parsed(turn: ScriptTurn): Record<string, unknown> {
  try {
    const value = JSON.parse(turn.content) as unknown
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A script that answers the first request with `calls` and every later one with `text`. */
export function callsThen(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  text = 'Done.',
): AiScript {
  return (view) => (view.turns.at(-1)?.role === 'tool' ? { text } : { toolCalls: calls })
}

/** The admin's tools by name, as the tool surface lists them. */
export function adminTools(store: AssistantStore): Map<string, ToolDefinition> {
  const listed = toolSurface(store.kernel.app).list(store.caller) as ToolDefinition[]
  return new Map(listed.map((tool) => [tool.name, tool]))
}

/** Every proposal, newest first, read over HTTP. */
export async function proposalsOf(admin: AdminSession): Promise<ProposalView[]> {
  const res = await admin.send<{ items: ProposalView[] }>(
    'GET',
    '/api/admin/proposals?status=all&limit=200',
  )
  if (res.status !== 200) throw new Error(`GET /api/admin/proposals: ${res.status}`)
  return res.body.data!.items
}

/** The store's products, variants, orders, refunds and audit entries as committed: what a write would change. */
export async function storeState(raw: RawReader): Promise<Record<string, unknown>> {
  return {
    products: await raw.rows('SELECT * FROM products ORDER BY id'),
    variants: await raw.rows('SELECT * FROM variants ORDER BY id'),
    orders: await raw.rows('SELECT * FROM orders ORDER BY id'),
    refunds: await raw.rows('SELECT * FROM order_refunds ORDER BY id'),
    audit: await raw.count('audit_entries'),
  }
}

// ─── Tickets ────────────────────────────────────────────────────────────────────────────────────────────────────────

const ASSISTANT_TICKET_PURPOSE = 'assistant-ticket'

/** The payload a ticket carries (`<base64url JSON>.<signature>`). */
export function ticketPayload(ticket: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(ticket.split('.')[0]!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
}

/** A ticket for `payload` signed with `key`, as the ticket routes sign theirs. */
export function signTicket(payload: Record<string, unknown>, key: string | Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`
}

/** The key an assistant ticket is signed with: derived from the JWT secret for this purpose alone. */
export const assistantTicketKey = (jwtSecret: string): Buffer =>
  createHmac('sha256', jwtSecret).update(ASSISTANT_TICKET_PURPOSE).digest()

export const uuid = (): string => randomUUID()
