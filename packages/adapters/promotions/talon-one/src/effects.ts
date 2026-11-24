import type { PromotionEffect, PromotionSession } from '@nymbalhq/types'
import { isObject, type Json } from './api.js'

const REASONS: Readonly<Record<string, string>> = {
  CouponExpired: 'expired',
  CouponLimitReached: 'cap_reached',
  CampaignLimitReached: 'cap_reached',
  ProfileLimitReached: 'cap_reached',
}

type Money = Extract<PromotionEffect, { amountMinor: number }>

type WithoutAmount<T> = T extends unknown ? Omit<T, 'amountMinor'> : never

/** A money effect while its units are summed: the major-unit total, rounded once all of a line's units are in. */
type Pending = { effect: WithoutAmount<Money>; major: number; coupon: unknown }

const amount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

const text = (value: unknown, otherwise: string): string =>
  typeof value === 'string' ? value : otherwise

/**
 * Talon.One's `effects` as the kernel's, in Talon.One's order. Per-item discounts come once per unit and are summed
 * into one line effect per position, campaign and name. A coupon Talon.One accepts that moved no money, in an answer
 * holding something the kernel cannot act on, is refused as `unknown`: shown as applied, it would change nothing and
 * still be counted at close.
 */
export function readEffects(
  effects: readonly unknown[],
  coupons: unknown,
  session: PromotionSession,
  exponent: number,
): PromotionEffect[] {
  const scale = 10 ** exponent
  const spelled = (code: string): string =>
    session.codes.find((c) => c.toLowerCase() === code.toLowerCase()) ?? code
  const couponCodes = new Map<unknown, string>()
  for (const coupon of Array.isArray(coupons) ? coupons : []) {
    if (isObject(coupon) && typeof coupon['value'] === 'string') {
      couponCodes.set(coupon['id'], coupon['value'])
    }
  }
  const codeOf = (coupon: unknown) => {
    const code = couponCodes.get(coupon)
    return code === undefined ? {} : { code: spelled(code) }
  }

  const out: (PromotionEffect | Pending)[] = []
  const lineUnits = new Map<string, Pending>()
  const accepts: { index: number; code: string; coupon: unknown }[] = []

  for (const raw of effects) {
    const e: Json = isObject(raw) ? raw : {}
    const type = text(e['effectType'], 'unknown')
    const props: Json = isObject(e['props']) ? e['props'] : {}
    const value = amount(props['value'])
    const label = text(props['name'], type)
    if (type === 'setDiscount' && value !== undefined) {
      out.push({
        effect: { kind: 'order', label, ...codeOf(e['triggeredByCoupon']) },
        major: value,
        coupon: e['triggeredByCoupon'],
      })
      continue
    }
    const position = props['position']
    const scope = props['scope']
    if (
      type === 'setDiscountPerItem' &&
      value !== undefined &&
      (scope === undefined || scope === 'price') &&
      typeof position === 'number' &&
      Number.isInteger(position) &&
      position >= 0 &&
      position < session.lines.length
    ) {
      const key = JSON.stringify([position, e['campaignId'], label])
      const pending = lineUnits.get(key)
      if (pending !== undefined) {
        pending.major += value
        continue
      }
      const unit: Pending = {
        effect: {
          kind: 'line',
          lineId: session.lines[position]!.id,
          label,
          ...codeOf(e['triggeredByCoupon']),
        },
        major: value,
        coupon: e['triggeredByCoupon'],
      }
      lineUnits.set(key, unit)
      out.push(unit)
      continue
    }
    if (type === 'acceptCoupon' && typeof props['value'] === 'string') {
      const code = spelled(props['value'])
      const coupon =
        e['triggeredByCoupon'] ??
        [...couponCodes].find(([, c]) => c.toLowerCase() === code.toLowerCase())?.[0]
      accepts.push({ index: out.length, code, coupon })
      out.push({ kind: 'code_accepted', code })
      continue
    }
    if (type === 'rejectCoupon' && typeof props['value'] === 'string') {
      const reason = REASONS[text(props['rejectionReason'], '')] ?? 'unknown'
      out.push({ kind: 'code_rejected', code: spelled(props['value']), reason })
      continue
    }
    if (type === 'showNotification') {
      out.push({ kind: 'notice', text: text(props['body'], '') })
      continue
    }
    out.push({ kind: 'unsupported', detail: type })
  }

  const isPending = (e: PromotionEffect | Pending): e is Pending => 'major' in e
  if (out.some((e) => !isPending(e) && e.kind === 'unsupported')) {
    const paying = new Set(out.filter(isPending).map((p) => p.coupon))
    for (const accept of accepts) {
      if (accept.coupon === undefined || !paying.has(accept.coupon)) {
        out[accept.index] = { kind: 'code_rejected', code: accept.code, reason: 'unknown' }
      }
    }
  }
  return out.map((e) =>
    isPending(e) ? ({ ...e.effect, amountMinor: Math.round(e.major * scale) } as Money) : e,
  )
}
