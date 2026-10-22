import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuditActor, RequestAuth } from '@nymbalhq/types'

export type Actor = AuditActor

// Who the current code runs for. Services take no request context, so the audit trail reads the actor from here, as
// the publisher reads the correlation id from its scope. An inner scope wins: the webhook route runs as the system
// inside the request's guest scope.
const scope = new AsyncLocalStorage<Actor>()

/** Runs `fn` as `actor`, across its awaits, and returns its result. */
export function runAsActor<T>(actor: Actor, fn: () => T): T {
  return scope.run(actor, fn)
}

export function currentActor(): Actor | undefined {
  return scope.getStore()
}

/** Runs `fn` as no one: for work done on behalf of other operations, such as relay delivery. */
export function outsideActor<T>(fn: () => T): T {
  return scope.exit(fn)
}

/** A request's actor from its principal. A guest is anonymous: a cart's token is a credential, never an id. */
export function actorOf(auth: RequestAuth | undefined): Actor {
  if (auth?.userId) {
    return auth.roles?.includes('admin')
      ? { kind: 'admin', id: auth.userId }
      : { kind: 'customer', id: auth.userId }
  }
  return { kind: 'guest', id: 'anonymous' }
}
