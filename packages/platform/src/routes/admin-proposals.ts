import type { HttpAdapter, Logger, RequestContext } from '@nymbalhq/types'
import { ProposalError } from '../mcp/proposals.js'
import { decodeProposalCursor, type ProposalQuery } from '../repositories/proposal.js'
import { previewOf, type PreviewReads } from '../services/proposal-preview.js'
import type { ProposalService } from '../services/proposal-service.js'
import { fail, ok, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface RegisterAdminProposalRoutesDeps {
  proposals: ProposalService
  /** What a pending proposal read on its own is previewed from: the store as it is at the read. */
  preview: PreviewReads
}

const STATUSES = new Set<string>(['pending', 'decided', 'all'])
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** A query the caller can fix: answered 400. */
class QueryError extends Error {}

function one(ctx: RequestContext, name: string): string | undefined {
  const value = ctx.query[name]
  const first = Array.isArray(value) ? value[0] : value
  return first === undefined || first === '' ? undefined : first
}

function queryOf(ctx: RequestContext): ProposalQuery {
  const status = one(ctx, 'status') ?? 'all'
  if (!STATUSES.has(status)) throw new QueryError('status must be pending, decided or all')
  const rawLimit = one(ctx, 'limit')
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1) {
    throw new QueryError('limit must be a whole number of at least 1')
  }
  const rawCursor = one(ctx, 'cursor')
  const cursor = rawCursor === undefined ? undefined : decodeProposalCursor(rawCursor)
  if (rawCursor !== undefined && cursor === undefined) {
    throw new QueryError('cursor is not one this API issued')
  }
  return {
    status: status as ProposalQuery['status'],
    limit: Math.min(limit, MAX_LIMIT),
    ...(cursor !== undefined && { cursor }),
  }
}

function answerError(err: unknown, logger: Logger) {
  if (err instanceof QueryError) return fail('validation.failed', err.message, 400)
  if (err instanceof ProposalError) return fail(err.code, err.message, err.status, err.context)
  return renderError(err, logger)
}

const idOf = (ctx: RequestContext) => String(ctx.params['id'])

export function registerAdminProposalRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminProposalRoutesDeps,
): void {
  const { proposals, preview } = deps

  adapter.registerRoute(
    'GET',
    '/api/admin/proposals',
    requireRole('admin', async (ctx) => {
      try {
        return ok(await proposals.list(queryOf(ctx)))
      } catch (err) {
        return answerError(err, ctx.logger)
      }
    }),
  )

  adapter.registerRoute(
    'GET',
    '/api/admin/proposals/:id',
    requireRole('admin', async (ctx) => {
      try {
        const view = await proposals.get(idOf(ctx))
        if (view === null) {
          return answerError(new ProposalError('proposal.not_found', idOf(ctx)), ctx.logger)
        }
        const previewed = await previewOf(view, preview)
        return ok(previewed === undefined ? view : { ...view, preview: previewed })
      } catch (err) {
        return answerError(err, ctx.logger)
      }
    }),
  )

  // The command runs as the approving admin; a command its route refuses settles the row failed and answers 200.
  adapter.registerRoute(
    'POST',
    '/api/admin/proposals/:id/approve',
    requireRole('admin', async (ctx) => {
      try {
        return ok(await proposals.approve(idOf(ctx), ctx.auth!))
      } catch (err) {
        return answerError(err, ctx.logger)
      }
    }),
  )

  adapter.registerRoute(
    'POST',
    '/api/admin/proposals/:id/reject',
    requireRole('admin', async (ctx) => {
      try {
        const body = ctx.body as { reason?: string }
        return ok(await proposals.reject(idOf(ctx), ctx.auth!, body.reason))
      } catch (err) {
        return answerError(err, ctx.logger)
      }
    }),
  )
}
