import { useCallback, useState } from 'react'
import { newIdempotencyKey } from '@/lib/api'

/**
 * One user intent's Idempotency-Key. Every send made from one render (a double click that lands before the re-render
 * disables the button) carries the same key; `renew` gives the next intent its own.
 */
export function useIntentKey(): [key: string, renew: () => void] {
  const [key, setKey] = useState(newIdempotencyKey)
  const renew = useCallback(() => setKey(newIdempotencyKey()), [])
  return [key, renew]
}
