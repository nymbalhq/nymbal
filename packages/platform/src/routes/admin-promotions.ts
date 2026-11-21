import { v7 as uuidv7 } from 'uuid'
import type { HttpAdapter, ResponseEnvelope } from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type {
  PromotionKind,
  PromotionPatch,
  PromotionRepository,
} from '../repositories/promotion.js'
import { fail, ok, renderError, type Envelope } from './envelope.js'
import { requireRole } from './role-middleware.js'

const CODE = /^[A-Za-z0-9_-]{1,64}$/

/** One promotion's fields as the request gave them: unchecked, whatever it sent. */
interface PromotionBody {
  code?: unknown
  kind?: unknown
  percentBps?: unknown
  amountOffMinor?: unknown
  currency?: unknown
  minimumSubtotalMinor?: unknown
  expiresAt?: unknown
  usageCap?: unknown
  active?: unknown
}

export interface RegisterAdminPromotionsRoutesDeps {
  promotions: PromotionRepository
}

/** The whole, validated shape of a promotion; every path to a stored row goes through it. */
interface Candidate {
  code: string
  kind: PromotionKind
  percentBps: number | null
  amountOffMinor: number | null
  currency: string | null
  minimumSubtotalMinor: number | null
  expiresAt: Date | null
  usageCap: number | null
  active: boolean
}

const invalid = (message: string): ResponseEnvelope<Envelope<never>> =>
  fail('promotion.invalid', message, 400)

const isNullish = (v: unknown): v is null | undefined => v === null || v === undefined

function wholeOrNull(value: unknown): number | null | undefined {
  if (isNullish(value)) return null
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function validated(body: PromotionBody): Candidate | string {
  if (typeof body.code !== 'string' || !CODE.test(body.code)) {
    return 'a code is 1 to 64 letters, digits, dashes or underscores'
  }
  if (body.kind !== 'percent' && body.kind !== 'fixed') return "kind is 'percent' or 'fixed'"
  const percentBps = wholeOrNull(body.percentBps)
  const amountOffMinor = wholeOrNull(body.amountOffMinor)
  const minimumSubtotalMinor = wholeOrNull(body.minimumSubtotalMinor)
  const usageCap = wholeOrNull(body.usageCap)
  if (percentBps === undefined || amountOffMinor === undefined) return 'amounts are whole numbers'
  if (minimumSubtotalMinor === undefined) return 'minimumSubtotalMinor is a whole number'
  if (usageCap === undefined) return 'usageCap is a whole number'
  if (body.kind === 'percent' && (percentBps === null || percentBps < 1 || percentBps > 9999)) {
    return 'percentBps is 1 to 9999'
  }
  if (body.kind === 'fixed' && (amountOffMinor === null || amountOffMinor <= 0)) {
    return 'amountOffMinor is above 0'
  }
  if (body.currency !== undefined && body.currency !== null && typeof body.currency !== 'string') {
    return 'currency is a code such as GBP'
  }
  const currency = (body.currency as string | null | undefined) ?? null
  if (body.kind === 'fixed' && currency === null) return 'a fixed promotion needs a currency'
  if (minimumSubtotalMinor !== null && currency === null) return 'a minimum needs a currency'
  let expiresAt: Date | null = null
  if (!isNullish(body.expiresAt)) {
    expiresAt = new Date(body.expiresAt as string)
    if (Number.isNaN(expiresAt.getTime())) return 'expiresAt is not a date'
  }
  if (body.active !== undefined && typeof body.active !== 'boolean') return 'active is a boolean'
  return {
    code: body.code,
    kind: body.kind,
    percentBps: body.kind === 'percent' ? percentBps : null,
    amountOffMinor: body.kind === 'fixed' ? amountOffMinor : null,
    currency,
    minimumSubtotalMinor,
    expiresAt,
    usageCap,
    active: body.active ?? true,
  }
}

export function registerAdminPromotionsRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminPromotionsRoutesDeps,
): void {
  const { promotions } = deps
  const { store } = promotions

  adapter.registerRoute(
    'GET',
    '/api/admin/promotions',
    requireRole('admin', async (ctx) => {
      try {
        const limitRaw = Array.isArray(ctx.query.limit) ? ctx.query.limit[0] : ctx.query.limit
        const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 50, 1), 200) : 50
        return ok(await store.read((tx) => promotions.list(tx, limit)))
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )

  adapter.registerRoute(
    'POST',
    '/api/admin/promotions',
    requireRole('admin', async (ctx) => {
      try {
        const candidate = validated((ctx.body ?? {}) as PromotionBody)
        if (typeof candidate === 'string') return invalid(candidate)
        const id = uuidv7()
        const createdAt = new Date()
        const inserted = await store.transaction((tx) => {
          audit.note('promotion.create', [{ type: 'promotion', id }])
          return promotions.insert(tx, { id, createdAt, ...candidate })
        })
        if (!inserted) {
          return fail('promotion.code_taken', `The code ${candidate.code} is taken`, 409)
        }
        const created = await store.read((tx) => promotions.findById(tx, id))
        return ok(created, undefined, 201)
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )

  adapter.registerRoute(
    'PATCH',
    '/api/admin/promotions/:id',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id!
        const outcome = await store.transaction(async (tx): Promise<ResponseEnvelope> => {
          const current = await promotions.lock(tx, id)
          if (current === null) return fail('promotion.not_found', `No promotion ${id}`, 404)
          const body = (ctx.body ?? {}) as PromotionBody
          const candidate = validated({ ...current, ...stripUndefined(body) })
          if (typeof candidate === 'string') return invalid(candidate)
          if (candidate.code.toLowerCase() !== current.code.toLowerCase()) {
            const taken = await promotions.findByCodes(tx, [candidate.code])
            if (taken.length > 0) {
              return fail('promotion.code_taken', `The code ${candidate.code} is taken`, 409)
            }
          }
          audit.note('promotion.update', [{ type: 'promotion', id }])
          const patch: PromotionPatch = candidate
          return ok(await promotions.update(tx, id, patch, new Date()))
        })
        return outcome
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )

  adapter.registerRoute(
    'DELETE',
    '/api/admin/promotions/:id',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id!
        const outcome = await store.transaction(async (tx): Promise<ResponseEnvelope> => {
          const current = await promotions.lock(tx, id)
          if (current === null) return fail('promotion.not_found', `No promotion ${id}`, 404)
          if (await promotions.redeemed(tx, id)) {
            return fail('promotion.in_use', 'A promotion an order has used cannot be deleted', 409)
          }
          audit.note('promotion.delete', [{ type: 'promotion', id }])
          await promotions.delete(tx, id)
          return ok({ ok: true })
        })
        return outcome
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )
}

/** A body field left out means no change; an explicit null still clears the column. */
function stripUndefined(body: PromotionBody): PromotionBody {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))
}
