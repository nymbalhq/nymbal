'use client'

import { useActionState, useRef, useState, type FormEvent } from 'react'
import { NymbalApiError } from '@nymbalhq/sdk'
import type { ShopperOrder } from '@nymbalhq/types'
import { getNymbalClient } from '@/lib/client'
import styles from '@/styles/pages/error.module.css'
import { orderPageAction } from './actions'
import { OrderNotFound } from './OrderNotFound'
import { OrderView } from './OrderView'
import { OwnerRedirect } from './OwnerRedirect'

type State =
  | { kind: 'idle' | 'sending' | 'limited' | 'failed' | 'not-found' }
  | { kind: 'opened'; order: ShopperOrder }

/**
 * The order's key has expired: the shopper gives the order's email to open it. The browser reads the order with the
 * email in a header, so it never lands in a page URL and each shopper's tries count against their own address, not
 * the storefront server's. One request per click: a second submit while one is out is ignored. Without the script,
 * this form and the not-found state's link form post to one action state, whose answer picks what the page shows.
 */
export function OrderEmailPrompt({
  orderNumber,
  orderKey,
}: {
  orderNumber: string
  orderKey: string
}) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [served, formAction] = useActionState(orderPageAction, null)
  const inFlight = useRef(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    setState({ kind: 'sending' })
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim()
    try {
      const order = await getNymbalClient().orders.get(orderNumber, { key: orderKey, email })
      setState({ kind: 'opened', order })
    } catch (err) {
      // A 404 is the answer an unknown number gets: the email did not open the order.
      if (err instanceof NymbalApiError && err.status === 404) setState({ kind: 'not-found' })
      else if (err instanceof NymbalApiError && err.status === 429) setState({ kind: 'limited' })
      else setState({ kind: 'failed' })
    } finally {
      inFlight.current = false
    }
  }

  if (state.kind === 'opened') return <OrderView order={state.order} />
  if (served?.kind === 'opened') {
    return (
      <OrderView
        order={served.order}
        timelineHtml={served.timelineHtml}
        summaryHtml={served.summaryHtml}
      />
    )
  }
  const notFound =
    state.kind === 'not-found' ||
    served?.kind === 'not-found' ||
    served?.kind === 'link-sent' ||
    served?.kind === 'link-limited'
  if (notFound) return <OrderNotFound link={[served, formAction]} />
  return (
    <div className={styles.page}>
      <OwnerRedirect />
      <form action={formAction} onSubmit={onSubmit} className={styles.wrapper}>
        <input type="hidden" name="intent" value="open" />
        <input type="hidden" name="orderNumber" value={orderNumber} />
        <input type="hidden" name="key" value={orderKey} />
        <h1 className={styles.title}>Open your order</h1>
        <p className={styles.message}>
          This order link has expired. Enter the email you gave at checkout to open the order.
        </p>
        <div className={styles.searchPromptInput}>
          <label htmlFor="order-email">Email</label>
          <input
            id="order-email"
            type="email"
            name="email"
            autoComplete="email"
            required
            data-testid="order-email-input"
          />
        </div>
        {(state.kind === 'limited' || served?.kind === 'open-limited') && (
          <p className={styles.message} data-testid="order-email-limited">
            Too many tries for now. Please try again in a while.
          </p>
        )}
        {state.kind === 'failed' && (
          <p className={styles.message}>We could not open the order just now. Please try again.</p>
        )}
        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.homeLink}
            disabled={state.kind === 'sending'}
            data-testid="order-email-submit"
          >
            Open order
          </button>
        </div>
      </form>
    </div>
  )
}
