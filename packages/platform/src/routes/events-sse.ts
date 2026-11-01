import { createHmac, randomBytes } from 'node:crypto'
import {
  type DocumentStoreAdapter,
  type EventBusAdapter,
  type HttpAdapter,
  type Role,
} from '@nymbalhq/types'
import { ok, fail, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

const TICKET_TTL_SECONDS = 60
/** Outlives the ticket, so a nonce is never forgotten while its ticket could still be opened. */
const NONCE_TTL_SECONDS = 120
const NONCE_COLLECTION = 'sse-ticket-nonces'

interface NonceRecord {
  used: boolean
}

/**
 * Flips the nonce the ticket route wrote from unused to used, in one conditional write, so of any opens that race one
 * ticket exactly one wins. False when it was used already, has expired, or was never issued on this store.
 */
async function consumeNonce(store: DocumentStoreAdapter, key: string): Promise<boolean> {
  try {
    await store.put<NonceRecord>(
      NONCE_COLLECTION,
      key,
      { used: true },
      { ttl: NONCE_TTL_SECONDS, conditionKey: 'used', conditionValue: false },
    )
    return true
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'adapter.condition-failed') return false
    throw err
  }
}

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
    requireRole('admin', async (ctx) => {
      try {
        const nonce = randomBytes(12).toString('base64url')
        const payload: TicketPayload = {
          uid: ctx.auth!.userId!,
          roles: (ctx.auth!.roles as Role[]) ?? ['admin'],
          iat: Math.floor(Date.now() / 1000),
          nonce,
        }
        await documentStore.put<NonceRecord>(
          NONCE_COLLECTION,
          `${payload.uid}:${nonce}`,
          { used: false },
          { ttl: NONCE_TTL_SECONDS },
        )
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
    if (!(await consumeNonce(documentStore, `${payload.uid}:${payload.nonce}`))) {
      stream.send({ event: 'error', data: { code: 'ticket.replayed' } })
      stream.close()
      return
    }
    if (!payload.roles.includes('admin')) {
      stream.send({ event: 'error', data: { code: 'ticket.forbidden' } })
      stream.close()
      return
    }

    // Unnamed: every open tab, on every instance, receives every event. A shared name would make the tabs consumers
    // of one group on a shared bus, each event reaching one of them.
    const subscription = await eventBus.subscribe(
      ['order.*', 'payment.*', 'inventory.*', 'adapter.*'],
      (event) => {
        stream.send({
          id: event.id,
          event: event.type,
          data: {
            id: event.id,
            type: event.type,
            timestamp: event.timestamp,
            payload: event.payload,
          },
        })
      },
    )

    stream.onClose(() => {
      subscription.unsubscribe().catch(() => undefined)
    })
    stream.send({ event: 'connected', data: { at: new Date().toISOString() } })
  })

  void fail
}
