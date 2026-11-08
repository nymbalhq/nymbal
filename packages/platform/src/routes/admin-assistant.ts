import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import type { NymbalConfig } from '@nymbalhq/config'
import type {
  AiAdapter,
  AssistantTurnIssued,
  DocumentStoreAdapter,
  HttpAdapter,
  Role,
  StreamContext,
  ToolSurface,
} from '@nymbalhq/types'
import { ASSISTANT_AGENT, runAssistantTurn, type AssistantTurn } from '../assistant/loop.js'
import type { ProposalService } from '../services/proposal-service.js'
import { fail, ok, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

const TICKET_TTL_SECONDS = 60
/** Outlives the ticket, so a turn is never forgotten while its ticket could still open it. */
const TURN_TTL_SECONDS = 120
const TURNS = 'assistant-turns'
/** An assistant ticket is signed with a key of its own, so no other ticket the store signs opens a turn. */
const TICKET_PURPOSE = 'assistant-ticket'

interface TurnRecord {
  uid: string
  roles: Role[]
  messages: AssistantTurn['messages']
  page?: string
  nonce: string
  opened: boolean
}

interface TicketPayload {
  turnId: string
  uid: string
  roles: Role[]
  iat: number
  nonce: string
}

function sign(payload: TicketPayload, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`
}

function verify(token: string, key: Buffer): TicketPayload | null {
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = Buffer.from(createHmac('sha256', key).update(body).digest('base64url'))
  const given = Buffer.from(sig)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TicketPayload
    return Array.isArray(payload.roles) && typeof payload.turnId === 'string' ? payload : null
  } catch {
    return null
  }
}

/** Marks the turn opened in one conditional write, so of any opens that race one ticket exactly one wins. */
async function open(store: DocumentStoreAdapter, turnId: string, turn: TurnRecord) {
  try {
    await store.put<TurnRecord>(
      TURNS,
      turnId,
      { ...turn, opened: true },
      { ttl: TURN_TTL_SECONDS, conditionKey: 'opened', conditionValue: false },
    )
    return true
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'adapter.condition-failed') return false
    throw err
  }
}

const REFUSALS: Record<string, string> = {
  'ticket.missing': 'The stream needs the ticket its turn was issued with',
  'ticket.invalid': 'The ticket was not issued for this turn',
  'ticket.expired': 'The ticket has expired; ask again',
  'ticket.forbidden': 'The ticket is not an admin’s',
  'ticket.replayed': 'The ticket has been used',
  'assistant.turn_missing': 'The turn has expired; ask again',
  'assistant.unavailable': 'No AI provider is set up for this store',
}

function refuse(stream: StreamContext, code: string): void {
  stream.send({ event: 'error', data: { code, message: REFUSALS[code] ?? code } })
  stream.close()
}

export interface RegisterAdminAssistantRoutesDeps {
  config: NymbalConfig
  ai: AiAdapter | null
  /** The tool surface the assistant runs; it exists once every route is registered. */
  tools: () => ToolSurface | undefined
  proposals: Pick<ProposalService, 'get'>
  documentStore: DocumentStoreAdapter
  jwtSecret: string
}

/**
 * The admin's assistant: a turn is POSTed (kept briefly, with a one-time ticket) and its answer streamed from a GET
 * the ticket opens once, as an EventSource can send no bearer. Closing the stream stops the turn.
 */
export function registerAdminAssistantRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminAssistantRoutesDeps,
): void {
  const { config, ai, documentStore } = deps
  const key = createHmac('sha256', deps.jwtSecret).update(TICKET_PURPOSE).digest()

  adapter.registerRoute(
    'POST',
    '/api/admin/assistant/turns',
    requireRole('admin', async (ctx) => {
      try {
        if (ai === null) {
          return fail(
            'assistant.unavailable',
            'No AI provider is set up for this store: choose one in Settings',
            503,
          )
        }
        if (!ai.capabilities().includes('tools')) {
          return fail(
            'assistant.unavailable',
            `The AI provider ${ai.providerName} cannot call tools: its capabilities lack tools`,
            503,
          )
        }
        const body = ctx.body as Pick<TurnRecord, 'messages' | 'page'>
        const turnId = uuidv7()
        const nonce = randomBytes(12).toString('base64url')
        const uid = ctx.auth!.userId!
        const roles = (ctx.auth!.roles as Role[] | undefined) ?? ['admin']
        await documentStore.put<TurnRecord>(
          TURNS,
          turnId,
          {
            uid,
            roles,
            messages: body.messages,
            ...(body.page !== undefined && { page: body.page }),
            nonce,
            opened: false,
          },
          { ttl: TURN_TTL_SECONDS },
        )
        const ticket = sign({ turnId, uid, roles, iat: Math.floor(Date.now() / 1000), nonce }, key)
        return ok<AssistantTurnIssued>({ turnId, ticket, expiresIn: TICKET_TTL_SECONDS })
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )

  adapter.registerStreamRoute(
    'GET',
    '/api/admin/assistant/turns/:id/stream',
    async (ctx, stream) => {
      const raw = ctx.query['ticket']
      const ticket = Array.isArray(raw) ? raw[0] : raw
      if (!ticket) return refuse(stream, 'ticket.missing')
      const turnId = String(ctx.params['id'])
      const payload = verify(ticket, key)
      if (payload === null || payload.turnId !== turnId) return refuse(stream, 'ticket.invalid')
      if (Math.floor(Date.now() / 1000) - payload.iat > TICKET_TTL_SECONDS) {
        return refuse(stream, 'ticket.expired')
      }
      if (!payload.roles.includes('admin')) return refuse(stream, 'ticket.forbidden')
      const turn = await documentStore.get<TurnRecord>(TURNS, turnId)
      if (turn === null) return refuse(stream, 'assistant.turn_missing')
      if (turn.nonce !== payload.nonce || turn.uid !== payload.uid) {
        return refuse(stream, 'ticket.invalid')
      }
      if (turn.opened || !(await open(documentStore, turnId, turn))) {
        return refuse(stream, 'ticket.replayed')
      }
      const tools = deps.tools()
      if (ai === null || tools === undefined) return refuse(stream, 'assistant.unavailable')

      const stop = new AbortController()
      stream.onClose(() => stop.abort())
      await runAssistantTurn(
        {
          ai,
          tools,
          proposals: deps.proposals,
          logger: ctx.logger,
          store: {
            name: config.store.name,
            currency: config.store.currency,
            timezone: config.store.timezone,
          },
          customerData: config.agents.assistant.customerData,
          mask: config.agents.assistant.mask,
        },
        {
          turnId,
          caller: {
            auth: { userId: turn.uid, roles: turn.roles },
            agent: { name: ASSISTANT_AGENT },
          },
          messages: turn.messages,
          ...(turn.page !== undefined && { page: turn.page }),
        },
        (frame) => stream.send(frame),
        stop.signal,
      )
      stream.close()
    },
  )
}
