import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AssistantRecord } from '@nymbalhq/types'
import { useCustomer } from '@/hooks/useCustomers'
import { useOrder } from '@/hooks/useOrders'
import { useCommandPalette } from '@/hooks/useCommandPalette'
import { ApiError } from '@/lib/api'
import { formatMoney } from '@/lib/money'
import { tid } from '@/lib/testid'

const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404

function Card({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <article
      className="space-y-1 rounded-md border border-zinc-200 bg-white p-3 text-sm [overflow-wrap:anywhere] text-zinc-700"
      data-testid={testId}
    >
      {children}
    </article>
  )
}

/** A card's state while its read is not answered, or when it failed. */
function Unread({ loading, notFound }: { loading: boolean; notFound: string }) {
  return <p className="text-xs text-zinc-500">{loading ? 'Loading…' : notFound}</p>
}

function OrderCard({ orderNumber }: { orderNumber: string }) {
  const close = useCommandPalette((s) => s.close)
  const { data: order, isLoading, error } = useOrder(orderNumber)
  const testId = tid('assistant', 'record', 'order', orderNumber)
  if (order === undefined) {
    const notFound = isNotFound(error)
      ? `Order ${orderNumber} was not found`
      : 'This record could not be loaded'
    return (
      <Card testId={testId}>
        <Unread loading={isLoading} notFound={notFound} />
      </Card>
    )
  }
  const ship = order.shippingAddress
  return (
    <Card testId={testId}>
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          to={`/orders/${encodeURIComponent(order.orderNumber)}`}
          className="font-mono text-xs font-semibold text-blue-600 hover:underline"
          onClick={close}
        >
          {order.orderNumber}
        </Link>
        <span className="text-xs text-zinc-500">{order.status}</span>
        <span className="font-mono text-xs">{formatMoney(order.totalMinor, order.currency)}</span>
      </p>
      <p className="font-medium text-zinc-900">
        {[ship.firstName, ship.lastName].filter(Boolean).join(' ')}
      </p>
      <p>{order.email}</p>
      {ship.phone && <p>{ship.phone}</p>}
      <p>
        {[ship.addressLine1, ship.addressLine2, ship.city, ship.postalCode, ship.country]
          .filter(Boolean)
          .join(', ')}
      </p>
    </Card>
  )
}

function CustomerCard({ id }: { id: string }) {
  const close = useCommandPalette((s) => s.close)
  const { data, isLoading, error } = useCustomer(id)
  const testId = tid('assistant', 'record', 'customer', id)
  if (data === undefined) {
    const notFound = isNotFound(error)
      ? 'This customer was not found'
      : 'This record could not be loaded'
    return (
      <Card testId={testId}>
        <Unread loading={isLoading} notFound={notFound} />
      </Card>
    )
  }
  const { customer, stats } = data
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || customer.email
  return (
    <Card testId={testId}>
      <Link
        to={`/customers/${encodeURIComponent(customer.id)}`}
        className="font-medium text-blue-600 hover:underline"
        onClick={close}
      >
        {name}
      </Link>
      <p>{customer.email}</p>
      {customer.phone && <p>{customer.phone}</p>}
      <p className="text-xs text-zinc-500">
        {stats.orderCount} {stats.orderCount === 1 ? 'order' : 'orders'},{' '}
        {formatMoney(stats.lifetimeRevenueMinor, 'GBP')} lifetime
      </p>
    </Card>
  )
}

/**
 * An order or a customer the assistant's turn read, filled by the admin's own session from the store's admin API:
 * the stream named only its number or id, and nothing shown here is sent to the AI provider.
 */
export function AssistantRecordCard({ record }: { record: AssistantRecord }) {
  return record.kind === 'order' ? (
    <OrderCard orderNumber={record.orderNumber} />
  ) : (
    <CustomerCard id={record.id} />
  )
}
