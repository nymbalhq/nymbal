import { Readable } from 'node:stream'
import type { AuditOutcome, HttpAdapter, RequestContext } from '@nymbalhq/types'
import {
  auditEntriesInOrder,
  type AuditCursor,
  type AuditEntryRepository,
  type AuditFilter,
} from '../repositories/audit-entry.js'
import { fail, ok, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface RegisterAdminActivityRoutesDeps {
  auditEntries: AuditEntryRepository
}

const OUTCOMES = new Set<string>(['applied', 'refused', 'replayed'])
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** A refusal in the caller's terms: answered 400. */
class QueryError extends Error {}

function one(ctx: RequestContext, name: string): string | undefined {
  const value = ctx.query[name]
  const first = Array.isArray(value) ? value[0] : value
  return first === undefined || first === '' ? undefined : first
}

function time(ctx: RequestContext, name: string): Date | undefined {
  const value = one(ctx, name)
  if (value === undefined) return undefined
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) throw new QueryError(`${name} must be an ISO 8601 time`)
  return at
}

function filterOf(ctx: RequestContext, names: readonly string[]): AuditFilter {
  const filter: AuditFilter = {}
  for (const name of ['actor', 'command', 'subject', 'correlation'] as const) {
    const value = names.includes(name) ? one(ctx, name) : undefined
    if (value !== undefined) filter[name] = value
  }
  const outcome = names.includes('outcome') ? one(ctx, 'outcome') : undefined
  if (outcome !== undefined) {
    if (!OUTCOMES.has(outcome)) throw new QueryError('outcome must be applied, refused or replayed')
    filter.outcome = outcome as AuditOutcome
  }
  const since = time(ctx, 'since')
  const until = time(ctx, 'until')
  if (since !== undefined) filter.since = since
  if (until !== undefined) filter.until = until
  return filter
}

function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString('base64url')
}

function decodeCursor(value: string | undefined): AuditCursor | undefined {
  if (value === undefined) return undefined
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      typeof decoded[0] === 'string' &&
      typeof decoded[1] === 'string'
    ) {
      return { at: decoded[0], id: decoded[1] }
    }
  } catch {
    // Not base64url JSON: refused below like any other malformed cursor.
  }
  throw new QueryError('cursor is not one this API issued')
}

function limitOf(ctx: RequestContext): number {
  const value = one(ctx, 'limit')
  if (value === undefined) return DEFAULT_LIMIT
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1)
    throw new QueryError('limit must be a whole number of at least 1')
  return Math.min(n, MAX_LIMIT)
}

function answerError(err: unknown) {
  return err instanceof QueryError ? fail('activity.invalid', err.message, 400) : renderError(err)
}

export function registerAdminActivityRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminActivityRoutesDeps,
): void {
  const { auditEntries } = deps
  const { store } = auditEntries

  // GET /api/admin/activity: newest first, a page at a time; a stored response shows only as its status.
  adapter.registerRoute(
    'GET',
    '/api/admin/activity',
    requireRole('admin', async (ctx) => {
      try {
        const filter = filterOf(ctx, ['actor', 'command', 'subject', 'correlation', 'outcome'])
        const limit = limitOf(ctx)
        const cursor = decodeCursor(one(ctx, 'cursor'))
        const rows = await store.read((tx) =>
          auditEntries.list(tx, {
            ...filter,
            order: 'desc',
            limit: limit + 1,
            ...(cursor !== undefined && { cursor }),
          }),
        )
        const page = rows.slice(0, limit)
        const last = page[page.length - 1]
        const nextCursor =
          rows.length > limit && last !== undefined
            ? encodeCursor({ at: last.at, id: last.id })
            : null
        return ok(page, { nextCursor })
      } catch (err) {
        return answerError(err)
      }
    }),
  )

  // GET /api/admin/activity/export: NDJSON, oldest first, streamed a page at a time.
  adapter.registerRoute(
    'GET',
    '/api/admin/activity/export',
    requireRole('admin', async (ctx) => {
      try {
        const filter = filterOf(ctx, ['correlation'])
        async function* lines() {
          for await (const entry of auditEntriesInOrder(store, filter)) {
            yield `${JSON.stringify(entry)}\n`
          }
        }
        return {
          status: 200,
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.ndjson"`,
          },
          body: Readable.from(lines()),
        }
      } catch (err) {
        return answerError(err)
      }
    }),
  )
}
