import { STANDARD_EVENT_TYPES, type NymbalEventMap } from '@nymbalhq/types'
import { api } from '@/lib/api'

const BACKOFF_DELAYS = [1000, 2000, 5000, 10000, 30000]

export interface SseClient {
  connect(): void
  disconnect(): void
}

export interface SseClientOptions {
  /** Runs on each `connected` frame, which the server sends once its subscription is live. */
  onConnected?: () => void
  /** Runs once each time the stream is lost or a ticket is refused, before the reconnect is scheduled. */
  onDisconnected?: () => void
}

export type SseEventHandler = <K extends keyof NymbalEventMap>(
  type: K,
  payload: NymbalEventMap[K],
) => void

/** The envelope's payload, or undefined for a frame that is not a JSON envelope (dropped). */
function payloadOf(data: string): unknown {
  try {
    const parsed = JSON.parse(data) as unknown
    if (typeof parsed === 'object' && parsed !== null && 'payload' in parsed) {
      return (parsed as { payload: unknown }).payload
    }
  } catch {
    // malformed frame
  }
  return undefined
}

export function createSseClient(
  onEvent: SseEventHandler,
  options: SseClientOptions = {},
): SseClient {
  let es: EventSource | null = null
  let retryCount = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  async function getTicket(): Promise<string> {
    const result = await api.post<{ ticket: string }>('/api/admin/events/ticket')
    return result.ticket
  }

  function scheduleReconnect() {
    if (stopped) return
    const delay = BACKOFF_DELAYS[Math.min(retryCount, BACKOFF_DELAYS.length - 1)] ?? 30000
    retryCount++
    retryTimer = setTimeout(() => {
      void connectWithTicket()
    }, delay)
  }

  async function connectWithTicket() {
    if (stopped) return
    try {
      const ticket = await getTicket()
      if (stopped) return

      es = new EventSource(`/api/admin/events?ticket=${encodeURIComponent(ticket)}`)

      es.onopen = () => {
        retryCount = 0
      }

      // Not `onopen`: the stream opens before the ticket is checked, and before the subscription exists.
      es.addEventListener('connected', () => {
        options.onConnected?.()
      })

      // The server names each event by its type and sends `{ id, type, timestamp, payload }`.
      for (const type of STANDARD_EVENT_TYPES) {
        es.addEventListener(type, (evt) => {
          const payload = payloadOf((evt as MessageEvent<string>).data)
          if (payload !== undefined) onEvent(type, payload as NymbalEventMap[typeof type])
        })
      }

      es.onerror = () => {
        es?.close()
        es = null
        if (stopped) return
        options.onDisconnected?.()
        scheduleReconnect()
      }
    } catch {
      if (stopped) return
      options.onDisconnected?.()
      scheduleReconnect()
    }
  }

  return {
    connect() {
      stopped = false
      void connectWithTicket()
    },
    disconnect() {
      stopped = true
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      es?.close()
      es = null
    },
  }
}
