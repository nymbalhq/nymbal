'use client'

import { useActionState, useRef, useState, type FormEvent } from 'react'
import { getNymbalClient } from '@/lib/client'
import styles from '@/styles/pages/error.module.css'
import { orderPageAction, type OrderPageState } from './actions'

type State = 'idle' | 'sending' | 'sent' | 'failed'

/** The action state a link form posts to without the page's script, and the action that answers it. */
export type LinkFormBinding = readonly [OrderPageState | null, (form: FormData) => void]

/**
 * "Send me my order link": the store emails the order's link to the order's own email, and answers the same whatever
 * matched, so the page says the same either way. One request per click: a second submit while one is out is ignored.
 * Without the script the form posts to `orderPageAction` through `binding`, the expired page's own when it is there.
 */
export function OrderLinkForm({ binding }: { binding: LinkFormBinding }) {
  const [served, formAction] = binding
  const [state, setState] = useState<State>('idle')
  const inFlight = useRef(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    setState('sending')
    const data = new FormData(event.currentTarget)
    try {
      await getNymbalClient().orders.requestLink({
        orderNumber: String(data.get('orderNumber') ?? '').trim(),
        email: String(data.get('email') ?? '').trim(),
      })
      setState('sent')
    } catch {
      setState('failed')
    } finally {
      inFlight.current = false
    }
  }

  if (state === 'sent' || served?.kind === 'link-sent') {
    return (
      <p className={styles.message} data-testid="order-link-sent">
        If that number and email match an order, its link is on its way to that email.
      </p>
    )
  }
  return (
    <form action={formAction} className={styles.searchPrompt} onSubmit={onSubmit}>
      <input type="hidden" name="intent" value="link" />
      <div className={styles.searchPromptInput}>
        <label htmlFor="order-link-number">Order number</label>
        <input id="order-link-number" name="orderNumber" required data-testid="order-link-number" />
        <label htmlFor="order-link-email">Email</label>
        <input
          id="order-link-email"
          type="email"
          name="email"
          autoComplete="email"
          required
          data-testid="order-link-email"
        />
      </div>
      {served?.kind === 'link-limited' && (
        <p className={styles.message}>Too many tries for now. Please try again in a while.</p>
      )}
      {state === 'failed' && (
        <p className={styles.message}>We could not send the link just now. Please try again.</p>
      )}
      <div className={styles.actions}>
        <button
          type="submit"
          className={styles.homeLink}
          disabled={state === 'sending'}
          data-testid="order-link-submit"
        >
          Send me my order link
        </button>
      </div>
    </form>
  )
}

/** The bare not-found page's link form, with an action state of its own. */
export function OwnOrderLinkForm() {
  const [served, formAction] = useActionState(orderPageAction, null)
  return <OrderLinkForm binding={[served, formAction]} />
}
