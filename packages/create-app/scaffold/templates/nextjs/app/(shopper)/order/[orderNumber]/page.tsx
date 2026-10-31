import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { loadOrder } from '@/lib/api'
import { OrderDetails } from './OrderDetails'
import { OrderEmailPrompt } from './OrderEmailPrompt'

interface OrderPageProps {
  params: Promise<{ orderNumber: string }>
  searchParams: Promise<{ key?: string | string[] }>
}

// The URL carries the order's key (`?key=`), so nothing this page links to or loads may be told the URL: the meta
// tag here, and the header next.config.mjs sets on every /order/<n> response, the not-found render's too.
export async function generateMetadata({ params }: OrderPageProps): Promise<Metadata> {
  const { orderNumber } = await params
  return {
    title: `Order ${orderNumber}`,
    referrer: 'no-referrer',
  }
}

export default async function OrderPage({ params, searchParams }: OrderPageProps) {
  const { orderNumber } = await params
  const { key: keyParam } = await searchParams
  const key = Array.isArray(keyParam) ? keyParam[0] : keyParam
  // Rejects when the API fails, so a failed read is a 500 and never a 404 for an order the shopper has.
  const order = await loadOrder(orderNumber, key)

  // Only the order's own key is told it has expired: the page asks for the order's email to open it.
  if (order === 'expired')
    return <OrderEmailPrompt orderNumber={orderNumber} orderKey={key ?? ''} />
  if (!order) notFound()
  return <OrderDetails order={order} {...(key !== undefined && { orderKey: key })} />
}
