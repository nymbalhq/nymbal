import type { Metadata } from 'next'
import { AlertLinkForm } from '../AlertLinkForm'
import { LinkInvalid } from '../LinkInvalid'

export const metadata: Metadata = { title: 'Back-in-stock alert' }

interface UnsubscribePageProps {
  searchParams: Promise<{ token?: string | string[] }>
}

// The unsubscribe link every alert email carries: it shows the button and calls no API until the button is pressed.
export default async function UnsubscribeAlertPage({ searchParams }: UnsubscribePageProps) {
  const { token } = await searchParams
  const value = typeof token === 'string' ? token : ''
  if (value === '') return <LinkInvalid message="Check that the whole link from the email was opened." />
  return <AlertLinkForm kind="unsubscribe" token={value} />
}
