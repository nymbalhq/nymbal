import type { RequestContext, ResponseEnvelope } from '@nymbalhq/types'
import { fail, ok, renderError, type Envelope } from '../routes/envelope.js'
import type { HistoryReader, HistorySubject } from './read.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** An ISO 8601 date-time with a zone: a local time would name a different instant per server. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i

type Answer = ResponseEnvelope<Envelope<unknown>>

function one(ctx: RequestContext, name: string): string | undefined {
  const value = ctx.query[name]
  return Array.isArray(value) ? value[0] : value
}

/** The `at` of a detail read, or undefined when it has none (the read is unchanged). */
export function atOf(ctx: RequestContext): string | undefined {
  return one(ctx, 'at')
}

/** `GET <admin detail>?at=`: 200 `{asOf, historyStartsAt, record}`, or the refusal that says why not. */
export async function answerAsOf(
  reader: HistoryReader,
  at: string,
  resolve: () => Promise<HistorySubject>,
  notFound: () => Answer,
): Promise<Answer> {
  try {
    const instant = new Date(at)
    if (!ISO_INSTANT.test(at) || Number.isNaN(instant.getTime())) {
      return fail('history.invalid_at', 'at must be an ISO 8601 date-time with a zone', 400, { at })
    }
    const outcome = await reader.asOf(await resolve(), instant)
    switch (outcome.kind) {
      case 'record':
        return ok(outcome.read)
      case 'not_found':
        return notFound()
      case 'deleted':
        return fail('history.deleted', `Deleted at ${outcome.deletedAt}`, 410, {
          deletedAt: outcome.deletedAt,
        })
      case 'before_start':
        return fail(
          'history.before_start',
          outcome.historyStartsAt === null
            ? 'The record predates the event log’s window (events.retentionDays)'
            : `The event log holds this record from ${outcome.historyStartsAt}`,
          409,
          { historyStartsAt: outcome.historyStartsAt },
        )
    }
  } catch (err) {
    return renderError(err)
  }
}

/** `GET …/:id/history?cursor&limit`: one page, newest first. */
export async function answerHistory(
  reader: HistoryReader,
  ctx: RequestContext,
  resolve: () => Promise<HistorySubject>,
  notFound: () => Answer,
): Promise<Answer> {
  try {
    const limitRaw = one(ctx, 'limit')
    const limit = limitRaw === undefined || limitRaw === '' ? DEFAULT_LIMIT : Number(limitRaw)
    if (!Number.isInteger(limit) || limit < 1) {
      return fail('history.invalid', 'limit must be a whole number of at least 1', 400)
    }
    const cursor = one(ctx, 'cursor')
    if (cursor !== undefined && cursor !== '' && !/^\d+$/.test(cursor)) {
      return fail('history.invalid', 'cursor is not one this API issued', 400)
    }
    const page = await reader.list(await resolve(), {
      limit: Math.min(limit, MAX_LIMIT),
      ...(cursor !== undefined && cursor !== '' && { beforeSeq: Number(cursor) }),
    })
    return page === null ? notFound() : ok(page)
  } catch (err) {
    return renderError(err)
  }
}
