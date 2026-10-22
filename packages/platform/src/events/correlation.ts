import { AsyncLocalStorage } from 'node:async_hooks'
import { v7 as uuidv7 } from 'uuid'

export { isValidCorrelationId } from '@nymbalhq/types'

// The id of the operation the current code runs for. Services take no request context, so the publisher reads the id
// from here rather than from a parameter threaded through every service signature.
const scope = new AsyncLocalStorage<string>()

/** Runs `fn` with `id` as the correlation id of every event it publishes, across its awaits, and returns its result. */
export function runWithCorrelation<T>(id: string, fn: () => T): T {
  return scope.run(id, fn)
}

export function currentCorrelationId(): string | undefined {
  return scope.getStore()
}

/** A fresh id for one run of work that starts outside HTTP (a sweep, an import): `<origin>:<uuidv7>`. */
export function newCorrelationId(origin: string): string {
  return `${origin}:${uuidv7()}`
}

/** Runs `fn` outside any correlation scope: for work done on behalf of other operations, such as relay delivery. */
export function outsideCorrelation<T>(fn: () => T): T {
  return scope.exit(fn)
}
