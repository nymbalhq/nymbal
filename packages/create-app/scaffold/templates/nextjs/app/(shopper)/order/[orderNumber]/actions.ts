'use server'

import type { ShopperOrder } from '@nymbalhq/types'
import { openExpiredOrder, requestOrderLink } from '@/lib/api'
import { renderNymbal } from '@/lib/render'
import { summaryAttributes } from './OrderView'

/** What the order page shows once this server answered one of its forms. */
export type OrderPageState =
  | { kind: 'opened'; order: ShopperOrder; timelineHtml: string; summaryHtml: string }
  | { kind: 'not-found' }
  | { kind: 'link-sent' }
  | { kind: 'open-limited' }
  | { kind: 'link-limited' }

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The order page's two forms sent without the page's script, which sends both from the browser: `intent=open` reads
 * the expired key's order with the typed email, `intent=link` asks for a fresh link. The email stays in the body. An
 * opened order carries the elements' server HTML, so its summary and timeline show without a script.
 */
export async function orderPageAction(
  _previous: OrderPageState | null,
  form: FormData,
): Promise<OrderPageState> {
  if (field(form, 'intent') === 'link') {
    const answer = await requestOrderLink(field(form, 'orderNumber'), field(form, 'email'))
    return { kind: answer === 'sent' ? 'link-sent' : 'link-limited' }
  }
  const read = await openExpiredOrder(
    field(form, 'orderNumber'),
    field(form, 'key'),
    field(form, 'email'),
  )
  if (read === 'not-found') return { kind: 'not-found' }
  if (read === 'limited') return { kind: 'open-limited' }
  return {
    kind: 'opened',
    order: read,
    timelineHtml: renderNymbal('nymbal-order-timeline', {
      entries: JSON.stringify(read.timeline ?? []),
    }).__html,
    summaryHtml: renderNymbal('nymbal-order-summary', summaryAttributes(read)).__html,
  }
}
