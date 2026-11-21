import { ValidationError, type HttpAdapter, type RequestContext } from '@nymbalhq/types'
import type { NymbalConfig } from '@nymbalhq/config'
import type { Repositories } from '../repositories/index.js'
import { readReport, type ReportGrain } from '../reports/report.js'
import { ok, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

export interface RegisterAdminReportsRouteDeps {
  repos: Repositories
  config: NymbalConfig
}

function limitOf(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`limit must be a whole number from 1 to ${MAX_LIMIT}`)
  }
  return limit
}

export function registerAdminReportsRoute(
  adapter: HttpAdapter,
  deps: RegisterAdminReportsRouteDeps,
): void {
  const { repos, config } = deps

  adapter.registerRoute(
    'GET',
    '/api/admin/reports',
    requireRole('admin', async (ctx: RequestContext) => {
      try {
        const { from, to, grain } = ctx.query as {
          from?: string
          to?: string
          grain?: ReportGrain
        }
        const report = await readReport(
          {
            store: repos.reportRollup.store,
            repo: repos.reportRollup,
            timeZone: config.store.timezone,
            now: () => new Date(),
          },
          {
            ...(from !== undefined && { from }),
            ...(to !== undefined && { to }),
            ...(grain !== undefined && { grain }),
            limit: limitOf(ctx.query['limit']),
          },
        )
        return ok(report)
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )
}
