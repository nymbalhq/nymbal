import { api } from '@/lib/api'

const BACKOFF_DELAYS = [1000, 2000, 5000, 10000, 30000]

export interface SseClient {
  connect(): void
  disconnect(): void
}

export function createSseClient(
  onEvent: (type: string, data: unknown) => void
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

      es.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data as string) as { type: string; data: unknown }
          onEvent(parsed.type, parsed.data)
        } catch {
          // ignore malformed events
        }
      }

      es.addEventListener('event', (evt) => {
        const msgEvent = evt as MessageEvent<string>
        try {
          const parsed = JSON.parse(msgEvent.data) as { type: string; data: unknown }
          onEvent(parsed.type, parsed.data)
        } catch {
          // ignore
        }
      })

      es.onerror = () => {
        es?.close()
        es = null
        scheduleReconnect()
      }
    } catch {
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
