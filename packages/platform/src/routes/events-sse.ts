import { createHmac, randomBytes } from 'node:crypto'
import {
  type DocumentStoreAdapter,
  type EventBusAdapter,
  type HttpAdapter,
  type Role,
} from '@nymbal/types'
import { ok, fail, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

const TICKET_TTL_SECONDS = 60
const NONCE_COLLECTION = 'sse-ticket-nonces'

interface TicketPayload {
  uid: string
  roles: Role[]
  iat: number
  nonce: string
}

function sign(payload: TicketPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

function verify(token: string, secret: string): TicketPayload | null {
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  if (expected !== sig) return null
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TicketPayload
  } catch {
    return null
  }
}

export interface RegisterEventsSseDeps {
  eventBus: EventBusAdapter
  documentStore: DocumentStoreAdapter
  ticketSecret: string
}

export function registerEventsSseRoute(adapter: HttpAdapter, deps: RegisterEventsSseDeps): void {
  const { eventBus, documentStore, ticketSecret } = deps

  adapter.registerRoute(
    'POST',
    '/api/admin/events/ticket',
    requireRole('admin', (ctx) => {
      try {
        const nonce = randomBytes(12).toString('base64url')
        const payload: TicketPayload = {
          uid: ctx.auth!.userId!,
          roles: (ctx.auth!.roles as Role[]) ?? ['admin'],
          iat: Math.floor(Date.now() / 1000),
          nonce,
        }
        const token = sign(payload, ticketSecret)
        return ok({ ticket: token, expiresIn: TICKET_TTL_SECONDS })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerStreamRoute('GET', '/api/admin/events', async (ctx, stream) => {
    const rawTicket = ctx.query.ticket
    const ticket = Array.isArray(rawTicket) ? rawTicket[0] : rawTicket
    if (!ticket) {
      stream.send({ event: 'error', data: { code: 'ticket.missing' } })
      stream.close()
      return
    }
    const payload = verify(ticket, ticketSecret)
    if (!payload) {
      stream.send({ event: 'error', data: { code: 'ticket.invalid' } })
      stream.close()
      return
    }
    if (Math.floor(Date.now() / 1000) - payload.iat > TICKET_TTL_SECONDS) {
      stream.send({ event: 'error', data: { code: 'ticket.expired' } })
      stream.close()
      return
    }
    // One-time nonce enforcement
    const nonceKey = `${payload.uid}:${payload.nonce}`
    const seen = await documentStore.get<{ seen: true }>(NONCE_COLLECTION, nonceKey)
    if (seen) {
      stream.send({ event: 'error', data: { code: 'ticket.replayed' } })
      stream.close()
      return
    }
    await documentStore.put(NONCE_COLLECTION, nonceKey, { seen: true }, { ttl: 120 })
    if (!payload.roles.includes('admin')) {
      stream.send({ event: 'error', data: { code: 'ticket.forbidden' } })
      stream.close()
      return
    }

    const subscription = await eventBus.subscribe(
      ['order.*', 'payment.*', 'inventory.*', 'adapter.*'],
      (event) => {
        stream.send({
          id: event.id,
          event: event.type,
          data: { id: event.id, type: event.type, timestamp: event.timestamp, payload: event.payload },
        })
      },
      { name: 'sse-admin-events' },
    )

    stream.onClose(() => {
      subscription.unsubscribe().catch(() => undefined)
    })
    stream.send({ event: 'connected', data: { at: new Date().toISOString() } })
  })

  void fail
}
