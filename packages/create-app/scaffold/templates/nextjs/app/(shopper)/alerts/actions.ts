'use server'

import { confirmAlert, unsubscribeAlert, type AlertConfirmation } from '@/lib/api'

/** What a press of an alert page's button shows. */
export type AlertLinkResult =
  | { result: 'confirmed'; confirmation: AlertConfirmation }
  | { result: 'unsubscribed' }
  | { result: 'invalid' }

function tokenOf(form: FormData): string {
  const token = form.get('token')
  return typeof token === 'string' ? token : ''
}

// The token is posted on from this server, so the browser needs no CSRF cookie.
export async function confirmAlertAction(
  _previous: AlertLinkResult | null,
  form: FormData,
): Promise<AlertLinkResult> {
  const token = tokenOf(form)
  const confirmation = token === '' ? null : await confirmAlert(token)
  return confirmation ? { result: 'confirmed', confirmation } : { result: 'invalid' }
}

export async function unsubscribeAlertAction(
  _previous: AlertLinkResult | null,
  form: FormData,
): Promise<AlertLinkResult> {
  const token = tokenOf(form)
  const stopped = token === '' ? false : await unsubscribeAlert(token)
  return stopped ? { result: 'unsubscribed' } : { result: 'invalid' }
}
