import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { Kernel } from './kernel.js'
import type { RawReader } from './raw.js'
import { login, primedShopper } from './security.js'
import type { ShopResponse } from './shopper.js'

// P1-13 support: an admin over HTTP against a served kernel, and the money an order carries as a second connection
// reads it (the `orders` amount columns and the `order_refunds` rows migration 0006 adds).

export interface AdminClient {
  call<T>(method: string, path: string, body?: unknown): Promise<ShopResponse<T>>
}

/** An admin account of its own (roles ['admin']), signed in over HTTP; every call carries its bearer token. */
export async function adminClient(k: Kernel, baseUrl: string): Promise<AdminClient> {
  const email = `admin-${randomUUID()}@p1-13.test`
  const password = 'correct-horse-battery'
  const now = new Date()
  await k.store.transaction((tx) =>
    k.repos.customer.insert(tx, {
      id: randomUUID(),
      email,
      passwordHash: bcrypt.hashSync(password, 4),
      roles: ['admin'],
      requiresPasswordReset: false,
      createdAt: now,
      updatedAt: now,
    }),
  )
  const shop = await primedShopper(baseUrl)
  const answer = await login(baseUrl, shop.jar, { email, password })
  if (answer.status !== 200) throw new Error(`admin login: ${JSON.stringify(answer.body)}`)
  const token = answer.body.data!.accessToken
  return {
    call: (method, path, body) =>
      shop.call(method, path, body, { headers: { authorization: `Bearer ${token}` } }),
  }
}

/** The `payment` an admin order read carries (decision 3). */
export interface PaymentView {
  state: 'unpaid' | 'paid' | 'partially_refunded' | 'refunded'
  capturedMinor: number
  refundedMinor: number
  refundableMinor: number
  currency: string
  refunds: Array<{ id: string; amountMinor: number; status: string; currency: string }>
}

export interface AdminOrder {
  id: string
  orderNumber: string
  status: string
  totalMinor: number
  currency: string
  capturedMinor?: number
  capturedAt?: string | null
  refundedMinor?: number
  captureMethod?: string | null
  payment?: PaymentView
}

/** GET /api/admin/orders/:orderNumber: the order and its payment, as the admin reads it. */
export async function adminOrder(admin: AdminClient, orderNumber: string): Promise<AdminOrder> {
  const res = await admin.call<AdminOrder>('GET', `/api/admin/orders/${orderNumber}`)
  if (res.status !== 200) {
    throw new Error(`GET /api/admin/orders/${orderNumber}: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body.data!
}

export interface StoredMoney {
  status: string
  totalMinor: number
  capturedMinor: number
  refundedMinor: number
  captureMethod: string | null
  capturedAt: string | null
}

/** The order's amount columns as committed. */
export async function storedMoney(raw: RawReader, orderId: string): Promise<StoredMoney> {
  const row = await raw.one<{
    status: string
    total_minor: number | string
    captured_minor: number | string
    refunded_minor: number | string
    capture_method: string | null
    captured_at: string | Date | null
  }>(
    'SELECT status, total_minor, captured_minor, refunded_minor, capture_method, captured_at FROM orders WHERE id = ?',
    [orderId],
  )
  return {
    status: row.status,
    totalMinor: Number(row.total_minor),
    capturedMinor: Number(row.captured_minor),
    refundedMinor: Number(row.refunded_minor),
    captureMethod: row.capture_method,
    capturedAt:
      row.captured_at === null
        ? null
        : row.captured_at instanceof Date
          ? row.captured_at.toISOString()
          : String(row.captured_at),
  }
}

export interface StoredRefund {
  id: string
  amountMinor: number
  currency: string
  status: string
  actor: string
  providerRefundId: string | null
}

/** The order's `order_refunds` rows as committed, oldest first. */
export async function storedRefunds(raw: RawReader, orderId: string): Promise<StoredRefund[]> {
  const rows = await raw.rows<{
    id: string
    amount_minor: number | string
    currency: string
    status: string
    actor: string
    provider_refund_id: string | null
  }>(
    'SELECT id, amount_minor, currency, status, actor, provider_refund_id FROM order_refunds WHERE order_id = ? ORDER BY created_at, id',
    [orderId],
  )
  return rows.map((r) => ({
    id: r.id,
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    status: r.status,
    actor: r.actor,
    providerRefundId: r.provider_refund_id,
  }))
}

export function sumOf(refunds: StoredRefund[], status: string): number {
  return refunds.filter((r) => r.status === status).reduce((sum, r) => sum + r.amountMinor, 0)
}

/** The arguments of every call the shop made to the payments adapter's `refund`, in order. */
export type RefundCall = [
  paymentId: string,
  amountMinor: number | undefined,
  reason: string | undefined,
  opts: { idempotencyKey?: string; currency?: string } | undefined,
]
