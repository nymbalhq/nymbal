import { useCallback, useRef, useState } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import { newIdempotencyKey } from '@/lib/api'

/**
 * Writes keyed by intent: each intent (a row's, or a new record's) holds its own Idempotency-Key until its command
 * settles, and a send for an intent still open sends nothing. One key across rows would be refused for the second row.
 * A command settles once `refresh` (a module constant, so the callback stays stable) has been read again.
 */
export function useIntentWrites(refresh: readonly QueryKey[]) {
  const queryClient = useQueryClient()
  const keys = useRef(new Map<string, string>())
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())

  /**
   * Sends `write` under the intent's key; null, and nothing sent, while that intent's command is open. A row released
   * on the write's answer alone still shows the old values, and an action taken from it would send them back.
   */
  const run = useCallback(
    <T>(intent: string, write: (idempotencyKey: string) => Promise<T>): Promise<T> | null => {
      if (keys.current.has(intent)) return null
      const idempotencyKey = newIdempotencyKey()
      keys.current.set(intent, idempotencyKey)
      setPending(new Set(keys.current.keys()))
      const settle = async () => {
        try {
          await Promise.all(refresh.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
        } finally {
          keys.current.delete(intent)
          setPending(new Set(keys.current.keys()))
        }
      }
      return write(idempotencyKey).then(
        async (answer) => {
          await settle()
          return answer
        },
        async (err: unknown) => {
          await settle()
          throw err
        },
      )
    },
    [queryClient, refresh],
  )

  return { run, pending }
}
